/**
 * Span resolution.
 *
 * Models are unreliable at emitting character offsets and reliable enough at
 * copying text, so the harness trusts the quote and derives the span. A quote
 * that cannot be found in the cited source is a fabricated citation, and the
 * snapshot that carries it is rejected rather than repaired.
 *
 * A quote that occurs more than once is ambiguous. `indexOf` returning the first
 * hit is not evidence that the model meant that hit, so ambiguity is rejected
 * unless the ref itself resolves it: either it declares a span that matches
 * exactly one occurrence, or it supplies surrounding context that selects one.
 * Guessing would convert a coincidence into a citation.
 *
 * Offsets are UTF-16 code units: exactly what String.prototype.indexOf returns
 * and what slice() consumes.
 */

const MAX_OCCURRENCES = 128;

export function sourceText(source) {
  return typeof source?.content?.text === 'string' ? source.content.text : '';
}

export function findSource(input, sourceId) {
  return (input?.sources ?? []).find((s) => s.id === sourceId) ?? null;
}

/** Every position at which `quote` starts in `text`, in order. */
export function occurrencesOf(text, quote) {
  const starts = [];
  if (!quote) return starts;
  let at = text.indexOf(quote);
  while (at >= 0) {
    starts.push(at);
    if (starts.length >= MAX_OCCURRENCES) break;
    at = text.indexOf(quote, at + 1);
  }
  return starts;
}

/**
 * Select one occurrence using operator-visible context the model supplied.
 * Returns null when the context does not select exactly one.
 */
function resolveByContext(text, starts, quote, ref) {
  const before = typeof ref?.context_before === 'string' && ref.context_before ? ref.context_before : null;
  const after = typeof ref?.context_after === 'string' && ref.context_after ? ref.context_after : null;
  if (!before && !after) return null;
  const matches = starts.filter((start) => {
    if (before && !text.slice(Math.max(0, start - before.length), start).endsWith(before)) return false;
    if (after && text.slice(start + quote.length, start + quote.length + after.length) !== after) return false;
    return true;
  });
  return matches.length === 1 ? matches[0] : null;
}

/**
 * @returns {{ok: true, verifiable: boolean, span: {start,end}|null, quote: string,
 *            corrected: boolean, resolution: string, occurrences?: number}
 *          | {ok: false, reason: string, occurrences?: number}}
 */
export function locate(input, ref) {
  const source = findSource(input, ref?.source_id);
  if (!source) return { ok: false, reason: 'invented_source' };
  const quote = String(ref?.quote ?? '');
  if (!quote) return { ok: false, reason: 'empty_quote' };

  if (source.kind === 'image') {
    const region = ref?.region;
    if (!region) return { ok: false, reason: 'image_region_missing' };
    const { width, height } = source.content ?? {};
    if (width && height && (region.x + region.w > width || region.y + region.h > height)) {
      return { ok: false, reason: 'image_region_out_of_bounds' };
    }
    // A pixel citation cannot be verified as text. It is counted, not trusted.
    return { ok: true, verifiable: false, span: null, quote, corrected: false, resolution: 'image_region' };
  }

  const text = sourceText(source);
  const starts = occurrencesOf(text, quote);
  if (starts.length === 0) return { ok: false, reason: 'fabricated_quote' };

  const declared = Number.isInteger(ref?.span?.start) && Number.isInteger(ref?.span?.end) ? ref.span : null;
  const declaredIsReal =
    Boolean(declared) && declared.end - declared.start === quote.length && text.slice(declared.start, declared.end) === quote;

  if (starts.length === 1) {
    const span = { start: starts[0], end: starts[0] + quote.length };
    const corrected = Boolean(declared) && (declared.start !== span.start || declared.end !== span.end);
    return { ok: true, verifiable: true, span, quote, corrected, resolution: 'unique' };
  }

  if (declaredIsReal && starts.includes(declared.start)) {
    return {
      ok: true,
      verifiable: true,
      span: { start: declared.start, end: declared.end },
      quote,
      corrected: false,
      resolution: 'declared_span',
      occurrences: starts.length,
    };
  }

  const contextual = resolveByContext(text, starts, quote, ref);
  if (contextual !== null) {
    return {
      ok: true,
      verifiable: true,
      span: { start: contextual, end: contextual + quote.length },
      quote,
      corrected: false,
      resolution: 'context',
      occurrences: starts.length,
    };
  }

  return { ok: false, reason: 'ambiguous_quote', occurrences: starts.length };
}

/**
 * Rewrite every ref with the span the source actually supports.
 * Unresolvable refs are left intact so validate.js reports them.
 */
export function canonicalizeSnapshot(input, snapshot) {
  const stats = { refs: 0, verifiable: 0, unverifiable: 0, corrected: 0, ambiguous: 0, unresolved: [] };
  for (const observation of snapshot.observations ?? []) {
    for (const ref of observation.refs ?? []) {
      stats.refs += 1;
      const found = locate(input, ref);
      if (!found.ok) {
        stats.unresolved.push({ oid: observation.oid, source_id: ref?.source_id ?? null, reason: found.reason });
        if (found.reason === 'ambiguous_quote') stats.ambiguous += 1;
        continue;
      }
      if (found.verifiable) {
        stats.verifiable += 1;
        ref.span = found.span;
        if (found.corrected) stats.corrected += 1;
      } else {
        stats.unverifiable += 1;
      }
    }
  }
  return { snapshot, stats };
}
