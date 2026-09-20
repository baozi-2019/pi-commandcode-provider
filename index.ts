/**
 * Command Code provider for pi.
 *
 * Uses Command Code's documented Provider API:
 * https://api.commandcode.ai/provider/v1
 */

import { AssistantMessageEventStream } from "@earendil-works/pi-ai"
import * as piAiCompat from "@earendil-works/pi-ai/compat"
import { streamSimple as streamNativeProvider } from "@earendil-works/pi-ai/compat"
import {
  getAgentDir,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ProviderConfig,
} from "@earendil-works/pi-coding-agent"
import { join } from "node:path"

import { getConfiguredApiKey } from "./src/api-key.ts"
import { pickCommandCodeApiKey, withResolvedCommandCodeApiKey } from "./src/converters.ts"
import { createStreamCommandCode } from "./src/core.ts"
import { calculateCommandCodeCost } from "./src/cost.ts"
import {
  apiForModelId,
  baseUrlForModel,
  DEFAULT_MODELS_URL,
  DEFAULT_PROVIDER_API_BASE,
  getModelsTimeoutMs,
  inputModalitiesForModel,
  loadCachedCommandCodeModels,
  loadCommandCodeModels,
  MODEL_EFFORTS,
  thinkingMetadataForModel,
  type CommandCodeModel,
} from "./src/models.ts"
import { getApiKey as getOAuthApiKey, login, refreshToken } from "./src/oauth.ts"
import { normalizeCommandCodeMessage } from "./src/overflow.ts"
import { assertCommandCodeModelAllowed, filterCommandCodeModels } from "./src/plan-policy.ts"
import {
  formatPlanResolution,
  resolveCommandCodePlan,
  saveManualCommandCodePlan,
} from "./src/plan-resolver.ts"
import { isSubscriptionPlan, type PlanResolution, type SubscriptionPlan } from "./src/plan-types.ts"
import { MODEL_COSTS, ZERO_MODEL_COST } from "./src/pricing.ts"
import { registerCommandCodeQuota } from "./src/quota-command.ts"
import { createCommandCodeRuntime } from "./src/runtime.ts"
import { createCommandCodeTransportRouter } from "./src/transport.ts"

const COMMAND_CODE_API = "commandcode-custom"
const COMPAT_SOURCE_ID = "pi-commandcode-provider"

type CompatStreamFunction = (
  model: Parameters<typeof streamNativeProvider>[0],
  context: Parameters<typeof streamNativeProvider>[1],
  options?: Parameters<typeof streamNativeProvider>[2],
) => AssistantMessageEventStream

/**
 * pi's compat entrypoint exposes `registerApiProvider`; Oh My Pi maps
 * `@earendil-works/pi-ai/compat` onto its own pi-ai, which lacks that export
 * and registers custom APIs itself inside `registerProvider`. Resolve the
 * function at runtime so the extension loads on both hosts.
 */
function compatApiProviderRegistrar(): ((...args: unknown[]) => unknown) | undefined {
  const register = (piAiCompat as { registerApiProvider?: unknown }).registerApiProvider
  return typeof register === "function" ? (register as (...args: unknown[]) => unknown) : undefined
}

function registerCompatApiProvider(stream: CompatStreamFunction): void {
  compatApiProviderRegistrar()?.(
    { api: COMMAND_CODE_API, stream, streamSimple: stream },
    COMPAT_SOURCE_ID,
  )
}

/**
 * The `apiKey` handed to `registerProvider` means different things per host.
 *
 * pi parses `$COMMAND_CODE_API_KEY` as an env template: unresolved means
 * "not configured", so `/login` credentials and `--api-key` take over, and
 * the entry keeps the API-key auth method registered next to OAuth. Without
 * it pi composes an OAuth-only provider and drops stored `api_key`
 * credentials and `--api-key`.
 *
 * Oh My Pi has no template notion: an unresolved value stays a literal config
 * override that shadows its `/login` credential store and is sent verbatim as
 * `Authorization: Bearer $COMMAND_CODE_API_KEY`. There, omit `apiKey` unless
 * a real key is configured; OMP then reads env keys and stored credentials
 * itself.
 *
 * Hosts are told apart by the same `registerApiProvider` probe used for the
 * compat registry: pi exports it, OMP does not.
 */
function providerApiKey(): string | undefined {
  const configured = pickCommandCodeApiKey(getConfiguredApiKey(), undefined)
  if (configured) return configured
  return compatApiProviderRegistrar() ? "$COMMAND_CODE_API_KEY" : undefined
}

