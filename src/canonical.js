import { createHash } from 'node:crypto';

/**
 * Deterministic JSON: object keys sorted at every level.
 * digests must survive a round trip through a file, so nothing may depend on
 * insertion order.
 */
export function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableStringify(value[k])).join(',') + '}';
}

export function digest(value) {
  return 'sha256:' + createHash('sha256').update(stableStringify(value)).digest('hex');
}

/** A source hash covers only what a model can actually see. */
export function hashSource(source) {
  return digest({
    kind: source?.kind ?? null,
    text: source?.content?.text ?? null,
    data_url: source?.content?.data_url ?? null,
  });
}

/** Claims are compared after folding case, whitespace and trailing punctuation. */
export function normalizeClaim(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[\s.,;:!?"'`)\]]+$/g, '')
    .trim();
}
