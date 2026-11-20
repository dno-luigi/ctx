/**
 * Three layers, measured separately.
 *
 *   authenticity  — does the quote exist verbatim in the cited source?
 *                   Mechanical: `locate`. This is the only layer the harness
 *                   can settle on its own.
 *   relevance     — does the quote actually support the claim?
 *                   Mechanical only where the operator pre-declared a trap: an
 *                   authentic quote that looks like support but is not. A
 *                   fixture without traps reports `declared: false`, and
 *                   relevance for it stays unmeasured rather than assumed.
 *   inference     — is the conclusion the claim draws valid?
 *                   Not machine-decidable in general. What is reported is the
 *                   kind distribution, a lexical overreach signal on `stated`
 *                   claims, and an adjudication queue naming every observation
 *                   a human has to read. Nothing here is silently scored.
 *
 * The queue is the point. A run that reports relevance and inference as if they
 * had been graded would be overstating what a mechanical harness can know.
 */

import { normalizeClaim } from './canonical.js';
import { locate } from './spans.js';

const STOPWORDS = new Set([
  'the', 'and', 'that', 'this', 'with', 'from', 'for', 'are', 'was', 'were', 'has', 'have', 'had',
  'not', 'but', 'its', 'into', 'than', 'then', 'they', 'their', 'them', 'which', 'while', 'when',
  'what', 'does', 'did', 'only', 'also', 'all', 'any', 'can', 'may', 'will', 'would', 'should',
  'must', 'been', 'being', 'because', 'after', 'before', 'about', 'each', 'more', 'most', 'some',
  'such', 'there', 'these', 'those', 'over', 'under', 'within', 'says', 'said', 'per', 'via',
]);

/** Minimum quote length before a lexical overreach signal is meaningful. */
const MIN_QUOTE_CHARS = 24;
/** Substantive claim terms absent from every quote before a claim is flagged. */
const MIN_OVERREACH_TERMS = 2;

function tokens(text) {
  return new Set(String(text ?? '').toLowerCase().match(/[a-z0-9][a-z0-9'-]*/g) ?? []);
}

/**
 * Claim terms that appear in no cited quote.
 *
 * A blunt instrument, and deliberately so: it flags claims that add substance
 * their evidence does not contain, which is the shape of an unsupported
 * inference. It does not decide whether the inference is wrong.
 */
export function lexicalOverreach(claim, quotes) {
  const quoteText = quotes.join(' ');
  if (quoteText.length < MIN_QUOTE_CHARS) return [];
  const quoteTokens = tokens(quoteText);
  const missing = [...tokens(claim)].filter((token) => token.length >= 4 && !STOPWORDS.has(token) && !quoteTokens.has(token));
  return missing.length >= MIN_OVERREACH_TERMS ? missing : [];
}

/**
 * Every declared trap, in one list.
 *
 * A trap may be attached to a required observation, or declared at the top level
 * of the ground truth with its own `source_id`. The top-level form exists because
 * some fixtures have no required observations at all (F5 expects abstention), and
 * relevance still has to be measurable there.
 */
export function listTraps(groundTruth) {
  const traps = [];
  for (const item of groundTruth?.required ?? []) {
    for (const trap of item?.traps ?? []) {
      if (!trap?.quote) continue;
      traps.push({ id: item.id, source_id: item.source_id, quote: trap.quote, claim: trap.claim ?? null, why: trap.why ?? null });
    }
  }
  for (const trap of groundTruth?.traps ?? []) {
    if (!trap?.quote || !trap?.source_id) continue;
    traps.push({
      id: trap.id ?? 'trap',
      source_id: trap.source_id,
      quote: trap.quote,
      claim: trap.claim ?? null,
      why: trap.why ?? null,
    });
  }
  return traps;
}

export function trapQuotes(groundTruth) {
  const traps = new Map();
  for (const trap of listTraps(groundTruth)) {
    traps.set(normalizeClaim(trap.quote), { required_id: trap.id, why: trap.why });
  }
  return traps;
}

/** Assess one snapshot on all three layers. */
export function assessEvidence({ input, groundTruth, snapshot }) {
  const traps = trapQuotes(groundTruth);
  const summary = {
    refs: { total: 0, authentic: 0, fabricated: 0, ambiguous: 0, image_unverifiable: 0 },
    relevance: { declared: traps.size > 0, trap_citations: [], pass: true },
    inference: {
      kinds: { stated: 0, derived: 0, inferred: 0 },
      derived_without_multiple_refs: 0,
      overreach: [],
    },
    adjudication: [],
  };

  for (const observation of snapshot?.observations ?? []) {
    const kind = observation?.kind;
    if (summary.inference.kinds[kind] !== undefined) summary.inference.kinds[kind] += 1;

    const refs = Array.isArray(observation?.refs) ? observation.refs : [];
    if (kind === 'derived' && refs.length < 2) summary.inference.derived_without_multiple_refs += 1;

    for (const ref of refs) {
      summary.refs.total += 1;
      const found = locate(input, ref);
      if (!found.ok) {
        if (found.reason === 'ambiguous_quote') summary.refs.ambiguous += 1;
        else if (found.reason === 'fabricated_quote' || found.reason === 'invented_source') summary.refs.fabricated += 1;
        continue;
      }
      if (found.verifiable) summary.refs.authentic += 1;
      else summary.refs.image_unverifiable += 1;

      const trap = traps.get(normalizeClaim(ref?.quote));
      if (trap) {
        summary.relevance.trap_citations.push({ oid: observation?.oid ?? null, required_id: trap.required_id });
        summary.relevance.pass = false;
        summary.adjudication.push({
          oid: observation?.oid ?? null,
          claim: observation?.claim ?? null,
          reason: `layer 2: quote is authentic but does not support the claim (trap for ${trap.required_id})${
            trap.why ? ` — ${trap.why}` : ''
          }`,
        });
      }

      if (!found.verifiable) {
        summary.adjudication.push({
          oid: observation?.oid ?? null,
          claim: observation?.claim ?? null,
          reason: 'layer 2: image region cannot be verified as text; needs operator adjudication',
        });
      }
    }

    const missing = lexicalOverreach(observation?.claim, refs.map((ref) => ref?.quote ?? ''));
    if (kind === 'stated' && missing.length > 0) {
      summary.inference.overreach.push({ oid: observation?.oid ?? null, missing });
      summary.adjudication.push({
        oid: observation?.oid ?? null,
        claim: observation?.claim ?? null,
        reason: `layer 3: a stated claim is worded beyond its quotes (${missing.slice(0, 6).join(', ')})`,
      });
    }
  }

  return summary;
}
