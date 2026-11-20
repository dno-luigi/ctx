/**
 * Perplexity implementation of the decision adapter.
 *
 * Included now, before it is needed, because the point of the interface is that a
 * second provider does not reshape the snapshot architecture. It differs from
 * ScaleDown in exactly two ways, and both are contained here:
 *
 *   - `state` is a bare string (or array), not an object with a `text` field
 *   - v1.3 serves `locate`, so cards can carry spans and proposals can require
 *     evidence
 *
 * Everything else — typed answers, usage, problems, assembly — is shared.
 */

import { createAdapter } from './interface.js';

export const PERPLEXITY_DEFAULTS = {
  request_model: 'perplexity/pplx-decider-v1.2',
  endpoint: 'https://openrouter.ai/api/alpha/decisions',
  context_tokens: 262144,
  input_per_mtok: 0.02,
  output_per_mtok: 0,
};

/** Same per-type wire form as ScaleDown; see the note in scaledown.js. */
function wireCriteria(question) {
  const criteria = question.criteria;
  if (!Array.isArray(criteria)) return criteria;
  if (question.type === 'choice') {
    return Object.fromEntries(criteria.map((option) => [String(option), String(option)]));
  }
  return criteria;
}

function mapQuestions(questions) {
  const mapped = {};
  for (const question of questions) {
    const instructions = question.instructions ?? question.claim;
    mapped[question.name] =
      question.type === 'choice' || question.type === 'score'
        ? { type: question.type, instructions, criteria: wireCriteria(question) }
        : { type: question.type, instructions };
  }
  return mapped;
}

export function createPerplexity(descriptor = {}) {
  // `served_types` is what the live endpoint accepts; `questions.types` is what the
  // catalogue declared. The live contract (probed 2026-11-18) has no `locate`
  // discriminator at all and refuses `box`, so no Perplexity endpoint can return a
  // text span. Capability is read from what is served, falling back to the declared
  // list only for a descriptor that has not been probed.
  const types = descriptor.served_types ?? descriptor.questions?.types ?? [];
  const locate = types.includes('locate');
  const pricing = descriptor.pricing ?? {
    input_per_mtok: PERPLEXITY_DEFAULTS.input_per_mtok,
    output_per_mtok: PERPLEXITY_DEFAULTS.output_per_mtok,
  };

  return createAdapter({
    id: descriptor.id ?? 'perplexity/pplx-decider-v1.2',
    vendor: 'Perplexity',
    dialect: 'perplexity',
    capabilities: {
      question_types: locate ? ['noul', 'choice', 'score', 'locate'] : ['noul', 'choice', 'score'],
      locate,
      context_tokens: descriptor.context_tokens ?? PERPLEXITY_DEFAULTS.context_tokens,
      state_form: 'string',
      state_reads: ['state'],
      served_types: types,
      text_evidence: locate ? 'available' : 'unavailable on this endpoint (no locate discriminator; box refused)',
      modalities: descriptor.modalities ?? ['text', 'image'],
      max_questions: null,
      max_locate: locate ? descriptor.questions?.max_locate ?? 128 : 0,
      // Documented by the vendor: state plus any one question must stay under 256K,
      // and questions that do not fit are answered in groups that re-count the state.
      state_plus_question_ceiling: descriptor.questions?.state_plus_question_ceiling ?? 262144,
      determinism: descriptor.determinism ?? { temperature: false, seed: false },
      pricing: { ...pricing, billing: pricing.billing ?? 'per_group' },
    },
    buildRequest({ state, questions }) {
      return {
        endpoint: descriptor.endpoint ?? PERPLEXITY_DEFAULTS.endpoint,
        headers: {},
        body: { model: descriptor.request_model ?? PERPLEXITY_DEFAULTS.request_model, state: state.text, questions: mapQuestions(questions) },
      };
    },
    extract(body) {
      return { rawAnswers: body?.answers ?? null, rawUsage: body?.usage ?? null, native: body };
    },
  });
}
