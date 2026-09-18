import { MODEL_MIN_PLAN } from "./commandcode-plan-catalog.ts"
import {
  filterPlanFor,
  planAllows,
  type EffectivePlan,
  type SubscriptionPlan,
} from "./plan-types.ts"
import type { CommandCodeModel } from "./models.ts"

export interface FilteredModelsResult {
  models: readonly CommandCodeModel[]
  filteredCount: number
  unknownModelIds: readonly string[]
}

export function filterCommandCodeModels(
  models: readonly CommandCodeModel[],
  effectivePlan: EffectivePlan,
): FilteredModelsResult {
  const filterPlan = filterPlanFor(effectivePlan)
  if (filterPlan === "provider") {
    return { models, filteredCount: 0, unknownModelIds: [] }
  }

  const unknownModelIds: string[] = []
  const available = models.filter((model) => {
    const requiredPlan = MODEL_MIN_PLAN[model.id]
    if (!requiredPlan) {
      unknownModelIds.push(model.id)
      return false
    }
    return planAllows(requiredPlan, effectivePlan)
  })

  return {
    models: available,
    filteredCount: models.length - available.length,
    unknownModelIds,
  }
}

export function requiredPlanForModel(modelId: string): SubscriptionPlan | undefined {
  return MODEL_MIN_PLAN[modelId]
}

export function assertCommandCodeModelAllowed(modelId: string, effectivePlan: EffectivePlan): void {
  const requiredPlan = requiredPlanForModel(modelId)
  if (!requiredPlan) {
    throw new Error(
      `Command Code model "${modelId}" has no verified plan metadata; refresh the model catalog before using it`,
    )
  }
  if (!planAllows(requiredPlan, effectivePlan)) {
    throw new Error(
      `Command Code model "${modelId}" requires the ${requiredPlan} plan, but the configured plan is ${effectivePlan}; run /commandcode-plan or choose another model`,
    )
  }
}
