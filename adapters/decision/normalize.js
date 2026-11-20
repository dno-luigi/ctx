/**
 * Provider-independent response normalisation.
 *
 * The provider only says where its fields are (`extract`). Everything that gives
 * an answer meaning is here: range checks, probability normalisation, span
 * verification against the state, and usage accounting.
 *
 * Nothing is repaired. Every deviation becomes an entry in `problems`, because a
 * span whose text does not match the state, or probabilities that do not sum to 1,
 * are findings about the model. Silently fixing them would erase the result.
 *
 * The native response is preserved verbatim alongside the normalised form: it is
 * the audit trail, and it means the assembler can be improved without paying for
 * the same calls again.
 */

import { spanToRef } from './interface.js';

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** Usage is read from the provider, or reported as absent. Never estimated. */
export function readUsage(rawUsage, pricing, problems) {
  const usage = isObject(rawUsage) ? rawUsage : {};
  const aliased = usage.input_tokens === undefined && usage.prompt_tokens !== undefined;
  const input = usage.input_tokens ?? usage.prompt_tokens;
  const output = usage.output_tokens ?? usage.completion_tokens;

  if (aliased) problems.push({ code: 'usage_field_alias', field: 'prompt_tokens' });
  if (typeof input !== 'number') {
    problems.push({
      code: 'usage_missing',
      why: 'the response reported no input tokens; cost is reported as unknown rather than estimated',
    });
    return { input_tokens: null, output_tokens: null, cost_usd: null, source: 'absent', cost_source: 'absent', cost_details: null };
  }
  const out = typeof output === 'number' ? output : 0;
  const catalogue = (input * (pricing?.input_per_mtok ?? 0) + out * (pricing?.output_per_mtok ?? 0)) / 1e6;
  // The endpoint reports its own charge in `usage.cost`. That is the authoritative
  // figure for a cost result; the catalogue product is kept alongside it so a price
  // drift between the two is visible rather than averaged away.
  const providerCost = typeof usage.cost === 'number' ? usage.cost : null;
  return {
    input_tokens: input,
    output_tokens: out,
    cost_usd: providerCost ?? catalogue,
    catalogue_cost_usd: Number(catalogue.toFixed(12)),
    cost_source: providerCost !== null ? 'provider' : 'catalogue',
    cost_details: isObject(usage.cost_details) ? usage.cost_details : null,
    source: aliased ? 'alias' : 'reported',
  };
}

function normaliseNoul(answer, question, problems) {
  if (typeof answer.noul !== 'number' || Number.isNaN(answer.noul) || answer.noul < 0 || answer.noul > 1) {
    problems.push({ code: 'noul_out_of_range', question: question.name });
    return null;
  }
  return { type: 'noul', probability: answer.noul };
}

function normaliseChoice(answer, question, problems) {
  const criteria = question.criteria ?? [];
  const probabilities = isObject(answer.probabilities) ? answer.probabilities : {};
  const unknown = Object.keys(probabilities).filter((key) => !criteria.includes(key));
  if (unknown.length) problems.push({ code: 'choice_option_unknown', question: question.name, unknown });
  const keys = Object.keys(probabilities);
  if (keys.length) {
    const sum = keys.reduce((total, key) => total + Number(probabilities[key] ?? 0), 0);
    if (Math.abs(sum - 1) > 1e-3) problems.push({ code: 'probabilities_not_normalised', question: question.name, sum });
  }
  if (!criteria.includes(answer.choice)) problems.push({ code: 'choice_outside_criteria', question: question.name });
  return {
    type: 'choice',
    choice: answer.choice,
    confidence: typeof answer.confidence === 'number' ? answer.confidence : null,
    probabilities,
  };
}

function normaliseScore(answer, question, problems) {
  if (typeof answer.score !== 'number' || Number.isNaN(answer.score)) {
    problems.push({ code: 'score_not_a_number', question: question.name });
    return null;
  }
  return {
    type: 'score',
    score: answer.score,
    confidence: typeof answer.confidence === 'number' ? answer.confidence : null,
    probabilities: isObject(answer.probabilities) ? answer.probabilities : {},
  };
}

function normaliseLocate(answer, question, state, problems) {
  if (!Array.isArray(answer.spans)) {
    problems.push({ code: 'locate_spans_not_array', question: question.name });
    return { type: 'locate', spans: [], returned: 0 };
  }
  const spans = [];
  for (const span of answer.spans) {
    const mapped = spanToRef({ state, span });
    if (!mapped.ok) {
      problems.push({ code: mapped.reason, question: question.name });
      continue;
    }
    spans.push({
      ...mapped.ref,
      score: typeof span.score === 'number' ? span.score : null,
      unicode_span: { start: span.start, end: span.end },
    });
  }
  return { type: 'locate', spans, returned: answer.spans.length };
}

/**
 * @returns {{answers, usage, problems, native, question_multiplier}}
 */
export function normaliseResponse({ adapter, body, bank, state }) {
  const problems = [];
  const answers = {};
  const extracted = adapter.extract(body);
  const rawAnswers = isObject(extracted.rawAnswers) ? extracted.rawAnswers : null;
  if (!rawAnswers) problems.push({ code: 'answers_missing' });

  for (const question of bank.questions) {
    const answer = rawAnswers?.[question.name];
    if (!isObject(answer)) {
      problems.push({ code: 'answer_missing', question: question.name });
      continue;
    }
    if (answer.type !== question.type) {
      problems.push({ code: 'answer_type_mismatch', question: question.name, expected: question.type, got: answer.type });
    }

    const normalised =
      question.type === 'noul'
        ? normaliseNoul(answer, question, problems)
        : question.type === 'choice'
        ? normaliseChoice(answer, question, problems)
        : question.type === 'score'
        ? normaliseScore(answer, question, problems)
        : normaliseLocate(answer, question, state, problems);

    if (normalised) answers[question.name] = normalised;
  }

  const usage = readUsage(extracted.rawUsage, adapter.capabilities.pricing, problems);
  const multiplier =
    usage.input_tokens !== null
      ? Number((usage.input_tokens / Math.max(1, Math.ceil(String(state?.text ?? '').length / 4))).toFixed(3))
      : null;

  return { answers, usage, problems, native: extracted.native, question_multiplier: multiplier };
}
