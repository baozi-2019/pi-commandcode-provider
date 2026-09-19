/**
 * Unit tests for src/plan-resolver.ts and src/plan-store.ts: automatic plan
 * detection against a mocked Command Code account API, manual overrides,
 * per-key-fingerprint cache isolation, and secret hygiene.
 */

import assert from "node:assert/strict"
import { readFileSync, statSync } from "node:fs"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, it } from "node:test"

import { loadPlanProfiles, savePlanProfile } from "../src/plan-store.ts"
import {
  formatPlanResolution,
  resolveCommandCodePlan,
  saveManualCommandCodePlan,
} from "../src/plan-resolver.ts"
import { keyFingerprint } from "../src/plan-types.ts"

const MOCK_KEY = "user_mock-plan-detection-key-1234567890"

const WHOAMI_BODY = { user: { userName: "alice" }, org: { id: "org_1", login: "alice-inc" } }
const GOAT_SUBSCRIPTION_BODY = { data: { planId: "goat", status: "active" } }

async function withCacheDir(run: (paths: { cachePath: string }) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "pi-commandcode-plans-"))
  try {
    await run({ cachePath: join(directory, "plans.json") })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  })
}

/** Routes /alpha/whoami and /alpha/billing/subscriptions by URL. */
function accountFetch(
  subscriptionBody: unknown = GOAT_SUBSCRIPTION_BODY,
  onRequest?: (url: string) => void,
): typeof fetch {
  return ((input: RequestInfo | URL) => {
    const url = String(input)
    onRequest?.(url)
    if (url.endsWith("/alpha/whoami")) return Promise.resolve(jsonResponse(WHOAMI_BODY))
    if (url.includes("/alpha/billing/subscriptions")) {
      return Promise.resolve(jsonResponse(subscriptionBody))
    }
    return Promise.resolve(new Response("not found", { status: 404 }))
  }) as typeof fetch
}

function offlineFetch(): typeof fetch {
  return (() => Promise.reject(new TypeError("fetch failed"))) as typeof fetch
}

function failingFetch(): typeof fetch {
  return (() => Promise.resolve(new Response("rejected", { status: 401 }))) as typeof fetch
}

