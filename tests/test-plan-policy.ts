/**
 * Unit tests for src/plan-policy.ts and the generated MODEL_MIN_PLAN catalog.
 * Expected tier counts are derived from the catalog itself instead of being
 * hard-coded, so upstream catalog snapshots only need one source of truth.
 */

import assert from "node:assert/strict"
import { describe, it } from "node:test"

import {
  COMMAND_CODE_MODEL_CATALOG_VERSION,
  MODEL_MIN_PLAN,
} from "../src/commandcode-plan-catalog.ts"
import type { CommandCodeModel } from "../src/models.ts"
import {
  assertCommandCodeModelAllowed,
  filterCommandCodeModels,
  requiredPlanForModel,
} from "../src/plan-policy.ts"
import { planRank, SUBSCRIPTION_PLANS, type SubscriptionPlan } from "../src/plan-types.ts"

function model(id: string): CommandCodeModel {
  return {
    id,
    name: `${id} (CC)`,
    api: id.startsWith("claude-") ? "anthropic-messages" : "openai-completions",
    reasoning: false,
    contextWindow: 1_000_000,
    maxTokens: 65_536,
  }
}

/** Every catalog model, as the Provider API would return it. */
const CATALOG_MODELS: readonly CommandCodeModel[] = Object.keys(MODEL_MIN_PLAN).sort().map(model)

function expectedCountAtOrBelow(tier: SubscriptionPlan): number {
  const rank = planRank(tier)
  return Object.values(MODEL_MIN_PLAN).filter((plan) => planRank(plan) <= rank).length
}

describe("MODEL_MIN_PLAN catalog", () => {
  it("ships with the upstream command-code snapshot", () => {
    assert.match(COMMAND_CODE_MODEL_CATALOG_VERSION, /^\d+\.\d+\.\d+$/)
    assert.ok(Object.keys(MODEL_MIN_PLAN).length > 0)
    for (const plan of Object.values(MODEL_MIN_PLAN)) {
      assert.ok((SUBSCRIPTION_PLANS as readonly string[]).includes(plan), `unexpected tier ${plan}`)
    }
  })

  it("covers every tier and grows monotonically go < goat < pro < max", () => {
    const counts = SUBSCRIPTION_PLANS.map(expectedCountAtOrBelow)
    for (let index = 1; index < counts.length; index += 1) {
      assert.ok(counts[index]! > counts[index - 1]!, "tier counts must strictly increase")
    }
    for (const tier of SUBSCRIPTION_PLANS) {
      assert.ok(expectedCountAtOrBelow(tier) > 0)
    }
  })
})

describe("filterCommandCodeModels()", () => {
  it("exposes 45/51/64/71 models for go/goat/pro/max respectively", () => {
    const expected: Record<SubscriptionPlan, number> = {
      go: expectedCountAtOrBelow("go"),
      goat: expectedCountAtOrBelow("goat"),
      pro: expectedCountAtOrBelow("pro"),
      max: expectedCountAtOrBelow("max"),
    }

    // Sanity anchor from the command-code@1.56.0 snapshot: go < goat < pro < max = full catalog.
    assert.deepEqual(expected, {
      go: 45,
      goat: 51,
      pro: 64,
      max: Object.keys(MODEL_MIN_PLAN).length,
    })

    for (const tier of SUBSCRIPTION_PLANS) {
      const result = filterCommandCodeModels(CATALOG_MODELS, tier)
      assert.equal(result.models.length, expected[tier], `${tier} visibility`)
      assert.equal(result.filteredCount, CATALOG_MODELS.length - expected[tier])
      assert.deepEqual(result.unknownModelIds, [], `${tier} should not hide known models`)
    }
  })

  it("shows real GOAT-tier models on GOAT but not on Go", () => {
    assert.equal(requiredPlanForModel("xai/grok-4.6"), "goat")
    assert.equal(requiredPlanForModel("gpt-5.6-sol"), "goat")

    const onGoat = filterCommandCodeModels(CATALOG_MODELS, "goat")
    assert.ok(onGoat.models.some((entry) => entry.id === "xai/grok-4.6"))

    const onGo = filterCommandCodeModels(CATALOG_MODELS, "go")
    assert.ok(!onGo.models.some((entry) => entry.id === "xai/grok-4.6"))
    assert.ok(!onGo.models.some((entry) => entry.id === "gpt-5.6-sol"))
  })

  it("shows real Pro/Max-tier premium models only at their tier", () => {
    assert.equal(requiredPlanForModel("claude-sonnet-5"), "pro")
    assert.equal(requiredPlanForModel("claude-opus-5"), "max")

    const onPro = filterCommandCodeModels(CATALOG_MODELS, "pro")
    assert.ok(onPro.models.some((entry) => entry.id === "claude-sonnet-5"))
    assert.ok(!onPro.models.some((entry) => entry.id === "claude-opus-5"))

    const onMax = filterCommandCodeModels(CATALOG_MODELS, "max")
    assert.ok(onMax.models.some((entry) => entry.id === "claude-opus-5"))
  })

  it("hides upstream models missing plan metadata (fail-closed)", () => {
    const upstream = [...CATALOG_MODELS, model("vendor/new-unlisted-model")]
    const result = filterCommandCodeModels(upstream, "max")

    assert.ok(!result.models.some((entry) => entry.id === "vendor/new-unlisted-model"))
    assert.deepEqual(result.unknownModelIds, ["vendor/new-unlisted-model"])
    assert.equal(result.filteredCount, 1)
  })

  it("passes the whole catalog through for the provider plan", () => {
    const withUnknown = [...CATALOG_MODELS, model("vendor/new-unlisted-model")]
    const result = filterCommandCodeModels(withUnknown, "provider")

    assert.equal(result.models.length, withUnknown.length)
    assert.equal(result.filteredCount, 0)
    assert.deepEqual(result.unknownModelIds, [])
  })

  it("treats unknown plans as go-only visibility", () => {
    const result = filterCommandCodeModels(CATALOG_MODELS, "unknown")

    assert.equal(result.models.length, expectedCountAtOrBelow("go"))
    assert.ok(result.models.every((entry) => MODEL_MIN_PLAN[entry.id] === "go"))
  })
})

describe("requiredPlanForModel()", () => {
  it("returns undefined for catalog-external model ids", () => {
    assert.equal(requiredPlanForModel("vendor/not-in-catalog"), undefined)
    assert.equal(requiredPlanForModel("claude-sonnet-5"), "pro")
  })
})

describe("assertCommandCodeModelAllowed()", () => {
  it("allows in-tier models without throwing", () => {
    assert.doesNotThrow(() => assertCommandCodeModelAllowed("deepseek/deepseek-v4-flash", "go"))
    assert.doesNotThrow(() => assertCommandCodeModelAllowed("xai/grok-4.6", "goat"))
    assert.doesNotThrow(() => assertCommandCodeModelAllowed("claude-opus-5", "max"))
    assert.doesNotThrow(() => assertCommandCodeModelAllowed("claude-opus-5", "provider"))
  })

  it("rejects above-tier models with an actionable message", () => {
    assert.throws(
      () => assertCommandCodeModelAllowed("claude-opus-5", "go"),
      /requires the max plan, but the configured plan is go; run \/commandcode-plan or choose another model/,
    )
    assert.throws(() => assertCommandCodeModelAllowed("xai/grok-4.6", "go"), /requires the goat/)
  })

  it("rejects models without verified plan metadata", () => {
    assert.throws(
      () => assertCommandCodeModelAllowed("vendor/not-in-catalog", "max"),
      /no verified plan metadata; refresh the model catalog/,
    )
  })
})
