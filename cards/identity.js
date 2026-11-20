/**
 * Deterministic card identity and provenance.
 *
 * Identity is **content-addressed and assigned by assembly**, never by a model. A
 * model answers questions; this module decides what a card *is*. Three separate
 * things, deliberately not conflated:
 *
 *   - **anchor id** — derived from the source id and the *normalised quote* of an
 *     inventory item. Content-addressed, so it survives an offset shift (the same
 *     fact moved) and breaks when the text changes (a different fact).
 *   - **locator** — the start/end offsets where the anchor was last resolved. An
 *     attribute, not part of the identity, because offsets go stale the moment
 *     anyone edits above them.
 *   - **card id** — derived from the normalised claim plus its sorted anchor ids.
 *     Two assessments that assert the same thing about the same evidence produce
 *     the same id, whatever engine, run or repetition produced them.
 *
 * The consequence that matters for reuse: a card can be *recognised* across runs,
 * engines, fixtures and systems without any model remembering anything.
 *
 * Anchors are assigned by matching a **bank question's own claim** against the
 * inventory — operator-authored text against a deterministic scan, both of which sit
 * outside the model. That is what makes the relationship a record rather than a
 * proposal.
 */

import { digest, normalizeClaim } from '../src/canonical.js';
import { locate } from '../src/spans.js';

export const CARD_ID_SCHEMA = 'gca-card-identity/v1';

const STOPWORDS = new Set([
  'the', 'and', 'that', 'this', 'with', 'from', 'for', 'are', 'was', 'were', 'has', 'have', 'not', 'but',
  'its', 'into', 'than', 'then', 'they', 'their', 'which', 'while', 'when', 'what', 'does', 'did', 'only',
  'also', 'all', 'any', 'can', 'may', 'will', 'would', 'should', 'must', 'been', 'being', 'because',
]);