function commandCodeHeaders(): Record<string, string> | undefined {
  if (process.env.CMD_ZDR === "1" || process.env.COMMANDCODE_ZDR === "1") {
    return { "x-cmd-zdr": "1" }
  }
  return undefined
}

/** Host compat overrides per upstream api family; forwarded to `streamSimple` opaquely. */
function compatForModel(model: CommandCodeModel): Record<string, unknown> {
  if (model.api === "openai-completions") {
    return {
      supportsStore: false,
      supportsDeveloperRole: false,
      supportsReasoningEffort: MODEL_EFFORTS[model.id] !== undefined,
      maxTokensField: "max_tokens",
    }
  }
  const compat: {
    supportsEagerToolInputStreaming: boolean
    supportsLongCacheRetention: boolean
    supportsCacheControlOnTools: boolean
    supportsToolReferences: boolean
    forceAdaptiveThinking?: boolean
  } = {
    supportsEagerToolInputStreaming: false,
    supportsLongCacheRetention: false,
    supportsCacheControlOnTools: false,
    supportsToolReferences: false,
  }
  if (model.reasoning) compat.forceAdaptiveThinking = true
  return compat
}

function createProviderConfig(
  models: readonly CommandCodeModel[],
  apiBase: string,
  streamCommandCode: ProviderConfig["streamSimple"],
  loginFlow: typeof login,
): ProviderConfig {
  const headers = commandCodeHeaders()
  return {
    name: "Command Code",
    baseUrl: apiBase,
    apiKey: providerApiKey(),
    api: COMMAND_CODE_API,
    streamSimple: streamCommandCode,
    headers,
    oauth: {
      name: "Command Code",
      login: loginFlow,
      refreshToken,
      getApiKey: getOAuthApiKey,
    },
    models: models.map((model) => ({
      id: model.id,
      name: model.name,
      api: COMMAND_CODE_API,
      baseUrl: baseUrlForModel(apiBase, model.api),
      reasoning: model.reasoning,
      ...(thinkingMetadataForModel(model.id) ?? {}),
      input: [...inputModalitiesForModel(model.id)],
      cost: MODEL_COSTS[model.id] ?? ZERO_MODEL_COST,
      contextWindow: model.contextWindow,
      maxTokens: model.maxTokens,
      headers,
      compat: compatForModel(model),
    })),
  }
}

function legacyApiBase(providerApiBase: string): string {
  return providerApiBase.replace(/\/provider\/v1\/?$/, "")
}

