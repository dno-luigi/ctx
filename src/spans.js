/**
 * Span resolution.
 *
 * Models are unreliable at emitting character offsets and reliable enough at
 * copying text, so the harness trusts the quote and derives the span. A quote
 * that cannot be found in the cited source is a fabricated citation, and the
 * snapshot that carries it is rejected rather than repaired.
 *
 * Offsets are UTF-16 code units: exactly what String.prototype.indexOf returns
 * and what slice() consumes.
 */

export function sourceText(source) {
  return typeof source?.content?.text === 'string' ? source.content.text : '';
}

export function findSource(input, sourceId) {
  return (input?.sources ?? []).find((s) => s.id === sourceId) ?? null;
}

/**
 * @returns {{ok: true, verifiable: boolean, span: {start,end}|null, quote: string, corrected: boolean}
 *          | {ok: false, reason: string}}
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
    return { ok: true, verifiable: false, span: null, quote, corrected: false };
  }

  const text = sourceText(source);
  const at = text.indexOf(quote);
  if (at < 0) return { ok: false, reason: 'fabricated_quote' };
  const span = { start: at, end: at + quote.length };
  const declared = ref?.span;
  const corrected = Boolean(declared) && (declared.start !== span.start || declared.end !== span.end);
  return { ok: true, verifiable: true, span, quote, corrected };
}

/**
 * Rewrite every ref with the span the source actually supports.
 * Unresolvable refs are left intact so validate.js reports them.
 */
export function canonicalizeSnapshot(input, snapshot) {
  const stats = { refs: 0, verifiable: 0, unverifiable: 0, corrected: 0, unresolved: [] };
  for (const observation of snapshot.observations ?? []) {
    for (const ref of observation.refs ?? []) {
      stats.refs += 1;
      const found = locate(input, ref);
      if (!found.ok) {
        stats.unresolved.push({ oid: observation.oid, source_id: ref?.source_id, reason: found.reason });
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