function normalizeText(text) {
  return String(text ?? '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

function containsPhrase(haystack, phrase) {
  const needle = normalizeText(phrase);
  if (!needle) return false;
  return ` ${haystack} `.includes(` ${needle} `);
}

function contentTokens(text) {
  return new Set(normalizeText(text).split(' ').filter((token) => token.length >= 4 && !STOPWORDS.has(token)));
}

/** Entity keys an inventory item exposes, if it exposes any. */
export function itemKeys(item) {
  if (item.kind === 'relationship') return item.detail?.entities ?? null;
  if (item.kind === 'entity') return item.detail?.key ? [item.detail.key] : null;
  if (item.kind === 'cross_source_reference') return item.detail?.key ? [item.detail.key] : null;
  return null;
}

/** Content-addressed anchor: stable under an offset shift, broken by a text change. */
export function anchorId({ source_id, quote }) {
  return `anc_${digest({ schema: CARD_ID_SCHEMA, source_id, quote: normalizeClaim(quote) }).slice(0, 20)}`;
}

/** Card identity: what is asserted, about which evidence. Probabilities are not part of it. */
export function cardId({ claim, anchor_ids = [] }) {
  return `crd_${digest({ schema: CARD_ID_SCHEMA, claim: normalizeClaim(claim), anchors: [...new Set(anchor_ids)].sort() }).slice(0, 24)}`;
}

/**
 * Anchors for one bank question: the inventory items that share its declared source
 * and expose entity keys the question's own claim mentions. Deterministic given the
 * bank and the scan — no model output is in scope.
 */
export function anchorsForQuestion({ question, survey, maxAnchors = 4 }) {
  const claim = normalizeText(question?.claim ?? question?.instructions ?? '');
  const sourceId = question?.source_id ?? null;
  const anchors = [];
  for (const item of survey?.items ?? []) {
    if (anchors.length >= maxAnchors) break;
    if (sourceId && !(item.spans ?? []).some((span) => span.source_id === sourceId)) continue;
    const keys = itemKeys(item);
    const span = (item.spans ?? []).find((entry) => entry.source_id === (sourceId ?? entry.source_id));
    if (!span) continue;
    let hit;
    if (keys && keys.length) hit = keys.every((key) => containsPhrase(claim, key));
    else {
      const entities = item.detail?.entities ?? [];
      hit = entities.length > 0
        ? entities.every((key) => containsPhrase(claim, key))
        : (() => {
            const tokens = contentTokens(`${item.label ?? ''}`);
            if (tokens.size === 0) return false;
            const found = [...tokens].filter((token) => containsPhrase(claim, token)).length;
            return found / tokens.size >= 0.6;
          })();
    }
    if (!hit) continue;
    anchors.push({
      anchor_id: anchorId(span),
      item_id: item.id,
      kind: item.kind,
      quote: span.quote,
      locator: { source_id: span.source_id, start: span.span.start, end: span.span.end },
    });
  }
  return anchors;
}

/**
 * Re-resolve an anchor against a (possibly edited) input.
 *
 * Identity is content-addressed, but a pure quote lookup is not enough: any phrase
 * that repeats is ambiguous, and F9 repeats its log line by construction. So the
 * stored locator is used as the **primary handle and tie-breaker**, and the quote is
 * used to **verify** it. Both are records; neither comes from a model.
 *
 * Modes, in order of preference:
 *   same_offset    — the text at the stored locator still equals the quote
 *   relocated      — the quote occurs exactly once elsewhere (text was prepended)
 *   disambiguated  — the quote repeats; the nearest occurrence to the stored locator wins
 */
export function resolveAnchor(input, anchor) {
  const sourceId = anchor.locator?.source_id ?? anchor.source_id;
  const source = (input?.sources ?? []).find((entry) => entry.id === sourceId);
  if (!source) return { ok: false, reason: 'source_missing' };
  const text = typeof source.content?.text === 'string' ? source.content.text : '';
  const quote = anchor.quote;
  if (!quote) return { ok: false, reason: 'no_quote' };

  const at = anchor.locator?.start ?? -1;
  if (at >= 0 && text.slice(at, at + quote.length) === quote) {
    return { ok: true, mode: 'same_offset', locator_still_valid: true, span: { source_id: sourceId, start: at, end: at + quote.length } };
  }

  const positions = [];
  for (let index = text.indexOf(quote); index !== -1; index = text.indexOf(quote, index + 1)) positions.push(index);
  if (positions.length === 0) return { ok: false, reason: 'quote_not_found' };

  const chosen = positions.length === 1
    ? positions[0]
    : positions.reduce((best, position) => (Math.abs(position - at) < Math.abs(best - at) ? position : best), positions[0]);

  return {
    ok: true,
    mode: positions.length === 1 ? 'relocated' : 'disambiguated',
    locator_still_valid: false,
    occurrences: positions.length,
    span: { source_id: sourceId, start: chosen, end: chosen + quote.length },
  };
}

/** The frozen verifier's answer for the same quote, kept for comparison. */
export function verifyByFrozenLocator(input, anchor) {
  return locate(input, { source_id: anchor.locator?.source_id ?? anchor.source_id, quote: anchor.quote });
}

/**
 * Build the identity layer for one snapshot record: every observation gets anchor
 * ids, a stable card id, and the locators those anchors resolved to.
 */
export function identifySnapshot({ record, survey }) {
  const questions = new Map((record?.bank?.questions ?? []).map((question) => [question.name, question]));
  return (record?.snapshot?.observations ?? []).map((observation) => {
    const question = questions.get(observation.oid) ?? { name: observation.oid, claim: observation.claim, source_id: null };
    const anchors = anchorsForQuestion({ question, survey });
    const anchor_ids = anchors.map((anchor) => anchor.anchor_id);
    return {
      oid: observation.oid,
      card_id: cardId({ claim: observation.claim, anchor_ids }),
      claim: observation.claim,
      kind: observation.kind,
      anchors,
      anchor_ids,
      unanchored: anchor_ids.length === 0,
      extraction_confidence: observation.confidence?.extraction ?? null,
    };
  });
}
