/**
 * Typed decision answers → snapshot cards.
 *
 * This layer owns meaning: which answers become cards, what each card asserts, and
 * what evidence it carries. It does not talk to a provider and does not know one.
 *
 * Two rules are enforced here rather than trusted:
 *
 *   - **No invented evidence.** A card's citations come only from `locate`
 *     answers. If a question declares `evidence` and the engine returned no span,
 *     the card is emitted as `inferred` — an assertion without provenance — and an
 *     `evidence_missing` problem is recorded. The card is never given a quote it
 *     did not receive.
 *   - **Claim text is harness-rendered.** The engine answers; it does not write.
 *     Any snapshot produced this way is a property of the bank as much as of the
 *     model, which is why cards may not be graded on phrasing.
 */

import { digest } from '../src/canonical.js';
import { HARNESS_VERSION } from '../src/validate.js';
import { DECISIONS_PROVIDER } from '../adapters/decision/interface.js';

function clamp01(value) {
  if (typeof value !== 'number' || Number.isNaN(value)) return null;
  return Math.min(1, Math.max(0, value));
}

function renderClaim(question, answer) {
  const template = String(question.claim ?? '');
  if (answer.type === 'choice') return template.replace(/\{choice\}/g, String(answer.choice));
  if (answer.type === 'score') return template.replace(/\{value\}/g, String(answer.score));
  if (answer.type === 'locate') {
    const quote = answer.spans?.[0]?.quote;
    return quote ? template.replace(/\{quote\}/g, quote) : template;
  }
  return template;
}

/**
 * @returns {{snapshot: object, problems: Array}}
 */
export function assembleSnapshot({ input, bank, answers, usage, adapter, run }) {
  const observations = [];
  const abstentions = [];
  const gaps = [];
  const checks = [];
  const problems = [];
  const threshold = typeof bank.abstain_below === 'number' ? bank.abstain_below : 0.5;

  for (const question of bank.questions) {
    // A locate question supplies evidence; it is not itself an assertion. It has no
    // claim by design and becomes a card only through the question that cites it.
    if (question.type === 'locate') continue;
    const answer = answers[question.name];
    if (!answer) continue;
    const mapsTo = question.maps_to ?? 'observation';

    if (mapsTo === 'gap' || mapsTo === 'check') {
      const text = answer.type === 'choice' ? String(answer.choice) : renderClaim(question, answer);
      if (mapsTo === 'gap') gaps.push({ missing: text, why: question.why ?? 'raised by the question bank' });
      else checks.push({ question: text, settles: [], expected_cost: question.expected_cost ?? 'low' });
      continue;
    }

    if (answer.type === 'noul' && answer.probability < threshold) {
      if (question.abstention) {
        abstentions.push({
          topic: question.topic ?? question.claim,
          reason: `P(yes)=${answer.probability.toFixed(3)} is below ${threshold}`,
        });
      }
      continue;
    }
    if (answer.type === 'choice' && answer.choice === 'none') {
      if (question.abstention) abstentions.push({ topic: question.topic ?? question.claim, reason: 'the engine selected "none"' });
      continue;
    }

    const evidence = question.evidence ? answers[question.evidence] : null;
    const refs = (evidence?.spans ?? []).map(({ score, unicode_span, ...ref }) => ref);
    if (question.evidence && refs.length === 0) {
      problems.push({
        code: 'evidence_missing',
        question: question.name,
        why: `no span was returned for ${question.evidence}; the card is inferred, not cited`,
      });
    }

    const extraction = clamp01(
      answer.type === 'choice' ? answer.confidence : evidence?.spans?.[0]?.score ?? answer.confidence ?? null
    );
    const interpretation = clamp01(answer.type === 'noul' ? answer.probability : answer.type === 'choice' ? answer.confidence : null);

    observations.push({
      oid: question.name,
      claim: renderClaim(question, answer),
      kind: refs.length ? question.kind ?? 'stated' : 'inferred',
      refs,
      confidence: {
        extraction: extraction ?? 0.5,
        interpretation: interpretation ?? 0.5,
      },
    });
  }

  const model = { provider: DECISIONS_PROVIDER, slug: adapter.id };
  if (usage?.input_tokens !== null && usage?.input_tokens !== undefined) model.input_tokens = usage.input_tokens;
  if (usage?.output_tokens !== null && usage?.output_tokens !== undefined) model.output_tokens = usage.output_tokens;
  if (usage?.cost_usd !== null && usage?.cost_usd !== undefined) model.cost_usd = usage.cost_usd;
  if (run?.latency_ms !== undefined) model.latency_ms = run.latency_ms;

  return {
    snapshot: {
      schema: 'gca-snapshot/v1',
      run: { id: run.id, at: run.at, harness_version: HARNESS_VERSION, model },
      input_digest: digest(input),
      observations,
      domains: [],
      gaps,
      checks,
      abstentions,
    },
    problems,
  };
}
