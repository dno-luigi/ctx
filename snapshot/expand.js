/**
 * Expansion: what the first pass did not cover, and how to test whether it should.
 *
 * A closed-set decision engine cannot write a proposal — it answers questions. So
 * proposals are **derived by the harness from native outputs** and the engine is
 * then asked whether each one is supported. That ordering matters: the harness
 * names the candidate, and the engine decides. The reverse would be the engine
 * writing cards, which the interface cannot do and the architecture must not fake.
 *
 * Recursion is refused structurally, not by convention: `MAX_PASSES = 1`, and
 * `planSecondPass` throws for any pass above it. Proposals produced by a second
 * pass are therefore not evaluable, which is what "one additional pass" means.
 *
 * Two expansion sources exist and only one is implemented:
 *
 *   - **native outputs** (implemented): unclaimed `locate` spans, low-confidence
 *     choices, ambiguous probabilities.
 *   - **a neutral inventory** (absent): a rule-based scan of the corpus. It is the
 *     only way an engine without `locate` can be asked about structure nobody
 *     thought to ask about, and it is exactly the unapproved decision D0 in
 *     REVIEW-01. Until then `expansion_sources.inventory` reads `absent`, and the
 *     consequence is reported rather than hidden.
 */

import { PROPOSAL_SCHEMA } from '../adapters/decision/validate.js';

/** One additional decision pass. Not a tunable. */
export const MAX_PASSES = 1;

const STOPWORDS = new Set([
  'the', 'and', 'that', 'this', 'with', 'from', 'for', 'are', 'was', 'were', 'has', 'have', 'not', 'but',
  'its', 'into', 'than', 'then', 'they', 'their', 'which', 'while', 'when', 'what', 'does', 'did', 'only',
  'also', 'all', 'any', 'can', 'may', 'will', 'would', 'should', 'must', 'been', 'being', 'because',
]);

