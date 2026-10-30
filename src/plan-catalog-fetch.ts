/**
 * Dynamic minimum-plan catalog.
 *
 * The live `/provider/v1/models` endpoint carries no plan metadata, so the
 * bundled `MODEL_MIN_PLAN` snapshot is the fail-closed floor. On top of it we
 * refresh the same table at runtime from the upstream `command-code` npm
 * package: the registry packument yields the latest version, and unpkg serves
 * the versioned `reference/models.md` — the exact same file the bundled
 * snapshot is generated from, with canonical catalog IDs.
 *
 * The same table carries each model's reasoning `Efforts`; they are surfaced
 * alongside the plans so a model published after the bundled capability
 * snapshot can still expose thinking levels.
 *
 * Priority: fresh runtime cache > bundled snapshot > fail-closed hidden.
 * Everything here is best-effort: fetch or parse failures never throw; they
 * degrade to the last-known-good cache, then to the bundled snapshot.
 */

import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { dirname } from "node:path"

import type { CommandCodeReasoningEffort } from "./commandcode-catalog.ts"
import { COMMAND_CODE_MODEL_CATALOG_VERSION } from "./commandcode-plan-catalog.ts"
import { isSubscriptionPlan, type SubscriptionPlan } from "./plan-types.ts"

export const PLAN_CATALOG_CACHE_VERSION = 1
export const DEFAULT_PLAN_REGISTRY_URL = "https://registry.npmjs.org/command-code/latest"
export const DEFAULT_PLAN_CATALOG_URL_TEMPLATE =
  "https://unpkg.com/command-code@{version}/dist/bundled/command-code-knowledge/reference/models.md"
export const DEFAULT_PLAN_CATALOG_TIMEOUT_MS = 10_000

/** Reject a live table that lost rows, so a truncated page cannot widen or narrow plans. */
const MIN_CATALOG_ROWS = 30
/** Canonical catalog ids: vendor/name tokens with separators used by the live endpoint. */
const MODEL_ID_PATTERN = /^[\w./:@-]+$/
const VERSION_PATTERN = /^\d+\.\d+\.\d+$/

const REASONING_EFFORTS: ReadonlySet<string> = new Set<CommandCodeReasoningEffort>([
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
])

/** Only models with at least one selectable effort appear; absence means "unknown/none". */
export type ModelEffortsMap = Record<string, readonly CommandCodeReasoningEffort[]>

export interface PlanCatalogCacheFile {
  version: number
  catalogVersion: string
  fetchedAt: string
  entries: Record<string, SubscriptionPlan>
  /** Absent in caches written before efforts were tracked; forces one refetch. */
  efforts?: ModelEffortsMap
}

export interface ParsedModelCatalog {
  plans: Record<string, SubscriptionPlan>
  efforts: ModelEffortsMap
}

export type PlanCatalogSource = "live" | "cache" | "bundled"

export interface PlanCatalogOutcome {
  source: PlanCatalogSource
  /** Upstream command-code version the entries came from; absent for "bundled". */
  catalogVersion?: string
  fetchedAt?: string
  /** Present unless the outcome is "bundled". */
  entries?: Record<string, SubscriptionPlan>
  /** Upstream reasoning efforts; present when the source carried them. */
  efforts?: ModelEffortsMap
  warning?: string
}

export interface PlanCatalogFetchOptions {
  registryUrl?: string
  catalogUrlTemplate?: string
  timeoutMs?: number
  fetchImpl?: typeof fetch
  signal?: AbortSignal
}

