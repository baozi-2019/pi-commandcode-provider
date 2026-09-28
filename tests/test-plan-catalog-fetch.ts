import assert from "node:assert/strict"
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, it } from "node:test"

import {
  compareCatalogVersions,
  parsePlanCatalogMarkdown,
  readPlanCatalogCache,
  refreshPlanCatalog,
  usablePlanCatalogCache,
} from "../src/plan-catalog-fetch.ts"

function tableRows(entries: Array<[string, string]>): string {
  const header =
    "| Id (use EXACTLY this) | Name | Context | Efforts | Price | Min plan | Best for |\n|---|---|---|---|---|---|---|\n"
  return (
    header +
    entries
      .map(([id, plan]) => `| \`${id}\` | X | 1M | high | $1/$2 | ${plan} | stuff |`)
      .join("\n") +
    "\n"
  )
}

/** Build a valid table with enough rows to pass the minimum-row gate. */
function validMarkdown(overrides: Array<[string, string]> = []): string {
  const rows: Array<[string, string]> = []
  for (let index = 0; index < 40; index += 1) {
    rows.push([`vendor/model-${index}`, "Go and above"])
  }
  rows.push(["premium/claude", "Max"])
  rows.push(["mid/sonnet", "Pro and above"])
  rows.push(["upper/gpt", "GOAT and above"])
  rows.push(...overrides)
  return tableRows(rows)
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status })
}

function textResponse(body: string, status = 200): Response {
  return new Response(body, { status })
}

async function tempCachePath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "cc-plan-catalog-"))
  return join(dir, "plan-catalog-cache.json")
}

describe("parsePlanCatalogMarkdown", () => {
  it("parses Min plan cells including the bare 'Max' form", () => {
    const entries = parsePlanCatalogMarkdown(validMarkdown())
    assert.ok(entries)
    assert.equal(entries["vendor/model-0"], "go")
    assert.equal(entries["premium/claude"], "max")
    assert.equal(entries["mid/sonnet"], "pro")
    assert.equal(entries["upper/gpt"], "goat")
  })

  it("tolerates a reordered Min plan column", () => {
    const header = "| Name | Min plan | Id (use EXACTLY this) |\n|---|---|---|\n"
    const rows: string[] = []
    for (let index = 0; index < 40; index += 1) {
      rows.push(`| X | Go and above | \`vendor/model-${index}\` |`)
    }
    // Ids are read from the first column regardless of header order; when the
    // id column moves the table is unusable, so this documents rejection.
    const entries = parsePlanCatalogMarkdown(header + rows.join("\n"))
    assert.equal(entries, undefined)
  })

  it("rejects tables below the minimum row count", () => {
    const entries = parsePlanCatalogMarkdown(tableRows([["a/b", "Go and above"]]))
    assert.equal(entries, undefined)
  })

  it("skips rows with unrecognized plan words instead of widening access", () => {
    const entries = parsePlanCatalogMarkdown(validMarkdown([["new/tier-model", "Ultra and above"]]))
    assert.ok(entries)
    assert.equal(entries["new/tier-model"], undefined)
  })

  it("skips ids outside the canonical charset", () => {
    const entries = parsePlanCatalogMarkdown(validMarkdown([["bad id with space", "Go and above"]]))
    assert.ok(entries)
    assert.equal(entries["bad id with space"], undefined)
  })

  it("returns undefined when no Min plan table exists", () => {
    assert.equal(parsePlanCatalogMarkdown("# just prose\n"), undefined)
  })
})

describe("compareCatalogVersions", () => {
  it("orders numeric semver segments", () => {
    assert.ok(compareCatalogVersions("1.66.0", "1.62.0") > 0)
    assert.ok(compareCatalogVersions("1.62.0", "1.62.0") === 0)
    assert.ok(compareCatalogVersions("1.9.0", "1.62.0") < 0)
    assert.ok(compareCatalogVersions("2.0.0", "1.99.9") > 0)
  })

  it("treats invalid versions as lowest", () => {
    assert.ok(compareCatalogVersions("garbage", "1.0.0") < 0)
    assert.equal(compareCatalogVersions("garbage", "junk"), 0)
  })
})