function tokens(text) {
  return new Set(String(text ?? '').toLowerCase().match(/[a-z0-9][a-z0-9'-]*/g) ?? []);
}

function claimKeyOf(ref) {
  return ref?.span ? `${ref.source_id}|${ref.span.start}:${ref.span.end}` : `${ref?.source_id}|${ref?.quote}`;
}

function proposalId(type, index) {
  return `${type}_${index}`;
}

/**
 * @returns {{proposals: object[], stats: object}}
 */
export function deriveProposals({ bank, answers, snapshot, limit = 25, lowBand = [0.35, 0.7] }) {
  const proposals = [];
  const claimed = new Set(
    (snapshot?.observations ?? []).flatMap((observation) => (observation.refs ?? []).map(claimKeyOf))
  );
  const askedQuestions = new Set(bank.questions.map((question) => question.name));
  const seen = new Set();
  let duplicates = 0;

  const push = (proposal) => {
    const key = proposal.question.trim().toLowerCase();
    if (seen.has(key)) {
      duplicates += 1;
      return false;
    }
    seen.add(key);
    proposals.push(proposal);
    return true;
  };

  // Rule 1: spans the engine returned that no card used. The engine found something
  // it was not asked to assert; that is the cheapest honest source of new cards.
  for (const question of bank.questions) {
    const answer = answers[question.name];
    if (answer?.type !== 'locate') continue;
    for (const span of answer.spans) {
      const ref = { source_id: span.source_id, quote: span.quote, span: span.span };
      if (claimed.has(claimKeyOf(ref))) continue;
      push({
        id: proposalId('claim', proposals.length),
        type: 'claim',
        title: `Unclaimed passage in ${span.source_id}: ${span.quote.slice(0, 60)}`,
        reason: `the engine located this passage while answering ${question.name}, but no card cites it`,
        question: `Does the passage "${span.quote.slice(0, 80)}" state something the snapshot should assert?`,
        priority: 'medium',
        evidence_required: true,
        evidence_available: true,
        candidates: [ref],
        origin: 'unclaimed_locate_span',
      });
    }
  }

  // Rule 2: a classification the engine was not confident about. The card exists,
  // but the alternative may need a discriminating question.
  for (const question of bank.questions) {
    const answer = answers[question.name];
    if (answer?.type !== 'choice' || answer.confidence === null) continue;
    if (answer.confidence < lowBand[0] || answer.confidence > lowBand[1]) continue;
    push({
      id: proposalId('unresolved_question', proposals.length),
      type: 'unresolved_question',
      title: `Low confidence on ${question.name}`,
      reason: `confidence ${answer.confidence.toFixed(3)} sits between a decision and a guess; the alternatives are ${(question.criteria ?? []).join(', ')}`,
      question: `Is the classification "${answer.choice}" for ${question.name} certain enough to rely on?`,
      priority: 'high',
      evidence_required: false,
      evidence_available: true,
      candidates: [],
      origin: 'low_confidence_choice',
    });
  }

  // Rule 3: an answer that is neither yes nor no.
  for (const question of bank.questions) {
    const answer = answers[question.name];
    if (answer?.type !== 'noul') continue;
    if (answer.probability <= 0.4 || answer.probability >= 0.6) continue;
    push({
      id: proposalId('unresolved_question', proposals.length),
      type: 'unresolved_question',
      title: `Ambiguous probability on ${question.name}`,
      reason: `P(yes)=${answer.probability.toFixed(3)} is indistinguishable from a coin flip`,
      question: `Does the source settle the question asked by ${question.name} at all?`,
      priority: 'high',
      evidence_required: false,
      evidence_available: true,
      candidates: [],
      origin: 'ambiguous_probability',
    });
  }

  // Rule 4: two cards citing different sources that share a rare term. Cheap
  // relationship detector, and honest about its basis: it can only fire on quoted
  // evidence, so an engine without `locate` never produces one.
  const byToken = new Map();
  for (const observation of snapshot?.observations ?? []) {
    for (const ref of observation.refs ?? []) {
      for (const token of tokens(ref.quote)) {
        if (token.length < 6 || STOPWORDS.has(token)) continue;
        if (!byToken.has(token)) byToken.set(token, new Set());
        byToken.get(token).add(ref.source_id);
      }
    }
  }
  for (const [token, sources] of byToken) {
    if (sources.size < 2) continue;
    const [a, b] = [...sources].sort();
    push({
      id: proposalId('relationship', proposals.length),
      type: 'relationship',
      title: `Possible relationship between ${a} and ${b} via "${token}"`,
      reason: `both sources quote the rare term "${token}"; no card states how they relate`,
      question: `Do ${a} and ${b} describe the same "${token}", and if so how are they related?`,
      priority: 'medium',
      evidence_required: true,
      evidence_available: true,
      candidates: [],
      origin: 'cross_source_shared_term',
    });
  }

  const truncated = Math.max(0, proposals.length - limit);
  const kept = proposals.slice(0, limit);
  return {
    proposals: kept,
    stats: {
      derived: proposals.length,
      kept: kept.length,
      truncated,
      duplicates_removed: duplicates,
      unasked_questions: [...askedQuestions].length,
      by_origin: kept.reduce((counts, proposal) => ({ ...counts, [proposal.origin]: (counts[proposal.origin] ?? 0) + 1 }), {}),
    },
  };
}

/**
 * Turn accepted proposals into the single additional decision pass.
 * Throws above MAX_PASSES: recursion is a design error here, not a parameter.
 */
export function planSecondPass({ proposals, adapter, pass = 1, maxQuestions = 25 }) {
  if (pass > MAX_PASSES) {
    throw new Error(`expansion is limited to ${MAX_PASSES} additional pass; pass ${pass} would recurse`);
  }
  const askable = proposals.filter((proposal) => proposal.type !== 'investigation');
  const accepted = askable.slice(0, maxQuestions);
  const rejected = [
    ...proposals.filter((proposal) => proposal.type === 'investigation'),
    ...askable.slice(maxQuestions),
  ];

  const questions = accepted.map((proposal, index) => ({
    name: `p_${index + 1}`,
    type: 'noul',
    instructions: proposal.question,
    claim: proposal.title,
    kind: 'inferred',
  }));

  return {
    pass,
    bank: {
      schema: 'gca-questions/v1',
      bank_version: `expansion-${pass}`,
      fixture: 'expansion',
      authored_from: 'harness rules over pass-1 decision outputs',
      grounded_in_answer_key: false,
      abstain_below: 0.5,
      questions,
    },
    accepted,
    rejected,
    evidence_available: adapter.supportsLocate(),
    evidence_required_but_unavailable: adapter.supportsLocate() ? 0 : accepted.filter((proposal) => proposal.evidence_required).length,
  };
}

/** Verdicts for one proposal each. 0.6/0.4 are provisional and unauthorised. */
export function evaluateSecondPass({ plan, answers }) {
  const verdicts = plan.accepted.map((proposal, index) => {
    const answer = answers[`p_${index + 1}`];
    const probability = answer?.type === 'noul' ? answer.probability : null;
    const verdict = probability === null ? 'missing' : probability >= 0.6 ? 'supported' : probability <= 0.4 ? 'unsupported' : 'indeterminate';
    return { proposal, probability, verdict };
  });
  return {
    verdicts,
    stats: {
      evaluated: verdicts.length,
      supported: verdicts.filter((entry) => entry.verdict === 'supported').length,
      unsupported: verdicts.filter((entry) => entry.verdict === 'unsupported').length,
      indeterminate: verdicts.filter((entry) => entry.verdict === 'indeterminate').length,
      missing: verdicts.filter((entry) => entry.verdict === 'missing').length,
    },
  };
}

/**
 * Expansion metrics. `incremental_completeness` is deliberately null: measuring
 * completeness needs a model-independent inventory, which does not exist yet.
 * Reporting a number here would be inventing the very instrument REVIEW-01 says
 * is missing.
 */
export function expansionReport({ derived, plan, secondPass, usage, inventory = null }) {
  const supportedCards = secondPass.verdicts.filter(
    (entry) => entry.verdict === 'supported' && ['claim', 'relationship'].includes(entry.proposal.type)
  );
  return {
    schema: PROPOSAL_SCHEMA,
    passes: plan.pass,
    recursion: `refused above ${MAX_PASSES} pass`,
    expansion_sources: {
      native_outputs: derived.stats.kept,
      inventory: inventory ? inventory.length : 'absent (D0 undecided; see REVIEW-01)',
    },
    proposals: {
      derived: derived.stats.derived,
      asked: plan.accepted.length,
      rejected: plan.rejected.length,
      truncated: derived.stats.truncated,
      by_origin: derived.stats.by_origin,
    },
    second_pass: secondPass.stats,
    new_relationships: secondPass.verdicts.filter(
      (entry) => entry.verdict === 'supported' && entry.proposal.type === 'relationship'
    ).length,
    additional_questions: plan.accepted.length,
    additional_cards: supportedCards.length,
    evidence: {
      adapter_supports_locate: plan.evidence_available,
      proposals_requiring_unavailable_evidence: plan.evidence_required_but_unavailable,
    },
    incremental_cost_usd: usage?.cost_usd ?? null,
    incremental_cost_per_supported_card:
      usage?.cost_usd !== null && usage?.cost_usd !== undefined && supportedCards.length
        ? Number((usage.cost_usd / supportedCards.length).toFixed(6))
        : null,
    incremental_completeness: null,
    incremental_completeness_reason:
      'no model-independent structure inventory exists yet; completeness cannot be measured from proposals alone',
  };
}
