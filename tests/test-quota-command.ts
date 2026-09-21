import assert from "node:assert/strict"
import { describe, it } from "node:test"

import {
  QUOTA_ENTRY_TYPE,
  registerCommandCodeQuota,
  type QuotaCommandContext,
} from "../src/quota-command.ts"
import type { CommandCodeQuotaResult } from "../src/quota-types.ts"

class CommandApiDouble {
  handler?: (args: string, ctx: QuotaCommandContext) => Promise<void>
  entries: Array<{ customType: string; data?: unknown }> = []

  registerCommand(
    name: string,
    options: {
      description: string
      handler: (args: string, ctx: QuotaCommandContext) => Promise<void>
    },
  ): void {
    assert.equal(name, "commandcode-usage")
    assert.match(options.description, /usage and quota/)
    this.handler = options.handler
  }

  appendEntry<T = unknown>(customType: string, data?: T): void {
    this.entries.push({ customType, data })
  }
}

function context(
  registryKey: string | undefined,
  mode: QuotaCommandContext["mode"] = "tui",
  hasUI = true,
) {
  const notifications: Array<{ message: string; type?: "info" | "warning" | "error" }> = []
  const value = {
    mode,
    hasUI,
    modelRegistry: {
      async getApiKeyForProvider(provider: string) {
        assert.equal(provider, "commandcode")
        return registryKey
      },
    },
    ui: {
      notify(message: string, type?: "info" | "warning" | "error") {
        notifications.push({ message, type })
      },
    },
  } satisfies QuotaCommandContext
  return { value, notifications }
}

/** Capture console.log/console.error output for the duration of `run`. */
async function captureConsole(
  run: () => Promise<void>,
): Promise<{ stdout: string[]; stderr: string[] }> {
  const stdout: string[] = []
  const stderr: string[] = []
  const originalLog = console.log
  const originalError = console.error
  console.log = (...args: unknown[]) => stdout.push(args.map(String).join(" "))
  console.error = (...args: unknown[]) => stderr.push(args.map(String).join(" "))
  try {
    await run()
  } finally {
    console.log = originalLog
    console.error = originalError
  }
  return { stdout, stderr }
}

const quotaResult: CommandCodeQuotaResult = {
  ok: true,
  quota: {
    account: { login: "alice", orgId: null },
    credits: null,
    subscription: null,
    summary: { totalCost: 1, totalCount: 2 },
  },
}

function registerWith(
  overrides: Partial<Parameters<typeof registerCommandCodeQuota>[1]> = {},
): CommandApiDouble {
  const pi = new CommandApiDouble()
  registerCommandCodeQuota(pi, {
    apiBase: "https://api.commandcode.ai",
    getConfiguredKey: () => "fallback-key",
    fetchQuota: async () => quotaResult,
    ...overrides,
  })
  assert.ok(pi.handler)
  return pi
}

describe("commandcode-usage command", () => {
  it("appends a durable transcript card in TUI mode, without waiting for idle", async () => {
    let requestKey = ""
    let requestBase = ""
    const pi = registerWith({
      fetchQuota: async (options) => {
        requestKey = options.apiKey
        requestBase = options.baseUrl ?? ""
        return quotaResult
      },
    })

    const ctx = context("$COMMAND_CODE_API_KEY")
    await pi.handler!("", ctx.value)
    assert.equal(requestKey, "fallback-key")
    assert.equal(requestBase, "https://api.commandcode.ai")
    assert.equal(ctx.notifications.length, 0)
    assert.equal(pi.entries.length, 1)
    assert.equal(pi.entries[0].customType, QUOTA_ENTRY_TYPE)
    const content = (pi.entries[0].data as { content?: unknown }).content
    assert.match(String(content), /Monthly \$1\.00 used/)
  })

  it("notifies instead of appending an entry in RPC mode", async () => {
    const pi = registerWith()
    const ctx = context("real-key", "rpc")
    await pi.handler!("", ctx.value)
    assert.equal(pi.entries.length, 0)
    assert.equal(ctx.notifications.length, 1)
    assert.equal(ctx.notifications[0].type, "info")
    assert.match(ctx.notifications[0].message, /Monthly \$1\.00 used/)
  })

  it("prints info to stdout in print mode and to stderr in json mode", async () => {
    const piPrint = registerWith()
    const printOutput = await captureConsole(() =>
      piPrint.handler!("", context("real-key", "print", false).value),
    )
    assert.equal(piPrint.entries.length, 0)
    assert.equal(printOutput.stdout.length, 1)
    assert.match(printOutput.stdout[0], /Monthly \$1\.00 used/)
    assert.equal(printOutput.stderr.length, 0)

    const piJson = registerWith()
    const jsonOutput = await captureConsole(() =>
      piJson.handler!("", context("real-key", "json", false).value),
    )
    assert.equal(jsonOutput.stdout.length, 0)
    assert.equal(jsonOutput.stderr.length, 1)
    assert.match(jsonOutput.stderr[0], /Monthly \$1\.00 used/)
  })

  it("warns without calling the endpoint when no API key is available", async () => {
    let called = false
    const pi = registerWith({
      getConfiguredKey: () => undefined,
      fetchQuota: async () => {
        called = true
        return quotaResult
      },
    })

    const ctx = context(undefined)
    await pi.handler!("", ctx.value)
    assert.equal(called, false)
    assert.equal(pi.entries.length, 0)
    assert.equal(ctx.notifications.at(-1)?.type, "warning")
    assert.match(ctx.notifications.at(-1)?.message ?? "", /requires an API key/)
  })

  it("redacts endpoint failures before notifying the host", async () => {
    const pi = registerWith({
      getConfiguredKey: () => "real-key",
      fetchQuota: async () => ({
        ok: false,
        error: { kind: "http", message: "api_key=supersecretvalue123456 failed" },
      }),
    })

    const ctx = context("real-key")
    await pi.handler!("", ctx.value)
    assert.equal(pi.entries.length, 0)
    assert.equal(ctx.notifications.at(-1)?.type, "error")
    assert.doesNotMatch(ctx.notifications.at(-1)?.message ?? "", /supersecret/)
  })

  it("routes errors to stderr in print mode", async () => {
    const pi = registerWith({
      fetchQuota: async () => ({
        ok: false,
        error: { kind: "http", message: "api_key=supersecretvalue123456 failed" },
      }),
    })

    const output = await captureConsole(() =>
      pi.handler!("", context("real-key", "print", false).value),
    )
    assert.equal(output.stdout.length, 0)
    assert.equal(output.stderr.length, 1)
    assert.doesNotMatch(output.stderr[0], /supersecret/)
  })
})