describe("refreshPlanCatalog", () => {
  it("downloads a newer catalog, parses it, and caches it atomically with 0600", async () => {
    const cachePath = await tempCachePath()
    const urls: string[] = []
    const outcome = await refreshPlanCatalog({
      cachePath,
      registryUrl: "https://registry.example/latest",
      catalogUrlTemplate: "https://cdn.example/pkg@{version}/models.md",
      fetchImpl: async (input) => {
        const url = String(input)
        urls.push(url)
        if (url.includes("/latest")) return jsonResponse({ version: "1.99.0" })
        return textResponse(validMarkdown([["new/vendor-model", "Goat and above"]]))
      },
    })

    assert.equal(outcome.source, "live")
    assert.equal(outcome.catalogVersion, "1.99.0")
    assert.equal(outcome.entries?.["new/vendor-model"], "goat")
    assert.deepEqual(urls, [
      "https://registry.example/latest",
      "https://cdn.example/pkg@1.99.0/models.md",
    ])

    const cached = await readPlanCatalogCache(cachePath)
    assert.equal(cached?.catalogVersion, "1.99.0")
    assert.equal(cached?.entries?.["new/vendor-model"], "goat")
    const mode = (await stat(cachePath)).mode & 0o777
    assert.equal(mode, 0o600)
    const raw = await readFile(cachePath, "utf-8")
    assert.doesNotMatch(raw, /Bearer|api[-_ ]?key/i)
  })

  it("serves the cache without downloading when the registry version matches", async () => {
    const cachePath = await tempCachePath()
    const first = await refreshPlanCatalog({
      cachePath,
      registryUrl: "https://registry.example/latest",
      catalogUrlTemplate: "https://cdn.example/pkg@{version}/models.md",
      fetchImpl: async (input) =>
        String(input).includes("/latest")
          ? jsonResponse({ version: "1.99.0" })
          : textResponse(validMarkdown()),
    })
    assert.equal(first.source, "live")

    const urls: string[] = []
    const second = await refreshPlanCatalog({
      cachePath,
      registryUrl: "https://registry.example/latest",
      catalogUrlTemplate: "https://cdn.example/pkg@{version}/models.md",
      fetchImpl: async (input) => {
        urls.push(String(input))
        return jsonResponse({ version: "1.99.0" })
      },
    })
    assert.equal(second.source, "cache")
    assert.deepEqual(urls, ["https://registry.example/latest"], "no markdown download")
    assert.ok(second.entries)
  })

  it("falls back to the stale cache when the registry is unreachable", async () => {
    const cachePath = await tempCachePath()
    await refreshPlanCatalog({
      cachePath,
      registryUrl: "https://registry.example/latest",
      catalogUrlTemplate: "https://cdn.example/pkg@{version}/models.md",
      fetchImpl: async (input) =>
        String(input).includes("/latest")
          ? jsonResponse({ version: "1.99.0" })
          : textResponse(validMarkdown()),
    })

    const outcome = await refreshPlanCatalog({
      cachePath,
      registryUrl: "https://registry.example/latest",
      fetchImpl: async () => {
        throw new Error("network down")
      },
    })
    assert.equal(outcome.source, "cache")
    assert.equal(outcome.catalogVersion, "1.99.0")
    assert.equal(outcome.warning, undefined)
    assert.ok(outcome.entries)
  })

  it("degrades to the bundled snapshot with a redacted warning when nothing works", async () => {
    const cachePath = await tempCachePath()
    const outcome = await refreshPlanCatalog({
      cachePath,
      registryUrl: "https://registry.example/latest?api_key=supersecret123456",
      fetchImpl: async () => {
        throw new Error("GET https://registry.example/latest?api_key=supersecret123456 failed")
      },
    })
    assert.equal(outcome.source, "bundled")
    assert.equal(outcome.entries, undefined)
    assert.match(outcome.warning ?? "", /bundled snapshot/)
    // Warning text is redacted by the runtime layer; here it must at least not
    // embed credentials itself.
    assert.match(outcome.warning ?? "", /Could not refresh the Command Code plan catalog/)
  })

  it("rejects a markdown table that lost its rows and keeps the cache", async () => {
    const cachePath = await tempCachePath()
    await refreshPlanCatalog({
      cachePath,
      registryUrl: "https://registry.example/latest",
      catalogUrlTemplate: "https://cdn.example/pkg@{version}/models.md",
      fetchImpl: async (input) =>
        String(input).includes("/latest")
          ? jsonResponse({ version: "1.99.0" })
          : textResponse(validMarkdown()),
    })

    const outcome = await refreshPlanCatalog({
      cachePath,
      registryUrl: "https://registry.example/latest",
      catalogUrlTemplate: "https://cdn.example/pkg@{version}/models.md",
      fetchImpl: async (input) =>
        String(input).includes("/latest")
          ? jsonResponse({ version: "2.0.0" })
          : textResponse("# upstream broke the format\n"),
    })
    assert.equal(outcome.source, "cache")
    assert.equal(outcome.catalogVersion, "1.99.0")
    const cached = await readPlanCatalogCache(cachePath)
    assert.equal(cached?.catalogVersion, "1.99.0", "cache must not be overwritten by garbage")
  })
})

describe("usablePlanCatalogCache", () => {
  it("ignores caches older than the bundled snapshot", async () => {
    const cachePath = await tempCachePath()
    await refreshPlanCatalog({
      cachePath,
      registryUrl: "https://registry.example/latest",
      catalogUrlTemplate: "https://cdn.example/pkg@{version}/models.md",
      fetchImpl: async (input) =>
        String(input).includes("/latest")
          ? jsonResponse({ version: "0.0.1" })
          : textResponse(validMarkdown()),
    })
    const cache = await readPlanCatalogCache(cachePath)
    assert.equal(cache?.catalogVersion, "0.0.1")
    assert.equal(usablePlanCatalogCache(cache), undefined)
  })

  it("ignores corrupt cache files", async () => {
    const cachePath = await tempCachePath()
    await writeFile(cachePath, "not json")
    assert.equal(await readPlanCatalogCache(cachePath), undefined)
  })
})
