/**
 * Validation of the instrument, not of the model.
 *
 * A bank is part of the experiment: a bank authored from the answer key makes
 * coverage meaningless, so `grounded_in_answer_key: false` is required and checked
 * structurally. Capability limits (context, question types, locate count) are read
 * from the adapter, so a bank cannot ask a question the engine cannot answer.
 */

import { buildState, estimateTokens } from './interface.js';

export const BANK_SCHEMA = 'gca-questions/v1';
export const PROPOSAL_SCHEMA = 'gca-proposals/v1';

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function validateBank(bank, { adapter, input } = {}) {
  const errors = [];
  if (!isObject(bank)) return { ok: false, errors: ['bank is not an object'], stats: null };

  if (bank.schema !== BANK_SCHEMA) errors.push(`schema: expected ${BANK_SCHEMA}, got ${bank.schema}`);
  if (!bank.bank_version) errors.push('bank_version is required');
  if (!bank.fixture) errors.push('fixture is required');
  if (typeof bank.authored_from !== 'string' || !bank.authored_from.trim()) {
    errors.push('authored_from is required: say what the bank was authored from');
  }
  if (bank.grounded_in_answer_key !== false) {
    errors.push('grounded_in_answer_key must be exactly false: a bank derived from the answer key makes coverage meaningless');
  }
  if (!Array.isArray(bank.questions) || bank.questions.length === 0) {
    return { ok: false, errors: [...errors, 'questions must be a non-empty array'], stats: null };
  }

  const supported = adapter?.capabilities?.question_types ?? [];
  const names = new Set();
  for (const [index, question] of bank.questions.entries()) {
    const path = `questions[${index}]`;
    if (!question?.name) errors.push(`${path}.name is required`);
    else if (names.has(question.name)) errors.push(`${path}.name is duplicated: ${question.name}`);
    else names.add(question.name);

    if (!question?.claim) errors.push(`${path}.claim is required`);
    if (!supported.includes(question?.type)) {
      errors.push(`${path}.type "${question?.type}" is not supported by ${adapter?.id ?? 'this adapter'} (supports: ${supported.join(', ') || 'none'})`);
    }
    if (question?.kind && !['stated', 'derived', 'inferred'].includes(question.kind)) {
      errors.push(`${path}.kind must be stated, derived or inferred`);
    }
    if (question?.evidence) {
      const evidence = bank.questions.find((other) => other.name === question.evidence);
      if (!evidence || evidence.type !== 'locate') errors.push(`${path}.evidence must name a locate question in this bank`);
    }
    if ((question?.type === 'choice' || question?.type === 'score') && (!Array.isArray(question.criteria) || question.criteria.length < 2)) {
      errors.push(`${path}.criteria must have at least 2 entries`);
    }
  }

  const locateCount = bank.questions.filter((question) => question.type === 'locate').length;
  const maxLocate = adapter?.capabilities?.max_locate ?? 0;
  if (locateCount > maxLocate) {
    errors.push(`bank asks ${locateCount} locate question(s); ${adapter?.id ?? 'this adapter'} supports ${maxLocate}`);
  }

  const state = input ? buildState(input) : null;
  const stateTokens = state ? estimateTokens(state.text) : null;
  const context = adapter?.capabilities?.context_tokens;
  if (stateTokens !== null && context && stateTokens > context) {
    errors.push(`state ~${stateTokens} tokens exceeds ${adapter.id} context of ${context}`);
  }
  const ceiling = adapter?.capabilities?.state_plus_question_ceiling;
  if (stateTokens !== null && ceiling && stateTokens >= ceiling) {
    errors.push(`state ~${stateTokens} tokens is at or above the ${ceiling}-token per-question ceiling of ${adapter.id}`);
  }
  if (locateCount > 0 && (input?.sources ?? []).some((source) => source.kind === 'image')) {
    errors.push('locate questions require a text-only state; this input contains an image');
  }

  return {
    ok: errors.length === 0,
    errors,
    stats: {
      questions: bank.questions.length,
      locate: locateCount,
      state_chars: state ? state.text.length : null,
      state_tokens_est: stateTokens,
      token_estimate: 'chars/4 — pre-flight only, never used for cost',
    },
  };
}

/**
 * Expansion proposals are harness-owned. The model does not emit this format; the
 * rules in snapshot/expand.js derive it from native decision outputs, and the
 * second pass is what decides whether each proposal survives.
 */
export function validateProposalSet(set) {
  const errors = [];
  if (!isObject(set)) return { ok: false, errors: ['proposal set is not an object'] };
  if (set.schema !== PROPOSAL_SCHEMA) errors.push(`schema: expected ${PROPOSAL_SCHEMA}, got ${set.schema}`);
  if (!Array.isArray(set.proposals)) return { ok: false, errors: [...errors, 'proposals must be an array'] };

  const types = ['relationship', 'claim', 'unresolved_question', 'investigation'];
  const priorities = ['high', 'medium', 'low'];
  const ids = new Set();
  set.proposals.forEach((proposal, index) => {
    const path = `proposals[${index}]`;
    if (!proposal?.id) errors.push(`${path}.id is required`);
    else if (ids.has(proposal.id)) errors.push(`${path}.id is duplicated: ${proposal.id}`);
    else ids.add(proposal.id);
    if (!types.includes(proposal?.type)) errors.push(`${path}.type must be one of ${types.join(', ')}`);
    if (!proposal?.title) errors.push(`${path}.title is required`);
    if (!proposal?.reason) errors.push(`${path}.reason is required`);
    if (!proposal?.question) errors.push(`${path}.question is required`);
    if (!priorities.includes(proposal?.priority)) errors.push(`${path}.priority must be high, medium or low`);
    if (typeof proposal?.evidence_required !== 'boolean') errors.push(`${path}.evidence_required must be boolean`);
    if (!proposal?.origin) errors.push(`${path}.origin is required: which rule produced it`);
  });

  return { ok: errors.length === 0, errors };
}
