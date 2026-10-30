const THINKING_BINDING_CONTROLS_BETA = "thinking-binding-controls-2026-08-01"

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** Let the server discard historical signed thinking blocks bound to a different prefix. */
export function allowThinkingPrefixMismatch(payload: unknown): Record<string, unknown> | undefined {
  if (!isRecord(payload) || !isRecord(payload.thinking) || payload.thinking.type !== "adaptive") {
    return undefined
  }

  const betas = Array.isArray(payload.betas)
    ? payload.betas.filter((value): value is string => typeof value === "string")
    : []
  return {
    ...payload,
    betas: betas.includes(THINKING_BINDING_CONTROLS_BETA)
      ? betas
      : [...betas, THINKING_BINDING_CONTROLS_BETA],
    thinking: {
      ...payload.thinking,
      block_binding: { prefix_mismatch_behavior: "drop_block" },
    },
  }
}
