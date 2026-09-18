/**
 * Unit tests for src/plan-types.ts: plan identifier normalization, key
 * fingerprints, environment overrides, and plan-level visibility rules.
 * These are hermetic: no pi runtime and no network.
 */

import assert from "node:assert/strict"
import { describe, it } from "node:test"

import {
  configuredPlan,
  filterPlanFor,
  isSubscriptionPlan,
  keyFingerprint,
  normalizePlanId,
  planAllows,
  planRank,
  SUBSCRIPTION_PLANS,
} from "../src/plan-types.ts"

describe("keyFingerprint()", () => {
  it("returns a stable 32-char hex digest", () => {
    const first = keyFingerprint("user_test-key-value")
    const second = keyFingerprint("user_test-key-value")

    assert.equal(first.length, 32)
    assert.match(first, /^[0-9a-f]{32}$/)
    assert.equal(first, second)
  })

  it("differs between keys and never equals the input", () => {
    const first = keyFingerprint("user_key-a")
    const second = keyFingerprint("user_key-b")

    assert.notEqual(first, second)
    assert.notEqual(first, "user_key-a")
    assert.notEqual(second, "user_key-b")
  })
})

describe("normalizePlanId()", () => {
  it("normalizes the four subscription tiers case-insensitively", () => {
    assert.equal(normalizePlanId("go"), "go")
    assert.equal(normalizePlanId("GO"), "go")
    assert.equal(normalizePlanId("Goat"), "goat")
    assert.equal(normalizePlanId("  pro  "), "pro")
    assert.equal(normalizePlanId("MAX"), "max")
  })

  it("collapses separators and aliases for the subscription tiers", () => {
    assert.equal(normalizePlanId("max_10x"), "max")
    assert.equal(normalizePlanId("max-20x"), "max")
    assert.equal(normalizePlanId("max 10x"), "max")
    assert.equal(normalizePlanId("team_pro"), "pro")
    assert.equal(normalizePlanId("team-pro"), "pro")
  })

  it("maps pay-as-you-go identifiers to provider", () => {
    assert.equal(normalizePlanId("provider"), "provider")
    assert.equal(normalizePlanId("pay as you go"), "provider")
    assert.equal(normalizePlanId("provider-api"), "provider")
    assert.equal(normalizePlanId("api"), "provider")
  })

  it("returns unknown for unrecognized, non-string, and empty values", () => {
    assert.equal(normalizePlanId("enterprise-custom"), "unknown")
    assert.equal(normalizePlanId(""), "unknown")
    assert.equal(normalizePlanId(42), "unknown")
    assert.equal(normalizePlanId(null), "unknown")
    assert.equal(normalizePlanId(undefined), "unknown")
    assert.equal(normalizePlanId({ planId: "go" }), "unknown")
  })
})

describe("configuredPlan()", () => {
  it("returns undefined when the variable is unset or empty", () => {
    assert.equal(configuredPlan({}), undefined)
    assert.equal(configuredPlan({ COMMANDCODE_PLAN: "" }), undefined)
    assert.equal(configuredPlan({ COMMANDCODE_PLAN: "   " }), undefined)
  })

  it("returns auto explicitly and the tier for valid values", () => {
    assert.equal(configuredPlan({ COMMANDCODE_PLAN: "auto" }), "auto")
    assert.equal(configuredPlan({ COMMANDCODE_PLAN: "go" }), "go")
    assert.equal(configuredPlan({ COMMANDCODE_PLAN: "GOAT" }), "goat")
    assert.equal(configuredPlan({ COMMANDCODE_PLAN: " Pro " }), "pro")
    assert.equal(configuredPlan({ COMMANDCODE_PLAN: "max" }), "max")
  })

  it("ignores invalid values instead of falling back to a higher tier", () => {
    assert.equal(configuredPlan({ COMMANDCODE_PLAN: "platinum" }), undefined)
    assert.equal(configuredPlan({ COMMANDCODE_PLAN: "provider" }), undefined)
    assert.equal(configuredPlan({ COMMANDCODE_PLAN: "max20" }), undefined)
  })
})

describe("filterPlanFor()", () => {
  it("maps unknown plans to the go catalog, never to provider", () => {
    assert.equal(filterPlanFor("go"), "go")
    assert.equal(filterPlanFor("goat"), "goat")
    assert.equal(filterPlanFor("pro"), "pro")
    assert.equal(filterPlanFor("max"), "max")
    assert.equal(filterPlanFor("provider"), "provider")
    assert.equal(filterPlanFor("unknown"), "go")
  })
})

describe("planRank() and planAllows()", () => {
  it("orders tiers go < goat < pro < max", () => {
    assert.ok(planRank("go") < planRank("goat"))
    assert.ok(planRank("goat") < planRank("pro"))
    assert.ok(planRank("pro") < planRank("max"))
    assert.equal(SUBSCRIPTION_PLANS.length, 4)
  })

  it("grants cumulative access across the four tiers", () => {
    for (const tier of SUBSCRIPTION_PLANS as readonly ("go" | "goat" | "pro" | "max")[]) {
      for (const required of SUBSCRIPTION_PLANS) {
        const allowed = planAllows(required, tier)
        if (planRank(required) <= planRank(tier)) {
          assert.equal(allowed, true, `${tier} should include ${required}`)
        } else {
          assert.equal(allowed, false, `${tier} should not include ${required}`)
        }
      }
    }
  })

  it("treats provider as full access and unknown as go-only", () => {
    assert.equal(planAllows("max", "provider"), true)
    assert.equal(planAllows("pro", "provider"), true)
    assert.equal(planAllows("go", "provider"), true)

    assert.equal(planAllows("go", "unknown"), true)
    assert.equal(planAllows("goat", "unknown"), false)
    assert.equal(planAllows("max", "unknown"), false)
  })

  it("allows models with no required plan", () => {
    assert.equal(planAllows(undefined, "unknown"), true)
    assert.equal(planAllows(undefined, "go"), true)
  })
})

describe("isSubscriptionPlan()", () => {
  it("accepts exactly the four tiers", () => {
    for (const tier of SUBSCRIPTION_PLANS) assert.equal(isSubscriptionPlan(tier), true)
    assert.equal(isSubscriptionPlan("provider"), false)
    assert.equal(isSubscriptionPlan("unknown"), false)
    assert.equal(isSubscriptionPlan("goat-plus"), false)
  })
})
