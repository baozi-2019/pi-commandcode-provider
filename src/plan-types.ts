import { createHash } from "node:crypto"

export const SUBSCRIPTION_PLANS = ["go", "goat", "pro", "max"] as const

export type SubscriptionPlan = (typeof SUBSCRIPTION_PLANS)[number]
export type EffectivePlan = SubscriptionPlan | "provider" | "unknown"
export type PlanMode = "auto" | "manual"
export type PlanSource = "environment" | "manual" | "subscription" | "cache" | "fallback"

export interface PlanProfile {
  version: 1
  keyFingerprint: string
  mode: PlanMode
  selectedPlan?: SubscriptionPlan
  detectedPlan?: EffectivePlan
  detectedAt?: string
}

export interface PlanResolution {
  plan: EffectivePlan
  filterPlan: SubscriptionPlan | "provider"
  mode: PlanMode
  source: PlanSource
  keyFingerprint?: string
  detectedAt?: string
  stale?: boolean
  warning?: string
}

export function keyFingerprint(apiKey: string): string {
  return createHash("sha256").update(apiKey).digest("hex").slice(0, 32)
}

export function isSubscriptionPlan(value: string): value is SubscriptionPlan {
  return (SUBSCRIPTION_PLANS as readonly string[]).includes(value)
}

/**
 * Normalize the plan identifiers returned by Command Code's account APIs.
 * Unknown identifiers intentionally remain unknown instead of gaining access.
 */
export function normalizePlanId(value: unknown): EffectivePlan {
  if (typeof value !== "string") return "unknown"

  const normalized = value
    .trim()
    .toLowerCase()
    .replaceAll(/[ _-]+/g, "")
  if (normalized === "go") return "go"
  if (normalized === "goat") return "goat"
  if (normalized === "pro" || normalized === "teampro") return "pro"
  if (normalized === "max" || normalized === "max10x" || normalized === "max20x") return "max"
  if (
    normalized === "provider" ||
    normalized === "payasyougo" ||
    normalized === "providerapi" ||
    normalized === "api"
  ) {
    return "provider"
  }

  // Billing systems prefix plan ids (for example "individual-goat"). Match
  // whole separator-delimited tokens only, and take the lowest matching tier,
  // so unknown prefixes or extra words never gain unintended access.
  const tokens = value
    .trim()
    .toLowerCase()
    .split(/[ _-]+/)
    .filter(Boolean)
  let matched: SubscriptionPlan | undefined
  for (const token of tokens) {
    if (!isSubscriptionPlan(token)) continue
    if (!matched || planRank(token) < planRank(matched)) matched = token
  }
  return matched ?? "unknown"
}

export function configuredPlan(
  env: NodeJS.ProcessEnv = process.env,
): SubscriptionPlan | "auto" | undefined {
  const raw = env.COMMANDCODE_PLAN?.trim().toLowerCase()
  if (!raw || raw === "auto") return raw === "auto" ? "auto" : undefined
  return isSubscriptionPlan(raw) ? raw : undefined
}

/** Unknown plans use the lowest catalog visibility, never the highest. */
export function filterPlanFor(plan: EffectivePlan): SubscriptionPlan | "provider" {
  return plan === "provider" ? "provider" : plan === "unknown" ? "go" : plan
}

export function planRank(plan: SubscriptionPlan): number {
  return SUBSCRIPTION_PLANS.indexOf(plan)
}

export function planAllows(required: SubscriptionPlan | undefined, plan: EffectivePlan): boolean {
  if (!required || plan === "provider") return true
  if (plan === "unknown") return required === "go"
  return planRank(required) <= planRank(plan)
}
