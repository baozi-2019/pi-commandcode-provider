import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { dirname } from "node:path"

import type { PlanProfile } from "./plan-types.ts"

const PLAN_CACHE_VERSION = 1

interface PlanCache {
  version: typeof PLAN_CACHE_VERSION
  profiles: Record<string, PlanProfile>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isPlanProfile(value: unknown): value is PlanProfile {
  if (!isRecord(value)) return false
  if (value.version !== 1 || typeof value.keyFingerprint !== "string") return false
  if (value.mode !== "auto" && value.mode !== "manual") return false
  return true
}

function parseCache(value: unknown): PlanCache {
  if (!isRecord(value) || value.version !== PLAN_CACHE_VERSION) {
    throw new Error(`Expected plan cache version ${PLAN_CACHE_VERSION}`)
  }
  if (!isRecord(value.profiles)) throw new Error("Expected plan cache profiles to be an object")

  const profiles: Record<string, PlanProfile> = {}
  for (const [fingerprint, profile] of Object.entries(value.profiles)) {
    if (isPlanProfile(profile) && profile.keyFingerprint === fingerprint) {
      profiles[fingerprint] = profile
    }
  }
  return { version: PLAN_CACHE_VERSION, profiles }
}

export async function loadPlanProfiles(
  cachePath: string,
): Promise<Readonly<Record<string, PlanProfile>>> {
  try {
    const contents = await readFile(cachePath, "utf-8")
    return parseCache(JSON.parse(contents)).profiles
  } catch {
    return {}
  }
}

export async function savePlanProfile(cachePath: string, profile: PlanProfile): Promise<void> {
  const existing = await loadPlanProfiles(cachePath)
  const cache: PlanCache = {
    version: PLAN_CACHE_VERSION,
    profiles: { ...existing, [profile.keyFingerprint]: profile },
  }
  await mkdir(dirname(cachePath), { recursive: true })
  const temporaryPath = `${cachePath}.${process.pid}.tmp`
  try {
    await writeFile(temporaryPath, `${JSON.stringify(cache, null, 2)}\n`, {
      encoding: "utf-8",
      mode: 0o600,
    })
    await rename(temporaryPath, cachePath)
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => undefined)
  }
}
