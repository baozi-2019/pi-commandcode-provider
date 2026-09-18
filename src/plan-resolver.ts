import { loadPlanProfiles, savePlanProfile } from "./plan-store.ts"
import {
  configuredPlan,
  filterPlanFor,
  keyFingerprint,
  normalizePlanId,
  type EffectivePlan,
  type PlanMode,
  type PlanResolution,
  type PlanSource,
  type SubscriptionPlan,
} from "./plan-types.ts"

export const DEFAULT_PLAN_API_BASE = "https://api.commandcode.ai"
export const DEFAULT_PLAN_TIMEOUT_MS = 10_000

type JsonValue =
  null | boolean | number | string | readonly JsonValue[] | { readonly [key: string]: JsonValue }

export interface ResolvePlanOptions {
  apiKey?: string
  cachePath: string
  env?: NodeJS.ProcessEnv
  baseUrl?: string
  fetchImpl?: typeof fetch
  timeoutMs?: number
  signal?: AbortSignal
  allowNetwork?: boolean
  force?: boolean
}

export interface ResolvePlanResult {
  resolution: PlanResolution
  warning?: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function safeErrorMessage(error: unknown): string {
  return errorMessage(error)
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/(?:api[-_ ]?key|token|secret|password)\s*[=:]\s*\S+/gi, "$1=[redacted]")
}

function timeoutMsFrom(value: number | undefined): number {
  return value !== undefined && Number.isFinite(value) && value > 0
    ? value
    : DEFAULT_PLAN_TIMEOUT_MS
}

function abortError(reason: unknown): Error {
  if (reason instanceof Error) return reason
  return new DOMException("The operation was aborted", "AbortError")
}

async function fetchJson(
  url: string,
  apiKey: string,
  options: ResolvePlanOptions,
): Promise<JsonValue> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMsFrom(options.timeoutMs))
  const onAbort = () => controller.abort(options.signal?.reason)
  options.signal?.addEventListener("abort", onAbort, { once: true })

  try {
    if (options.signal?.aborted) throw abortError(options.signal.reason)
    const response = await (options.fetchImpl ?? fetch)(url, {
      headers: {
        accept: "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      signal: controller.signal,
    })
    if (!response.ok) {
      throw new Error(`Command Code plan request failed (${response.status})`)
    }
    const body: unknown = await response.json()
    return body as JsonValue
  } catch (error) {
    if (options.signal?.aborted) throw abortError(options.signal.reason)
    if (controller.signal.aborted) {
      throw new Error(
        `Command Code plan request timed out after ${timeoutMsFrom(options.timeoutMs)}ms`,
      )
    }
    throw new Error(safeErrorMessage(error))
  } finally {
    clearTimeout(timeout)
    options.signal?.removeEventListener("abort", onAbort)
  }
}

function orgIdFromWhoami(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined
  const org = isRecord(value.org) ? value.org : undefined
  return org ? nonEmptyString(org.id) : undefined
}

function planIdFromSubscription(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined
  const direct = nonEmptyString(value.planId)
  if (direct) return direct
  const data = value.data
  if (isRecord(data)) return nonEmptyString(data.planId)
  if (Array.isArray(data)) {
    const active = data.find((entry) => isRecord(entry) && nonEmptyString(entry.planId))
    return isRecord(active) ? nonEmptyString(active.planId) : undefined
  }
  return undefined
}

function resolutionFromPlan(
  plan: EffectivePlan,
  mode: PlanMode,
  source: PlanSource,
  apiKey?: string,
  extras: Pick<PlanResolution, "warning" | "stale" | "detectedAt"> = {},
): PlanResolution {
  return {
    plan,
    filterPlan: filterPlanFor(plan),
    mode,
    source,
    ...(apiKey ? { keyFingerprint: keyFingerprint(apiKey) } : {}),
    ...extras,
  }
}

function manualResolution(
  plan: SubscriptionPlan,
  source: PlanSource,
  apiKey?: string,
): PlanResolution {
  return resolutionFromPlan(plan, "manual", source, apiKey, {
    detectedAt: new Date().toISOString(),
  })
}

