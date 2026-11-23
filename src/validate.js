/**
 * Citation verification.
 *
 * A model's interpretation is not evidence. The only thing checked here is mechanical: does each
 * declared quote occur in the source it names? Nothing is repaired — a quote that cannot be found
 * stays attached to the finding as a flagged citation, and the finding cannot become a verified
 * conclusion.
 *
 * Identical quotes occurring more than once are marked ambiguous rather than assigned an offset by
 * guesswork. That is the same boundary A1′ drew for anchors: a locator may be missing, but it may
 * never silently point at the wrong occurrence.
 */

export const VERIFICATION = {
  verified: 'citation_verified',
  quoteMissing: 'quote_not_found',
  sourceUnknown: 'source_unknown',
  noCitation: 'no_citation',
};

const occurrencesOf = (text, quote) => {
  const offsets = [];
  let index = text.indexOf(quote);
  while (index !== -1) {
    offsets.push(index);
    index = text.indexOf(quote, index + 1);
    if (offsets.length > 32) break;
  }
  return offsets;
};

const lineAt = (text, offset) => text.slice(0, offset).split('\n').length;

/** @returns {{status: string, evidence: object[], flagged: object[]}} */
export function verifyCitations({ citations, sourcesById }) {
  const evidence = [];
  const flagged = [];
  if (!Array.isArray(citations) || citations.length === 0) {
    return { status: VERIFICATION.noCitation, evidence, flagged: [{ reason: 'no_citation' }] };
  }

  for (const citation of citations) {
    const source = sourcesById.get(citation?.source_id);
    if (!source) {
      flagged.push({ source_id: citation?.source_id ?? null, quote: citation?.quote ?? null, reason: 'source_not_in_acquisition' });
      continue;
    }
    const quote = typeof citation.quote === 'string' ? citation.quote.trim() : '';
    if (!quote) {
      flagged.push({ source_id: source.source_id, reason: 'empty_quote' });
      continue;
    }
    const offsets = occurrencesOf(source.text, quote);
    if (offsets.length === 0) {
      flagged.push({ source_id: source.source_id, reason: 'quote_not_found', quote });
      continue;
    }
    let chosen = offsets[0];
    let ambiguous = offsets.length > 1;
    if (Number.isInteger(citation.line) && citation.line > 0) {
      const onLine = offsets.filter((offset) => lineAt(source.text, offset) === citation.line);
      if (onLine.length === 1) {
        chosen = onLine[0];
        ambiguous = false;
      }
    }
    evidence.push({
      source_id: source.source_id,
      sha256: source.sha256,
      quote,
      start: chosen,
      end: chosen + quote.length,
      line: lineAt(source.text, chosen),
      occurrences: offsets.length,
      ambiguous_locator: ambiguous,
    });
  }

  if (!evidence.length) return { status: VERIFICATION.quoteMissing, evidence, flagged };
  if (flagged.length) {
    return {
      status: flagged.some((entry) => entry.reason === 'source_not_in_acquisition') ? VERIFICATION.sourceUnknown : VERIFICATION.quoteMissing,
      evidence,
      flagged,
    };
  }
  return { status: VERIFICATION.verified, evidence, flagged };
}

/** A relationship's citations are checked the same way; a claimed edge with no resolvable evidence is flagged. */
export function verifyRelationship({ relationship, sourcesById }) {
  const check = verifyCitations({ citations: relationship?.sources, sourcesById });
  return { ...relationship, verification: check.status, evidence: check.evidence, flags: check.flagged };
}
