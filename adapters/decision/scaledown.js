/**
 * ScaleDown implementation of the decision adapter.
 *
 * ScaleDown is treated as a decision engine, not a chat-completion provider. Its
 * Decisions surface (Jev-shaped, `/api/alpha/decisions` on OpenRouter,
 * `/v1/scaledown` direct) takes `state` plus a map of typed questions and returns
 * typed answers. There is no messages array, no temperature, no max_tokens and no
 * response_format, and this adapter sends none of them.
 *
 * Two facts about this engine shape what the harness can claim:
 *
 *   1. No `locate`. ScaleDown's decisions surface answers choice/noul/score only,
 *      so it returns no spans. Every card it produces is therefore `inferred` —
 *      an assertion without provenance — and expansion proposals that require
 *      evidence are marked `evidence_available: false` rather than silently
 *      accepted. If provenance matters more than price, that is a finding about
 *      the architecture, not a gap in the harness.
 *   2. Only `state.text` / `state.document` are read, so the state is an object,
 *      not a bare string. A multi-field object state would be silently truncated.
 *
 * Field names for a `noul` question are not documented by ScaleDown (their docs
 * describe `criteria` for choice questions only). This adapter sends `instructions`
 * plus, for choice/score, `criteria` — and records the ambiguity in
 * `capabilities.unverified` so a live 400 is diagnosable rather than mysterious.
 */

import { createAdapter } from './interface.js';

export const SCALEDOWN_DEFAULTS = {
  model: 'classify-1',
  request_model: 'scaledown/classify-1',
  endpoint: 'https://openrouter.ai/api/alpha/decisions',
  context_tokens: 1000000,
  input_per_mtok: 0.04,
  output_per_mtok: 0,
};

/**
 * The wire form of `criteria` is per-type and was established by live probe on
 * 2026-11-18, not from documentation:
 *
 *   - `choice`: a **record** of option → plain-string description; the answer's
 *     `choice` is one of its keys. An array is rejected with HTTP 400.
 *   - `score`: an **array**; a record is rejected with HTTP 400.
 *   - `noul`: no criteria at all (instructions only). If present it must be
 *     `{ true: string, false: string }`.
 *
 * The canonical bank keeps options as an array, so the bank schema does not depend
 * on one vendor's wire format. This function is the only place that difference
 * exists.
 */
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

/**
 * @param {object} [descriptor] an entry from deciders.json; takes precedence over
 *   the built-in defaults so the verified catalogue stays the single source of truth.
 */
export function createScaleDown(descriptor = {}) {
  const model = descriptor.request_model ?? SCALEDOWN_DEFAULTS.request_model;
  const endpoint = descriptor.endpoint ?? SCALEDOWN_DEFAULTS.endpoint;
  const pricing = descriptor.pricing ?? { input_per_mtok: SCALEDOWN_DEFAULTS.input_per_mtok, output_per_mtok: SCALEDOWN_DEFAULTS.output_per_mtok };

  return createAdapter({
    id: descriptor.id ?? 'scaledown/classify-1',
    vendor: 'ScaleDown',
    dialect: 'jev',
    capabilities: {
      question_types: ['noul', 'choice', 'score'],
      locate: false,
      context_tokens: descriptor.context_tokens ?? SCALEDOWN_DEFAULTS.context_tokens,
      state_form: 'object_text',
      state_reads: ['state.text', 'state.document'],
      modalities: descriptor.modalities ?? ['text', 'image', 'file'],
      max_questions: null,
      max_locate: 0,
      determinism: descriptor.determinism ?? { temperature: false, seed: false },
      pricing: { ...pricing, billing: pricing.billing ?? 'per_question_internal_calls' },
      // Verified against the live endpoint on 2026-11-18: a noul question needs only
      // `instructions`, choice needs a criteria record and score a criteria array.
      wire_criteria: { choice: 'record', score: 'array', noul: 'absent' },
      verified_at: '2026-11-18',
      unverified: [],
    },
    buildRequest({ state, questions }) {
      return {
        endpoint,
        headers: {},
        body: {
          model,
          // Object form: this engine reads state.text only.
          state: { text: state.text },
          questions: mapQuestions(questions),
        },
      };
    },
    extract(body) {
      return {
        rawAnswers: body?.answers ?? null,
        rawUsage: body?.usage ?? null,
        native: body,
      };
    },
  });
}