describe("resolveCommandCodePlan() with a mocked account API", () => {
  it("detects the plan from billing/subscriptions, passes orgId, and caches the fingerprint", async () => {
    await withCacheDir(async ({ cachePath }) => {
      const requested: string[] = []
      const result = await resolveCommandCodePlan({
        apiKey: MOCK_KEY,
        cachePath,
        baseUrl: "https://api.commandcode.test",
        fetchImpl: accountFetch(GOAT_SUBSCRIPTION_BODY, (url) => requested.push(url)),
      })

      assert.equal(result.resolution.plan, "goat")
      assert.equal(result.resolution.filterPlan, "goat")
      assert.equal(result.resolution.mode, "auto")
      assert.equal(result.resolution.source, "subscription")
      assert.equal(result.resolution.keyFingerprint, keyFingerprint(MOCK_KEY))
      assert.equal(result.resolution.stale, undefined)
      assert.equal(result.warning, undefined)

      assert.equal(requested.length, 2)
      assert.ok(requested[0]!.endsWith("/alpha/whoami"))
      assert.match(requested[1]!, /\/alpha\/billing\/subscriptions\?.*orgId=org_1/)

      // The cache stores the fingerprint only — never the API key.
      const raw = readFileSync(cachePath, "utf-8")
      assert.equal(result.warning, undefined)
      assert.doesNotMatch(raw, new RegExp(MOCK_KEY))
      assert.match(raw, new RegExp(keyFingerprint(MOCK_KEY)))
      assert.equal((statSync(cachePath).mode & 0o777).toString(8), "600")

      const profiles = await loadPlanProfiles(cachePath)
      assert.equal(profiles[keyFingerprint(MOCK_KEY)]?.detectedPlan, "goat")
    })
  })

  it("normalizes the planId returned by the account API", async () => {
    await withCacheDir(async ({ cachePath }) => {
      const result = await resolveCommandCodePlan({
        apiKey: MOCK_KEY,
        cachePath,
        fetchImpl: accountFetch({ data: { planId: "team_pro", status: "active" } }),
      })
      assert.equal(result.resolution.plan, "pro")
    })
  })

  it("resolves the real prefixed billing planId (individual-goat)", async () => {
    await withCacheDir(async ({ cachePath }) => {
      // Shape observed from the live API: data.planId is "individual-goat".
      const result = await resolveCommandCodePlan({
        apiKey: MOCK_KEY,
        cachePath,
        fetchImpl: accountFetch({ data: { planId: "individual-goat", status: "active" } }),
      })
      assert.equal(result.resolution.plan, "goat")
      assert.equal(result.resolution.filterPlan, "goat")
      assert.equal(result.warning, undefined)
    })
  })

  it("lets COMMANDCODE_PLAN override detection without touching the network", async () => {
    await withCacheDir(async ({ cachePath }) => {
      let requests = 0
      const result = await resolveCommandCodePlan({
        apiKey: MOCK_KEY,
        cachePath,
        env: { COMMANDCODE_PLAN: "pro" },
        fetchImpl: accountFetch(undefined, () => {
          requests += 1
        }),
      })

      assert.equal(result.resolution.plan, "pro")
      assert.equal(result.resolution.mode, "manual")
      assert.equal(result.resolution.source, "environment")
      assert.equal(requests, 0)

      const raw = readFileSync(cachePath, "utf-8")
      assert.doesNotMatch(raw, new RegExp(MOCK_KEY))
    })
  })

  it("serves the manual cache on a non-force resolve without network access", async () => {
    await withCacheDir(async ({ cachePath }) => {
      await saveManualCommandCodePlan(cachePath, "max", MOCK_KEY)

      let requests = 0
      const result = await resolveCommandCodePlan({
        apiKey: MOCK_KEY,
        cachePath,
        fetchImpl: accountFetch(undefined, () => {
          requests += 1
        }),
      })

      assert.equal(result.resolution.plan, "max")
      assert.equal(result.resolution.source, "cache")
      assert.equal(result.resolution.mode, "manual")
      assert.equal(requests, 0)
    })
  })

  it("force bypasses the manual cache and re-detects over the network", async () => {
    await withCacheDir(async ({ cachePath }) => {
      await saveManualCommandCodePlan(cachePath, "max", MOCK_KEY)

      let requests = 0
      const result = await resolveCommandCodePlan({
        apiKey: MOCK_KEY,
        cachePath,
        force: true,
        fetchImpl: accountFetch(undefined, () => {
          requests += 1
        }),
      })

      assert.equal(result.resolution.plan, "goat")
      assert.equal(result.resolution.source, "subscription")
      assert.equal(requests, 2)
    })
  })

  it("honors allowNetwork:false and serves a cached plan as stale", async () => {
    await withCacheDir(async ({ cachePath }) => {
      await resolveCommandCodePlan({ apiKey: MOCK_KEY, cachePath, fetchImpl: accountFetch() })

      let requests = 0
      const result = await resolveCommandCodePlan({
        apiKey: MOCK_KEY,
        cachePath,
        allowNetwork: false,
        fetchImpl: accountFetch(undefined, () => {
          requests += 1
        }),
      })

      assert.equal(result.resolution.plan, "goat")
      assert.equal(result.resolution.source, "cache")
      assert.equal(result.resolution.stale, true)
      assert.equal(requests, 0)
    })
  })

  it("returns unknown with a go-only warning when offline and nothing is cached", async () => {
    await withCacheDir(async ({ cachePath }) => {
      const result = await resolveCommandCodePlan({
        apiKey: MOCK_KEY,
        cachePath,
        fetchImpl: offlineFetch(),
      })

      assert.equal(result.resolution.plan, "unknown")
      assert.equal(result.resolution.filterPlan, "go")
      assert.equal(result.resolution.source, "fallback")
      assert.match(result.warning ?? "", /only Go models will be exposed/)
    })
  })

  it("falls back to a stale cached plan when detection fails after a success", async () => {
    await withCacheDir(async ({ cachePath }) => {
      await resolveCommandCodePlan({ apiKey: MOCK_KEY, cachePath, fetchImpl: accountFetch() })

      const result = await resolveCommandCodePlan({
        apiKey: MOCK_KEY,
        cachePath,
        fetchImpl: failingFetch(),
      })

      assert.equal(result.resolution.plan, "goat")
      assert.equal(result.resolution.source, "cache")
      assert.equal(result.resolution.stale, true)
      assert.match(result.warning ?? "", /using the cached plan/)
    })
  })

  it("falls back per key fingerprint — another key never inherits the cache", async () => {
    await withCacheDir(async ({ cachePath }) => {
      await resolveCommandCodePlan({ apiKey: MOCK_KEY, cachePath, fetchImpl: accountFetch() })

      const otherKey = "user_other-key-abcdefghijklmnop"
      const result = await resolveCommandCodePlan({
        apiKey: otherKey,
        cachePath,
        fetchImpl: offlineFetch(),
      })

      assert.equal(result.resolution.plan, "unknown")
      assert.equal(result.resolution.source, "fallback")
      assert.match(result.warning ?? "", /only Go models will be exposed/)
    })
  })

  it("never leaks the API key into warnings", async () => {
    await withCacheDir(async ({ cachePath }) => {
      const rejected = new Error(`401 Unauthorized: Bearer ${MOCK_KEY}`)
      const result = await resolveCommandCodePlan({
        apiKey: MOCK_KEY,
        cachePath,
        fetchImpl: (() => Promise.reject(rejected)) as typeof fetch,
      })

      assert.equal(result.resolution.plan, "unknown")
      assert.doesNotMatch(result.warning ?? "", new RegExp(MOCK_KEY))
      assert.match(result.warning ?? "", /Bearer \[redacted\]/)
    })
  })

  it("reports unknown when no API key is available", async () => {
    await withCacheDir(async ({ cachePath }) => {
      const result = await resolveCommandCodePlan({ cachePath })
      assert.equal(result.resolution.plan, "unknown")
      assert.equal(result.resolution.source, "fallback")
      assert.equal(result.resolution.keyFingerprint, undefined)
      assert.match(result.warning ?? "", /No Command Code API key/)
    })
  })
})

