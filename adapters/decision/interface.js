/**
 * Provider-independent decision interface.
 *
 * The adapter does four things and nothing else:
 *   1. accept a normalised input state
 *   2. build the provider request
 *   3. execute it (the caller owns transport; see `send`)
 *   4. normalise and validate the response
 *
 * It does not write snapshot cards, invent evidence, decide completeness or pick
 * what an application displays. Those live in `snapshot/`.
 *
 * Everything here is transport-free so the whole path can be exercised against
 * recorded responses with no network call and no charge.
 */

const QUESTION_TYPES = ['noul', 'choice', 'score', 'locate'];

/** Provider label written into snapshots produced by the decision path. */
export const DECISIONS_PROVIDER = 'decisions';

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** Rough only: pre-flight limits and the question multiplier. Never cost. */
export function estimateTokens(text) {
  return Math.ceil(String(text ?? '').length / 4);
}

/**
 * One state serialisation for every provider, so a difference between two results
 * is a difference between models and not between serialisations.
 *
 * Sources are flattened with unambiguous markers and each source's [start, end)
 * range is recorded, so a span returned against the flattened state maps back to
 * a source-relative offset.
 */
export function buildState(input) {
  const parts = [];
  const segments = [];
  let cursor = 0;
  for (const source of input?.sources ?? []) {
    const text = typeof source?.content?.text === 'string' ? source.content.text : '';
    const header = `<<<${source.id}|${source.kind}|${source.label}>>>\n`;
    parts.push(header);
    cursor += header.length;
    const start = cursor;
    parts.push(text);
    cursor += text.length;
    const end = cursor;
    parts.push('\n');
    cursor += 1;
    segments.push({ source_id: source.id, start, end });
  }
  return { text: parts.join(''), segments };
}

/**
 * Vendor `locate` offsets are in Unicode characters; JavaScript indexes in UTF-16
 * code units. For any state containing an astral character the two diverge and a
 * naive slice returns the wrong quote.
 */
export function codePointOffsetToUtf16(text, offset) {
  if (!Number.isInteger(offset) || offset < 0) return { ok: false, reason: 'invalid_offset' };
  let codePoints = 0;
  let index = 0;
  while (index < text.length && codePoints < offset) {
    const code = text.codePointAt(index);
    index += code > 0xffff ? 2 : 1;
    codePoints += 1;
  }
  if (codePoints !== offset) return { ok: false, reason: 'offset_past_end' };
  return { ok: true, index };
}

/** A vendor span → a source-relative ref, or a stated reason why not. */
export function spanToRef({ state, span }) {
  if (!isObject(span)) return { ok: false, reason: 'span_not_object' };
  const start = codePointOffsetToUtf16(state.text, span.start);
  if (!start.ok) return { ok: false, reason: `span_start_${start.reason}` };
  const end = codePointOffsetToUtf16(state.text, span.end);
  if (!end.ok) return { ok: false, reason: `span_end_${end.reason}` };
  if (end.index <= start.index) return { ok: false, reason: 'span_empty' };
  const text = state.text.slice(start.index, end.index);
  if (typeof span.text === 'string' && span.text !== text) return { ok: false, reason: 'span_text_mismatch' };
  const segment = state.segments.find((entry) => start.index >= entry.start && end.index <= entry.end);
  if (!segment) return { ok: false, reason: 'span_outside_sources' };
  return {
    ok: true,
    ref: {
      source_id: segment.source_id,
      quote: text,
      span: { start: start.index - segment.start, end: end.index - segment.start },
    },
  };
}

/**
 * Freeze a provider implementation into an adapter.
 *
 * `extract(body)` returns `{ rawAnswers, rawUsage, native }` — provider field
 * positions only. Typed validation and span mapping are generic and live in
 * normalize.js, so a provider bug cannot silently change the semantics of an
 * answer.
 */
export function createAdapter(spec) {
  const missing = ['id', 'vendor', 'capabilities', 'buildRequest', 'extract'].filter((key) => !spec?.[key]);
  if (missing.length) throw new Error(`adapter spec is missing: ${missing.join(', ')}`);
  const types = spec.capabilities?.question_types ?? [];
  const unsupported = types.filter((type) => !QUESTION_TYPES.includes(type));
  if (unsupported.length) throw new Error(`adapter ${spec.id} declares unknown question types: ${unsupported.join(', ')}`);
  if (spec.capabilities?.locate && !types.includes('locate')) {
    throw new Error(`adapter ${spec.id} claims locate but does not list it in question_types`);
  }
  if (!spec.capabilities?.pricing || typeof spec.capabilities.pricing.input_per_mtok !== 'number') {
    throw new Error(`adapter ${spec.id} must declare pricing.input_per_mtok`);
  }

  return Object.freeze({
    ...spec,
    capabilities: Object.freeze({ ...spec.capabilities, question_types: Object.freeze([...types]) }),
    supports: (type) => types.includes(type),
    supportsLocate: () => Boolean(spec.capabilities?.locate) && types.includes('locate'),
  });
}

/**
 * Transport is the caller's, not the adapter's. Kept here so an adapter is never
 * a client, and so recorded responses can stand in for live ones.
 */
export async function send(request, fetchImpl = globalThis.fetch) {
  if (typeof fetchImpl !== 'function') throw new Error('no fetch implementation available');
  const response = await fetchImpl(request.endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(request.headers ?? {}) },
    body: JSON.stringify(request.body),
  });
  const body = await response.json().catch(() => null);
  return { ok: response.ok, status: response.status, body };
}