export default async function (pi: ExtensionAPI) {
  const apiBase = process.env.COMMANDCODE_API_BASE ?? DEFAULT_PROVIDER_API_BASE
  const modelsUrl = process.env.COMMANDCODE_MODELS_URL ?? DEFAULT_MODELS_URL
  const modelsTimeoutMs = getModelsTimeoutMs()
  const modelsCachePath =
    process.env.COMMANDCODE_MODELS_CACHE ?? join(getAgentDir(), "commandcode-models.json")
  const planCachePath =
    process.env.COMMANDCODE_PLAN_CACHE ?? join(getAgentDir(), "commandcode-plans.json")
  const planApiBase = legacyApiBase(apiBase)
  let planResolution: PlanResolution = {
    plan: "unknown",
    filterPlan: "go",
    mode: "auto",
    source: "fallback",
  }
  let planWarning: string | undefined

  const refreshPlan = async (apiKey = getConfiguredApiKey(), force = false): Promise<void> => {
    const result = await resolveCommandCodePlan({
      apiKey,
      cachePath: planCachePath,
      baseUrl: planApiBase,
      force,
    })
    planResolution = result.resolution
    planWarning = result.warning
  }

  let refreshModelCatalog: (() => Promise<unknown>) | undefined
  const loginWithPlan: typeof login = async (callbacks) => {
    const credentials = await login(callbacks)
    await refreshPlan(credentials.access, true)
    await refreshModelCatalog?.()
    return credentials
  }

  await refreshPlan()

  // Hosts may select their built-in Command Code model before loading extensions.
  // Rebind that stale selection to our registered transport before the first turn.
  pi.on("session_start", async (_event, ctx) => {
    if (ctx.model?.provider !== "commandcode") return
    const registered = ctx.modelRegistry.find("commandcode", ctx.model.id)
    if (registered?.api === COMMAND_CODE_API && ctx.model.api !== COMMAND_CODE_API) {
      await pi.setModel(registered)
    }
  })
  const streamGenerate = createStreamCommandCode({
    createStream: () => new AssistantMessageEventStream(),
    calculateCost: calculateCommandCodeCost,
    apiBase: legacyApiBase(apiBase),
  })
  const resolveStreamOptions = (options?: Parameters<typeof streamNativeProvider>[2]) =>
    withResolvedCommandCodeApiKey(options, getConfiguredApiKey())
  const transport = createCommandCodeTransportRouter({
    createStream: () => new AssistantMessageEventStream(),
    streamProvider: (model, context, options) => {
      assertCommandCodeModelAllowed(model.id, planResolution.plan)
      return streamNativeProvider(
        { ...model, api: apiForModelId(model.id), compat: model.compatConfig ?? model.compat },
        context,
        resolveStreamOptions(options),
      )
    },
    streamGenerate: (model, context, options) => {
      assertCommandCodeModelAllowed(model.id, planResolution.plan)
      return streamGenerate(model, context, resolveStreamOptions(options))
    },
  })

  // pi dispatches the main chat through the registered provider, but sibling
  // extensions that call `streamSimple` from `@earendil-works/pi-ai/compat`
  // with a Command Code model resolve `model.api` through the compat
  // api-registry, which knows nothing about extension providers. Register the
  // custom api there so those calls reach the same transport. The registry
  // resolves no credentials for extension providers, so fall back to the
  // configured key when the caller passes none or a placeholder.
  const compatStream: CompatStreamFunction = (model, context, options) =>
    transport.stream(model, context, resolveStreamOptions(options)) as AssistantMessageEventStream
  registerCompatApiProvider(compatStream)

  pi.on("message_end", async (event, ctx) => {
    if (event.message.role !== "assistant") return
    const normalized = normalizeCommandCodeMessage(event.message, ctx.model?.provider)
    return normalized ? { message: normalized.message } : undefined
  })

  registerCommandCodeQuota(pi, {
    apiBase: planApiBase,
    headers: commandCodeHeaders(),
  })

  const runtime = createCommandCodeRuntime<ProviderConfig, ExtensionCommandContext>(pi, {
    endpoint: modelsUrl,
    cachePath: modelsCachePath,
    loadModels: (signal) =>
      loadCommandCodeModels({
        url: modelsUrl,
        cachePath: modelsCachePath,
        timeoutMs: modelsTimeoutMs,
        signal,
      }),
    loadCachedModels: () => loadCachedCommandCodeModels(modelsCachePath),
    prepareModels: (models) => {
      const filtered = filterCommandCodeModels(models, planResolution.plan)
      const unknownWarning =
        filtered.unknownModelIds.length > 0
          ? `${filtered.unknownModelIds.length} model(s) hidden because their minimum plan is unknown`
          : undefined
      return {
        models: filtered.models,
        warning: [planWarning, unknownWarning].filter(Boolean).join(" ") || undefined,
      }
    },
    createProviderConfig: (models) =>
      createProviderConfig(models, apiBase, transport.stream, loginWithPlan),
    getTransport: transport.getTransport,
    getPlanStatus: () => formatPlanResolution(planResolution),
    beforeRefresh: async () => {
      if (planResolution.mode === "auto") await refreshPlan(undefined, true)
    },
  })

  refreshModelCatalog = () => runtime.refresh()

  pi.registerCommand("commandcode-plan", {
    description: "Show or change the Command Code plan used for model filtering",
    handler: async (args, ctx) => {
      await ctx.waitForIdle?.()
      const value = args.trim().toLowerCase()
      if (!value) {
        ctx.ui.notify(formatPlanResolution(planResolution), planWarning ? "warning" : "info")
        return
      }

      if (value === "auto") {
        await refreshPlan(undefined, true)
      } else if (isSubscriptionPlan(value)) {
        const apiKey = getConfiguredApiKey()
        planResolution = await saveManualCommandCodePlan(
          planCachePath,
          value as SubscriptionPlan,
          apiKey,
        )
        planWarning = undefined
      } else {
        ctx.ui.notify("Usage: /commandcode-plan [auto|go|goat|pro|max]", "warning")
        return
      }

      await runtime.refresh()
      ctx.ui.notify(formatPlanResolution(planResolution), planWarning ? "warning" : "info")
    },
  })

  pi.on("session_shutdown", () => {
    runtime.dispose()
  })

  await runtime.initialize()
}