describe("plan-store", () => {
  it("returns an empty map for a missing or corrupted cache", async () => {
    await withCacheDir(async ({ cachePath }) => {
      assert.deepEqual(await loadPlanProfiles(cachePath), {})

      await writeFile(cachePath, "not json", "utf-8")
      assert.deepEqual(await loadPlanProfiles(cachePath), {})

      await writeFile(cachePath, JSON.stringify({ version: 99 }), "utf-8")
      assert.deepEqual(await loadPlanProfiles(cachePath), {})
    })
  })

  it("isolates profiles by key fingerprint", async () => {
    await withCacheDir(async ({ cachePath }) => {
      await savePlanProfile(cachePath, {
        version: 1,
        keyFingerprint: keyFingerprint("user_key-a"),
        mode: "auto",
        detectedPlan: "goat",
        detectedAt: "2026-09-18T00:00:00.000Z",
      })
      await savePlanProfile(cachePath, {
        version: 1,
        keyFingerprint: keyFingerprint("user_key-b"),
        mode: "manual",
        selectedPlan: "pro",
        detectedPlan: "pro",
        detectedAt: "2026-09-18T00:00:00.000Z",
      })

      const profiles = await loadPlanProfiles(cachePath)
      assert.deepEqual(
        Object.keys(profiles).sort(),
        [keyFingerprint("user_key-a"), keyFingerprint("user_key-b")].sort(),
      )
      assert.equal(profiles[keyFingerprint("user_key-a")]?.detectedPlan, "goat")
      assert.equal(profiles[keyFingerprint("user_key-b")]?.selectedPlan, "pro")
    })
  })
})

describe("formatPlanResolution()", () => {
  it("renders a redacted, human-readable summary", async () => {
    await withCacheDir(async ({ cachePath }) => {
      const { resolution } = await resolveCommandCodePlan({
        apiKey: MOCK_KEY,
        cachePath,
        fetchImpl: accountFetch(),
      })

      const text = formatPlanResolution(resolution)
      assert.match(text, /plan: goat/)
      assert.match(text, /plan mode: auto/)
      assert.match(text, /plan source: subscription/)
      assert.match(text, /plan key: configured/)
      assert.match(text, /plan warning: none/)
      assert.doesNotMatch(text, new RegExp(MOCK_KEY))
      assert.doesNotMatch(text, new RegExp(keyFingerprint(MOCK_KEY)))
    })
  })
})