export async function resolveCommandCodePlan(
  options: ResolvePlanOptions,
): Promise<ResolvePlanResult> {
  const env = options.env ?? process.env
  const configured = configuredPlan(env)
  const fingerprint = options.apiKey ? keyFingerprint(options.apiKey) : undefined

  if (configured && configured !== "auto") {
    const resolution = manualResolution(configured, "environment", options.apiKey)
    if (fingerprint) {
      await savePlanProfile(options.cachePath, {
        version: 1,
        keyFingerprint: fingerprint,
        mode: "manual",
        selectedPlan: configured,
        detectedPlan: configured,
        detectedAt: resolution.detectedAt,
      })
    }
    return { resolution }
  }

  if (!options.apiKey) {
    return {
      resolution: resolutionFromPlan("unknown", "auto", "fallback"),
      warning: "No Command Code API key is available for automatic plan detection",
    }
  }

  const profiles = await loadPlanProfiles(options.cachePath)
  const cached = fingerprint ? profiles[fingerprint] : undefined
  if (!options.force && cached?.mode === "manual" && cached.selectedPlan) {
    return {
      resolution: manualResolution(cached.selectedPlan, "cache", options.apiKey),
    }
  }

  if (options.allowNetwork === false) {
    if (cached?.detectedPlan && cached.detectedPlan !== "unknown") {
      return {
        resolution: resolutionFromPlan(cached.detectedPlan, cached.mode, "cache", options.apiKey, {
          detectedAt: cached.detectedAt,
          stale: true,
        }),
      }
    }
    return {
      resolution: resolutionFromPlan("unknown", "auto", "fallback", options.apiKey),
      warning: "No cached Command Code plan is available for automatic detection",
    }
  }

  try {
    const baseUrl = (options.baseUrl ?? DEFAULT_PLAN_API_BASE).replace(/\/+$/g, "")
    const whoami = await fetchJson(`${baseUrl}/alpha/whoami`, options.apiKey, options)
    const orgId = orgIdFromWhoami(whoami)
    const url = new URL(`${baseUrl}/alpha/billing/subscriptions`)
    if (orgId) url.searchParams.set("orgId", orgId)
    const subscription = await fetchJson(url.toString(), options.apiKey, options)
    const plan = normalizePlanId(planIdFromSubscription(subscription))
    const detectedAt = new Date().toISOString()
    const resolution = resolutionFromPlan(plan, "auto", "subscription", options.apiKey, {
      detectedAt,
      ...(plan === "unknown"
        ? { warning: "Command Code returned an unknown plan identifier" }
        : {}),
    })
    await savePlanProfile(options.cachePath, {
      version: 1,
      keyFingerprint: keyFingerprint(options.apiKey),
      mode: "auto",
      detectedPlan: plan,
      detectedAt,
    })
    return {
      resolution,
      ...(plan === "unknown" ? { warning: resolution.warning } : {}),
    }
  } catch (error) {
    if (cached?.detectedPlan && cached.detectedPlan !== "unknown") {
      const resolution = resolutionFromPlan(
        cached.detectedPlan,
        cached.mode,
        "cache",
        options.apiKey,
        { detectedAt: cached.detectedAt, stale: true },
      )
      return {
        resolution,
        warning: `Automatic Command Code plan detection failed; using the cached plan (${safeErrorMessage(error)})`,
      }
    }

    return {
      resolution: resolutionFromPlan("unknown", "auto", "fallback", options.apiKey),
      warning: `Automatic Command Code plan detection failed (${safeErrorMessage(error)}); only Go models will be exposed`,
    }
  }
}

export async function saveManualCommandCodePlan(
  cachePath: string,
  plan: SubscriptionPlan,
  apiKey?: string,
): Promise<PlanResolution> {
  const resolution = manualResolution(plan, "manual", apiKey)
  if (apiKey) {
    await savePlanProfile(cachePath, {
      version: 1,
      keyFingerprint: keyFingerprint(apiKey),
      mode: "manual",
      selectedPlan: plan,
      detectedPlan: plan,
      detectedAt: resolution.detectedAt,
    })
  }
  return resolution
}

export function formatPlanResolution(resolution: PlanResolution): string {
  return [
    `plan: ${resolution.plan}`,
    `plan mode: ${resolution.mode}`,
    `plan source: ${resolution.source}${resolution.stale ? " (stale)" : ""}`,
    `plan detected: ${resolution.detectedAt ?? "never"}`,
    `plan key: ${resolution.keyFingerprint ? "configured" : "not configured"}`,
    `plan warning: ${resolution.warning ?? "none"}`,
  ].join("\n")
}
