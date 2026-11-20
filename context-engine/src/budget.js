/**
 * Partition budget resolution.
 *
 * A 1M-token window is not a 1M-token prompt: room is left for the response, the safety ratio keeps
 * the estimate away from the hard edge, and an operator ceiling may be lower than both. The budget is
 * therefore *derived*, and every derivation is reported — including when an explicit request was
 * clamped, because silently ignoring `--partition-tokens` would make a run look like it used a number
 * it did not use.
 *
 * When a model declares no context length (the stub scanner), the fallback is the conservative
 * default. Partitioning is the fallback, never an error: `partitionSources` splits at this budget and
 * records every split.
 *
 * All token numbers here are `ceil(chars/4)` planning figures. They never become cost results.
 */

export const DEFAULT_PARTITION_POLICY = {
  safety_ratio: 0.75,
  output_reserve_tokens: 4000,
  hard_ceiling_tokens: 400000,
  fallback_tokens: 60000,
  minimum_tokens: 1000,
};

const num = (value, fallback) => (typeof value === 'number' && Number.isFinite(value) ? value : fallback);

/**
 * @param {{policy?: object, model?: {context_tokens?: number}|null, requestedTokens?: number|null}} options
 * @returns {{budget_tokens: number, ceiling_tokens: number|null, context_tokens: number|null,
 *            usable_tokens: number|null, safety_ratio: number, output_reserve_tokens: number,
 *            source: 'requested'|'requested_clamped'|'model_context'|'fallback',
 *            notes: string[]}}
 */
export function resolvePartitionBudget({ policy = {}, model = null, requestedTokens = null } = {}) {
  const merged = { ...DEFAULT_PARTITION_POLICY, ...policy };
  const context = num(model?.context_tokens, null);
  const safetyRatio = num(merged.safety_ratio, DEFAULT_PARTITION_POLICY.safety_ratio);
  const outputReserve = num(merged.output_reserve_tokens, DEFAULT_PARTITION_POLICY.output_reserve_tokens);
  const hardCeiling = num(merged.hard_ceiling_tokens, DEFAULT_PARTITION_POLICY.hard_ceiling_tokens);
  const minimum = num(merged.minimum_tokens, DEFAULT_PARTITION_POLICY.minimum_tokens);
  const fallback = num(merged.fallback_tokens, DEFAULT_PARTITION_POLICY.fallback_tokens);
  const notes = [];

  const usable = context === null ? null : Math.max(minimum, Math.floor(context * safetyRatio) - outputReserve);
  const effectiveCeiling = usable === null ? hardCeiling : Math.min(hardCeiling, usable);
  if (context !== null && usable < Math.floor(context * safetyRatio)) {
    notes.push(`output reserve of ${outputReserve} tokens subtracted from ${context} context tokens`);
  }
  if (usable !== null && hardCeiling < usable) {
    notes.push(`operator ceiling ${hardCeiling} is below the model's usable ${usable}; ceiling applies`);
  }

  // The ceiling is the real limit: a request below the model's usable window but above the ceiling
  // would otherwise quietly exceed the operator's cap.
  const maxAllowed = usable === null ? hardCeiling : Math.min(hardCeiling, usable);

  if (requestedTokens !== null && requestedTokens !== undefined) {
    const requested = Math.max(minimum, Math.floor(requestedTokens));
    if (requested > maxAllowed) {
      notes.push(
        requested > hardCeiling
          ? `requested ${requested} exceeds the operator ceiling ${hardCeiling}; clamped`
          : `requested ${requested} exceeds the usable ${usable}; clamped`
      );
      return { budget_tokens: maxAllowed, ceiling_tokens: effectiveCeiling, context_tokens: context, usable_tokens: usable, safety_ratio: safetyRatio, output_reserve_tokens: outputReserve, source: 'requested_clamped', notes };
    }
    return { budget_tokens: requested, ceiling_tokens: effectiveCeiling, context_tokens: context, usable_tokens: usable, safety_ratio: safetyRatio, output_reserve_tokens: outputReserve, source: 'requested', notes };
  }

  if (usable !== null) {
    return { budget_tokens: maxAllowed, ceiling_tokens: effectiveCeiling, context_tokens: context, usable_tokens: usable, safety_ratio: safetyRatio, output_reserve_tokens: outputReserve, source: 'model_context', notes };
  }

  notes.push('model declares no context length; using the conservative fallback budget');
  return { budget_tokens: Math.min(fallback, hardCeiling), ceiling_tokens: effectiveCeiling, context_tokens: null, usable_tokens: null, safety_ratio: safetyRatio, output_reserve_tokens: outputReserve, source: 'fallback', notes };
}

/** Explicit strategy: a whole-subject pass when it fits, partitioning when it does not. */
export function chooseStrategy({ estimatedTokens, budgetTokens, partitions = null }) {
  if (estimatedTokens <= budgetTokens) {
    return { mode: 'single_pass', reason: `estimated ${estimatedTokens} tokens fits the ${budgetTokens}-token budget`, headroom_tokens: budgetTokens - estimatedTokens };
  }
  return {
    mode: 'partitioned',
    reason: `estimated ${estimatedTokens} tokens exceeds the ${budgetTokens}-token budget`,
    headroom_tokens: 0,
    partitions: partitions ?? null,
  };
}
