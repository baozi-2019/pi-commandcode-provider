import { getConfiguredApiKey } from "./api-key.ts"
import { pickCommandCodeApiKey } from "./converters.ts"
import { fetchCommandCodeQuota, redactValue } from "./quota.ts"
import { formatQuota } from "./quota-format.ts"

/**
 * pi renders `info` notifications with the theme's dim foreground, which made the
 * quota table hard to read. pi-tui's ANSI parser maps SGR 39 to "default
 * foreground", so prefixing this reset renders the table at the terminal's
 * normal text brightness in both dark and light themes.
 */
const DEFAULT_FOREGROUND = "\u001b[39m"

export interface QuotaCommandContext {
  waitForIdle?: () => Promise<void>
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
    handler: async (_args, ctx) => {
      await ctx.waitForIdle?.()
      const registryKey = await ctx.modelRegistry?.getApiKeyForProvider?.("commandcode")
      const apiKey = pickCommandCodeApiKey(registryKey, getConfiguredKey())
      if (!apiKey) {
        ctx.ui.notify(
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
        ctx.ui.notify(redactValue(result.error.message), "error")
        return
      }
      ctx.ui.notify(`${DEFAULT_FOREGROUND}${formatQuota(result.quota)}`, "info")
    },
  })
}
