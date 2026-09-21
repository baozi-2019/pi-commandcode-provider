import { getConfiguredApiKey } from "./api-key.ts"
import { pickCommandCodeApiKey } from "./converters.ts"
import { fetchCommandCodeQuota, redactValue } from "./quota.ts"
import { formatQuota } from "./quota-format.ts"

/** Custom entry type for the durable TUI usage card; `index.ts` registers its renderer. */
export const QUOTA_ENTRY_TYPE = "commandcode-usage"

export interface QuotaCommandContext {
  mode: "tui" | "rpc" | "json" | "print"
  hasUI: boolean
  modelRegistry?: {
    getApiKeyForProvider?: (provider: string) => Promise<string | undefined>
  }
  ui: {
    notify(message: string, type?: "info" | "warning" | "error"): void
  }
}

interface QuotaCommandApi {
  registerCommand(
    name: string,
    options: {
      description: string
      handler: (args: string, ctx: QuotaCommandContext) => Promise<void>
    },
  ): void
  appendEntry<T = unknown>(customType: string, data?: T): void
}

interface RegisterQuotaCommandOptions {
  apiBase: string
  headers?: Record<string, string>
  getConfiguredKey?: () => string | undefined
  fetchQuota?: typeof fetchCommandCodeQuota
}

export function registerCommandCodeQuota(
  pi: QuotaCommandApi,
  options: RegisterQuotaCommandOptions,
): void {
  const getConfiguredKey = options.getConfiguredKey ?? getConfiguredApiKey
  const fetchQuota = options.fetchQuota ?? fetchCommandCodeQuota

  pi.registerCommand("commandcode-usage", {
    description: "Show Command Code account usage and quota",
    // pi executes extension commands immediately, even while the agent is streaming;
    // this handler only reads quota and emits output, so it returns without waiting.
    handler: async (_args, ctx) => {
      const emit = (text: string, kind: "info" | "warning" | "error"): void => {
        if (ctx.mode === "tui" && ctx.hasUI && kind === "info") {
          // Durable transcript card; custom entries never enter LLM context
          // and are safe to append while the agent is running.
          pi.appendEntry(QUOTA_ENTRY_TYPE, { content: text })
        } else if (ctx.hasUI) {
          // Fire-and-forget: also safe while the agent is still running.
          ctx.ui.notify(text, kind)
        } else if (kind === "error" || ctx.mode !== "print") {
          // JSON mode: stdout is the machine-readable event stream, so even
          // info output must go to stderr.
          // pi-lens-ignore: no-console-except-error
          console.error(text)
        } else {
          // pi-lens-ignore: no-console-except-error
          console.log(text)
        }
      }

      const registryKey = await ctx.modelRegistry?.getApiKeyForProvider?.("commandcode")
      const apiKey = pickCommandCodeApiKey(registryKey, getConfiguredKey())
      if (!apiKey) {
        emit(
          "Command Code quota requires an API key. Run /login and select Command Code, or set COMMAND_CODE_API_KEY.",
          "warning",
        )
        return
      }

      const result = await fetchQuota({
        apiKey,
        baseUrl: options.apiBase,
        extraHeaders: options.headers,
      })
      if (!result.ok) {
        emit(redactValue(result.error.message), "error")
        return
      }
      emit(formatQuota(result.quota), "info")
    },
  })
}