export interface RefreshPlanCatalogOptions extends PlanCatalogFetchOptions {
  cachePath: string
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Numeric semver-ish compare; returns negative/0/positive. Invalid input sorts lowest. */
export function compareCatalogVersions(a: string, b: string): number {
  const parse = (value: string): number[] | undefined => {
    if (!VERSION_PATTERN.test(value)) return undefined
    return value.split(".").map((part) => Number(part))
  }
  const left = parse(a)
  const right = parse(b)
  if (!left || !right) {
    if (left) return 1
    if (right) return -1
    return 0
  }
  for (let index = 0; index < 3; index += 1) {
    const delta = (left[index] ?? 0) - (right[index] ?? 0)
    if (delta !== 0) return delta
  }
  return 0
}

/** Parse one `Efforts` cell (`—` or `low, high, max`); unknown tokens such as `off` are dropped. */
function parseEffortsCell(cell: string | undefined): CommandCodeReasoningEffort[] {
  if (!cell) return []
  const efforts: CommandCodeReasoningEffort[] = []
  for (const token of cell.split(",")) {
    const effort = token.trim().toLowerCase()
    if (REASONING_EFFORTS.has(effort) && !efforts.includes(effort as CommandCodeReasoningEffort)) {
      efforts.push(effort as CommandCodeReasoningEffort)
    }
  }
  return efforts
}

/**
 * Parse the upstream `reference/models.md` tables: rows are
 * `| \`id\` | name | context | efforts | price | Min plan | best for |` where
 * the Min plan cell is `<Tier> [and above]`. Column positions are taken from
 * the header, so upstream may reorder columns; rows with an unrecognized tier
 * are skipped (fail-closed per model). Returns undefined when the table is
 * missing or implausibly small — the caller then keeps the previous catalog.
 */
export function parseModelCatalogMarkdown(markdown: string): ParsedModelCatalog | undefined {
  const plans = new Map<string, SubscriptionPlan>()
  const efforts: ModelEffortsMap = {}
  let minPlanColumn = -1
  let effortsColumn = -1

  for (const line of markdown.split("\n")) {
    if (!line.startsWith("|")) continue
    const cells = line
      .split("|")
      .slice(1, -1)
      .map((cell) => cell.trim())
    if (cells.length < 2) continue

    const headerIndex = cells.findIndex((cell) => /^min plan$/i.test(cell))
    if (headerIndex >= 0) {
      minPlanColumn = headerIndex
      effortsColumn = cells.findIndex((cell) => /^efforts$/i.test(cell))
      continue
    }
    if (minPlanColumn < 0 || minPlanColumn >= cells.length) continue
    if (cells.every((cell) => /^-+$/.test(cell))) continue

    const idMatch = cells[0]?.match(/^`([^`]+)`$/)
    const id = idMatch?.[1]
    if (!id || !MODEL_ID_PATTERN.test(id)) continue

    const planWord = cells[minPlanColumn]?.replace(/\s+and above$/i, "").toLowerCase()
    if (!planWord || !isSubscriptionPlan(planWord)) continue
    plans.set(id, planWord)

    if (effortsColumn >= 0) {
      const parsed = parseEffortsCell(cells[effortsColumn])
      if (parsed.length > 0) efforts[id] = parsed
    }
  }

  return plans.size >= MIN_CATALOG_ROWS ? { plans: Object.fromEntries(plans), efforts } : undefined
}

/** Plans-only view of {@link parseModelCatalogMarkdown}. */
export function parsePlanCatalogMarkdown(
  markdown: string,
): Record<string, SubscriptionPlan> | undefined {
  return parseModelCatalogMarkdown(markdown)?.plans
}

async function fetchJson(url: string, options: PlanCatalogFetchOptions): Promise<unknown> {
  const fetchImpl = options.fetchImpl ?? fetch
  const response = await fetchImpl(url, { signal: options.signal })
  if (!response.ok) throw new Error(`GET ${url} failed with HTTP ${response.status}`)
  return response.json()
}

async function fetchText(url: string, options: PlanCatalogFetchOptions): Promise<string> {
  const fetchImpl = options.fetchImpl ?? fetch
  const response = await fetchImpl(url, { signal: options.signal })
  if (!response.ok) throw new Error(`GET ${url} failed with HTTP ${response.status}`)
  return response.text()
}

/** Invalid or missing efforts degrade to undefined (plans stay usable, efforts get refetched). */
function sanitizeCachedEfforts(value: unknown): ModelEffortsMap | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined
  const result: ModelEffortsMap = {}
  for (const [id, list] of Object.entries(value)) {
    if (!MODEL_ID_PATTERN.test(id) || !Array.isArray(list)) return undefined
    const efforts = list.filter(
      (item): item is CommandCodeReasoningEffort =>
        typeof item === "string" && REASONING_EFFORTS.has(item),
    )
    if (efforts.length > 0) result[id] = efforts
  }
  return result
}

export async function readPlanCatalogCache(
  cachePath: string,
): Promise<PlanCatalogCacheFile | undefined> {
  try {
    const raw = JSON.parse(await readFile(cachePath, "utf-8")) as Partial<PlanCatalogCacheFile>
    if (raw.version !== PLAN_CATALOG_CACHE_VERSION) return undefined
    if (typeof raw.catalogVersion !== "string" || !VERSION_PATTERN.test(raw.catalogVersion)) {
      return undefined
    }
    if (typeof raw.fetchedAt !== "string") return undefined
    const entries = raw.entries
    if (typeof entries !== "object" || entries === null || Array.isArray(entries)) return undefined
    for (const [id, plan] of Object.entries(entries)) {
      if (!MODEL_ID_PATTERN.test(id)) return undefined
      if (!isSubscriptionPlan(plan)) return undefined
    }
    return {
      version: PLAN_CATALOG_CACHE_VERSION,
      catalogVersion: raw.catalogVersion,
      fetchedAt: raw.fetchedAt,
      entries: entries as Record<string, SubscriptionPlan>,
      efforts: sanitizeCachedEfforts(raw.efforts),
    }
  } catch {
    return undefined
  }
}

export async function writePlanCatalogCache(
  cachePath: string,
  cache: Omit<PlanCatalogCacheFile, "version">,
): Promise<void> {
  await mkdir(dirname(cachePath), { recursive: true })
  const temporaryPath = `${cachePath}.${process.pid}.tmp`
  try {
    const payload: PlanCatalogCacheFile = { version: PLAN_CATALOG_CACHE_VERSION, ...cache }
    await writeFile(temporaryPath, `${JSON.stringify(payload, null, 2)}\n`, {
      encoding: "utf-8",
      mode: 0o600,
    })
    await rename(temporaryPath, cachePath)
  } finally {
    try {
      await rm(temporaryPath, { force: true })
    } catch {
      // Best-effort cleanup must not hide the original cache write error.
    }
  }
}

/**
 * A runtime cache is only useful when it is at least as fresh as the bundled
 * snapshot; an older cache must never regress code-shipped metadata.
 */
export function usablePlanCatalogCache(
  cache: PlanCatalogCacheFile | undefined,
): PlanCatalogCacheFile | undefined {
  if (!cache) return undefined
  return compareCatalogVersions(cache.catalogVersion, COMMAND_CODE_MODEL_CATALOG_VERSION) >= 0
    ? cache
    : undefined
}

function cacheOutcome(cache: PlanCatalogCacheFile): PlanCatalogOutcome {
  return {
    source: "cache",
    catalogVersion: cache.catalogVersion,
    fetchedAt: cache.fetchedAt,
    entries: cache.entries,
    ...(cache.efforts ? { efforts: cache.efforts } : {}),
  }
}

/**
 * Refresh the dynamic plan catalog. Never throws; degrades live → cache → bundled.
 */
export async function refreshPlanCatalog(
  options: RefreshPlanCatalogOptions,
): Promise<PlanCatalogOutcome> {
  const registryUrl = options.registryUrl ?? DEFAULT_PLAN_REGISTRY_URL
  const catalogUrlTemplate = options.catalogUrlTemplate ?? DEFAULT_PLAN_CATALOG_URL_TEMPLATE
  const cache = usablePlanCatalogCache(await readPlanCatalogCache(options.cachePath))

  try {
    const packument = (await fetchJson(registryUrl, options)) as { version?: unknown }
    const latestVersion = packument.version
    if (typeof latestVersion !== "string" || !VERSION_PATTERN.test(latestVersion)) {
      throw new Error("npm registry response did not include a valid version")
    }

    if (cache?.catalogVersion === latestVersion && cache.efforts !== undefined) {
      return cacheOutcome(cache)
    }

    const url = catalogUrlTemplate.replace("{version}", latestVersion)
    const markdown = await fetchText(url, options)
    const parsed = parseModelCatalogMarkdown(markdown)
    if (!parsed) {
      throw new Error("upstream models.md did not yield a usable Min plan table")
    }
    const { plans: entries, efforts } = parsed

    const fetchedAt = new Date().toISOString()
    try {
      await writePlanCatalogCache(options.cachePath, {
        catalogVersion: latestVersion,
        fetchedAt,
        entries,
        efforts,
      })
    } catch (writeError) {
      return {
        source: "live",
        catalogVersion: latestVersion,
        fetchedAt,
        entries,
        efforts,
        warning: `Refreshed the plan catalog to ${latestVersion} but could not update the cache: ${errorMessage(writeError)}`,
      }
    }
    return { source: "live", catalogVersion: latestVersion, fetchedAt, entries, efforts }
  } catch (error) {
    if (cache) return cacheOutcome(cache)
    return {
      source: "bundled",
      warning: `Could not refresh the Command Code plan catalog (${errorMessage(error)}); using the bundled snapshot ${COMMAND_CODE_MODEL_CATALOG_VERSION}.`,
    }
  }
}
