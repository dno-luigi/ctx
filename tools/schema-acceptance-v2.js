/**
 * ARA schema acceptance tests v2 — AC-1 … AC-7 against the A1′ anchor contract.
 *
 * v1 (tools/schema-acceptance.js) is preserved unchanged as historical evidence: it validates the
 * ordinal rule and its 39/39 result belongs to ARA-SCHEMA-01. This file is the acceptance suite for
 * ARA-SCHEMA-02, which changes one thing — anchor identity and resolution — and nothing else.
 *
 * Only AC-5 (repeated occurrences) and AC-6 (revision stability) are rewritten. AC-1, AC-2, AC-3,
 * AC-4 and AC-7 are carried over because their subject is not occurrence identity, but they run
 * against the new anchor form, because the contract they exercise has changed.
 *
 * Usage: node tools/schema-acceptance-v2.js
 */

import { readFile } from 'node:fs/promises';

import { anchorId } from '../cards/identity.js';
import { digest, normalizeClaim } from '../src/canonical.js';

const ROOT = new URL('../', import.meta.url);
const H = (schema, ...parts) => digest({ schema, parts }).slice(0, 20);
const normalize = (line) => line.trim().replace(/\s+/g, ' ');

// ------------------------------------------------------------------ identity (A1′)

const claimId = (text, domain = 'prose') => `clm_${H('ara/claim/v1', normalizeClaim(text), domain)}`;

/** Identity of the occurrence: source, quote and the context it was born in. Immutable. */
const anchorIdOf = (sourceId, quote, context) => `anc_${H('ara/anchor/v2', normalizeClaim(quote), sourceId, context)}`;

/** Resolution evidence is stored beside identity, never folded into it. */
const fingerprintOf = (text, start, end) => {
  // Line boundaries, not character slices: a trimmed quote begins after its indentation, so slicing
  // from `start` sees the indent and reports an empty previous line for every indented anchor.
  const lineStart = text.lastIndexOf('\n', start - 1) + 1;
  const prevEnd = lineStart - 1;
  const prev = prevEnd <= 0 ? '' : text.slice(prevEnd <= 0 ? 0 : text.lastIndexOf('\n', prevEnd - 1) + 1, prevEnd);
  const nextStart = (() => { const boundary = text.indexOf('\n', end); return boundary === -1 ? text.length : boundary + 1; })();
  const nextEnd = nextStart >= text.length ? -1 : text.indexOf('\n', nextStart);
  const next = nextStart >= text.length ? '' : (nextEnd === -1 ? text.slice(nextStart) : text.slice(nextStart, nextEnd));
  return `${normalize(prev)}|${normalize(next)}`;
};

function positionsOf(text, quote) {
  // Whole-line occurrences, matching how AC-5/AC-6 define an occurrence. Substring matching counts a
  // quote inside a longer line (e.g. `ok: true,` inside `ok: true, ambiguous: 0`) as an occurrence,
  // which shifts every rank after it and manufactures reattributions that did not happen.
  const lines = text.split('\n');
  const positions = [];
  let offset = 0;
  for (const line of lines) {
    if (line.trim() === quote) positions.push(offset + (line.length - line.trimStart().length));
    offset += line.length + 1;
  }
  return positions;
}

/** The only resolution rule: report a status, never pick silently. */
function resolveInText(text, anchor) {
  const positions = positionsOf(text, anchor.quote);
  if (positions.length === 0) return { status: 'unresolved', candidates: [] };
  const matching = positions.filter((position) => fingerprintOf(text, position, position + anchor.quote.length) === anchor.context);
  if (matching.length === 1) return { status: 'verified', candidates: matching };
  if (matching.length > 1) return { status: 'ambiguous', candidates: matching };
  return { status: 'needs_reattribution', candidates: positions };
}

const relationshipId = (from, to, type) => `rel_${H('ara/relationship/v1', from, to, type)}`;
const assessmentId = (claimIdValue, question, model, at) => `asm_${H('ara/assessment/v1', claimIdValue, question, model, at)}`;
const coverageId = (scope, setDigest, instrument, domain) => `cov_${H('ara/coverage/v1', scope, setDigest, instrument, domain)}`;

// ------------------------------------------------------------------ reference store (unchanged)

class NoProvenanceError extends Error {}
class IllegalEventError extends Error {}

class ReferenceStore {
  constructor() {
    this.events = [];
    this.claims = new Map();
    this.anchors = new Map();
    this.relationships = new Map();
    this.assessments = new Map();
  }

  emit(op, actor, subject, payload = {}, basis = null) {
    const event = { event_id: this.events.length + 1, at: `t${this.events.length + 1}`, actor, op, subject, payload, basis };
    this.events.push(event);
    this.apply(event);
    return event;
  }

  apply(event) {
    const { op, subject, payload, basis } = event;
    switch (op) {
      case 'append': {
        const existing = this.claims.get(subject.claim_id);
        if (existing) existing.valid_from ??= event.at;
        else this.claims.set(subject.claim_id, { ...subject, state: 'captured', valid_from: event.at, valid_until: null, supersedes: [], conflicts_with: [] });
        for (const anchor of payload.anchors ?? []) this.anchors.set(anchor.anchor_id, { ...anchor, state: 'resolved' });
        for (const assessment of payload.assessments ?? []) this.assessments.set(assessment.assessment_id, assessment);
        for (const relationship of payload.relationships ?? []) {
          const existing = this.relationships.get(relationship.relationship_id);
          if (existing) existing.provenance.push(...relationship.provenance);
          else this.relationships.set(relationship.relationship_id, relationship);
        }
        break;
      }
      case 'supersede': {
        const old = this.claims.get(subject.claim_id);
        const next = this.claims.get(payload.replacement_claim_id);
        if (!old || !next) throw new IllegalEventError('supersede requires both claims');
        old.valid_until = event.at;
        next.supersedes = [...new Set([...next.supersedes, subject.claim_id])];
        break;
      }
      case 'conflict': {
        const a = this.claims.get(subject.claim_id);
        const b = this.claims.get(payload.other_claim_id);
        if (!a || !b) throw new IllegalEventError('conflict requires both claims');
        a.conflicts_with = [...new Set([...a.conflicts_with, b.claim_id])];
        b.conflicts_with = [...new Set([...b.conflicts_with, a.claim_id])];
        a.conflict_open = true;
        b.conflict_open = true;
        break;
      }
      case 'resolve': {
        if (!basis) throw new IllegalEventError('resolve requires a basis');
        const a = this.claims.get(subject.claim_id);
        const b = this.claims.get(payload.other_claim_id);
        if (!a || !b) throw new IllegalEventError('resolve requires both claims');
        for (const claim of [a, b]) {
          claim.conflict_open = false;
          claim.conflict_resolved_by = basis;
        }
        break;
      }
      case 'retract': {
        if (!basis) throw new IllegalEventError('retract requires a cause');
        const claim = this.claims.get(subject.claim_id);
        if (!claim) throw new IllegalEventError('retract requires an existing claim');
        claim.state = 'unknown';
        claim.retracted_because = basis;
        break;
      }
      default:
        throw new IllegalEventError(`unknown op ${op}`);
    }
  }

  appendClaim({ text, domain = 'prose', anchors = [], relationships = [], assessments = [], actor = 'extractor' }) {
    const id = claimId(text, domain);
    if (anchors.length === 0) throw new NoProvenanceError(`claim ${id} has no anchor`);
    for (const anchor of anchors) {
      if (!anchor.source_id || !anchor.quote) throw new NoProvenanceError('anchor missing source or quote');
      // A1′: the birth context is required. Without it the occurrence has no identity.
      if (typeof anchor.context !== 'string' || !anchor.context) throw new NoProvenanceError('anchor missing birth context');
    }
    for (const relationship of relationships) {
      if (!relationship.provenance?.length || !relationship.provenance[0].extractor) throw new NoProvenanceError('relationship without extractor');
    }
    return this.emit('append', actor, { claim_id: id, canonical_text: text, domain }, {
      anchors: anchors.map((anchor) => ({
        anchor_id: anchorIdOf(anchor.source_id, anchor.quote, anchor.context),
        claim_id: id,
        source_id: anchor.source_id,
        source_revision: anchor.source_revision ?? null,
        context: anchor.context,
        locator: { start: anchor.start, end: anchor.end },
        quote: anchor.quote,
        resolution_status: anchor.resolution_status ?? 'verified',
      })),
      relationships,
      assessments,
    });
  }

  supersede(oldClaimId, { text, domain = 'prose', anchor }) {
    const id = claimId(text, domain);
    this.emit('append', 'extractor', { claim_id: id, canonical_text: text, domain }, {
      anchors: [{ anchor_id: anchorIdOf(anchor.source_id, anchor.quote, anchor.context), claim_id: id, source_id: anchor.source_id, source_revision: null, context: anchor.context, locator: { start: anchor.start, end: anchor.end }, quote: anchor.quote, resolution_status: 'verified' }],
    });
    return this.emit('supersede', 'system', { claim_id: oldClaimId }, { replacement_claim_id: id });
  }

  conflict(a, b, actor = 'adjudicator') { return this.emit('conflict', actor, { claim_id: a }, { other_claim_id: b }); }
  resolve(a, b, basis) { return this.emit('resolve', 'adjudicator', { claim_id: a }, { other_claim_id: b }, basis); }
  retract(id, cause) { return this.emit('retract', 'system', { claim_id: id }, {}, cause); }

  static replay(events) {
    const store = new ReferenceStore();
    for (const event of events) {
      store.events.push(event);
      store.apply(event);
    }
    return store;
  }

  projection() {
    const sortEntries = (map) => [...map.entries()].sort(([a], [b]) => (a < b ? -1 : 1));
    return JSON.stringify({
      claims: sortEntries(this.claims),
      anchors: sortEntries(this.anchors),
      relationships: sortEntries(this.relationships),
      assessments: sortEntries(this.assessments),
    });
  }

  information(scopeIds) {
    return { fields: ['claim_id', 'canonical_text', 'domain', 'state'], data: scopeIds.map((id) => this.claims.get(id)).filter(Boolean) };
  }

  provenance(id) {
    const anchors = [...this.anchors.values()].filter((anchor) => anchor.claim_id === id);
    return { fields: ['source_id', 'source_revision', 'locator', 'context', 'quote', 'resolution_status'], data: anchors };
  }

  relationshipsOf(id, { extractor = null } = {}) {
    const edges = [...this.relationships.values()].filter((edge) => edge.from_claim_id === id || edge.to_claim_id === id);
    if (!extractor) return { status: 'edges_unknown', reason: 'no extractor declared for this scope', edges: [] };
    const proven = edges.filter((edge) => edge.provenance.some((proof) => proof.extractor === extractor));
    return proven.length ? { status: 'ok', edges: proven } : { status: 'no_edges', extractor, edges: [] };
  }

  reliability(id) {
    return { fields: ['assessment_id', 'probability', 'verdict', 'model', 'question_id', 'assessed_at'], data: [...this.assessments.values()].filter((assessment) => assessment.claim_id === id) };
  }
}

// ------------------------------------------------------------------ coverage / sufficiency (unchanged)

function measureCoverage({ scope, domain, instrument, requiredSet, covered, unanchored }) {
  const fit = instrument ? (instrument.domain === domain ? 'fit' : 'mismatch') : 'absent';
  return {
    coverage_id: coverageId(scope, requiredSet.digest, instrument?.name ?? 'none', domain),
    scope,
    domain,
    required_set: requiredSet,
    instrument: instrument ?? null,
    measured: fit === 'fit' ? { covered, total: requiredSet.items, class_recall: covered / requiredSet.items } : null,
    instrument_fit: fit,
    unanchored_claims: unanchored,
  };
}

function mayProceed(coverage, support) {
  if (coverage.instrument_fit !== 'fit') return { ok: false, side: 'instrument', detail: coverage.instrument_fit };
  if (coverage.measured.covered / coverage.measured.total < 1) return { ok: false, side: 'coverage', detail: `${coverage.measured.covered}/${coverage.measured.total}` };
  if (support < 0.5) return { ok: false, side: 'support', detail: support };
  return { ok: true };
}

// ------------------------------------------------------------------ harness

let checks = 0;
let failed = 0;
const assert = (name, condition, detail = '') => {
  checks += 1;
  if (!condition) failed += 1;
  console.log(`  ${condition ? 'ok  ' : 'FAIL'} ${name}${condition || !detail ? '' : ` — ${detail}`}`);
};
const section = (title) => console.log(`\n${title}`);
const span = (source_id, quote, context, start, end) => ({ source_id, quote, context, start, end });

// ------------------------------------------------------------------ AC-1

section('AC-1 event replay equals projection');
{
  const store = new ReferenceStore();
  store.appendClaim({ text: 'The service keeps three replicas.', anchors: [span('svc.md', 'The service keeps three replicas.', 'a|b', 0, 33)] });
  store.appendClaim({ text: 'Nothing is deleted before that window closes.', anchors: [span('ret.md', 'Nothing is deleted before that window closes.', 'c|d', 10, 55)] });
  store.supersede(claimId('The service keeps three replicas.'), { text: 'The service keeps four replicas.', anchor: span('svc.md', 'The service keeps four replicas.', 'a|b', 0, 32) });
  const a = claimId('Nothing is deleted before that window closes.');
  const b = claimId('Records are purged after 30 days.');
  store.appendClaim({ text: 'Records are purged after 30 days.', anchors: [span('ret.md', 'Records are purged after 30 days.', 'e|f', 60, 94)] });
  store.conflict(a, b);
  store.resolve(a, b, 'ret.md revision 3 governs');
  store.retract(b, 'superseded by revision 4');

  const incremental = store.projection();
  const replayed = ReferenceStore.replay(JSON.parse(JSON.stringify(store.events))).projection();
  assert('replay from the event log reproduces the projection byte for byte', incremental === replayed);
  assert('no event removed a claim', store.claims.size === 4, `claims=${store.claims.size}`);
  assert('retraction kept the record, changed its state', store.claims.get(b).state === 'unknown');
  assert('supersede kept both revisions', store.claims.get(claimId('The service keeps three replicas.')).valid_until !== null);
  assert('conflict resolution recorded its basis', store.claims.get(a).conflict_resolved_by === 'ret.md revision 3 governs');
}

// ------------------------------------------------------------------ AC-2

section('AC-2 no record without provenance');
{
  const store = new ReferenceStore();
  let threw = null;
  try { store.appendClaim({ text: 'An unanchored assertion.', anchors: [] }); } catch (error) { threw = error; }
  assert('claim without an anchor is refused', threw instanceof NoProvenanceError, String(threw?.name));
  assert('refused write emitted no event', store.events.length === 0);

  const from = claimId('A depends on B.');
  let relThrew = null;
  try {
    store.appendClaim({ text: 'A depends on B.', anchors: [span('x.md', 'A depends on B.', 'g|h', 0, 14)], relationships: [{ relationship_id: relationshipId(from, from, 'depends_on'), from_claim_id: from, to_claim_id: from, type: 'depends_on', provenance: [] }] });
  } catch (error) { relThrew = error; }
  assert('relationship without an extractor is refused', relThrew instanceof NoProvenanceError, String(relThrew?.name));

  let ctxThrew = null;
  try { store.appendClaim({ text: 'Q.', anchors: [{ source_id: 'q.md', quote: 'Q.', start: 0, end: 2 }] }); } catch (error) { ctxThrew = error; }
  assert('anchor without a birth context is refused', ctxThrew instanceof NoProvenanceError, String(ctxThrew?.name));

  const relStore = new ReferenceStore();
  const target = 'B exists.';
  const source = 'A imports B.';
  const edge = { relationship_id: relationshipId(claimId(source), claimId(target), 'depends_on'), from_claim_id: claimId(source), to_claim_id: claimId(target), type: 'depends_on' };
  relStore.appendClaim({ text: target, anchors: [span('b.js', target, 'i|j', 0, 9)] });
  const anchorA = [span('a.js', source, 'k|l', 0, 12)];
  relStore.appendClaim({ text: source, anchors: anchorA, relationships: [{ ...edge, provenance: [{ extractor: 'code.imports', extractor_version: '1' }] }] });
  relStore.appendClaim({ text: source, anchors: anchorA, relationships: [{ ...edge, provenance: [{ extractor: 'rules.prose', extractor_version: '1' }] }] });
  const storedEdge = relStore.relationships.get(edge.relationship_id);
  assert('two extractors agreeing produce one logical edge', relStore.relationships.size === 1, `edges=${relStore.relationships.size}`);
  assert('that edge keeps both independent proofs', storedEdge?.provenance.length === 2, storedEdge?.provenance.map((proof) => proof.extractor).join(','));
}

// ------------------------------------------------------------------ AC-3

section('AC-3 the four questions use disjoint fields');
{
  const store = new ReferenceStore();
  const text = 'The service keeps three replicas.';
  const id = claimId(text);
  store.appendClaim({
    text,
    anchors: [span('svc.md', text, 'm|n', 0, 33)],
    assessments: [{ assessment_id: assessmentId(id, 'replicas', 'm', 't1'), claim_id: id, question_id: 'replicas', model: 'm', probability: 0.98, verdict: 'supported', assessed_at: 't1' }],
  });
  const a = store.information([id]);
  const b = store.provenance(id);
  const c = store.relationshipsOf(id, { extractor: 'code.imports' });
  const d = store.reliability(id);
  const sets = { information: new Set(a.fields), provenance: new Set(b.fields), relationships: new Set(['relationship_id', 'type', 'from_claim_id', 'to_claim_id', 'extractor']), reliability: new Set(d.fields) };
  const names = Object.keys(sets);
  let overlaps = 0;
  for (let i = 0; i < names.length; i += 1) for (let j = i + 1; j < names.length; j += 1) for (const field of sets[names[i]]) if (sets[names[j]].has(field)) { overlaps += 1; console.log(`      overlap ${field}: ${names[i]} ∩ ${names[j]}`); }
  assert('no field is shared between the four answer sets', overlaps === 0, `${overlaps} overlaps`);
  assert('truth of a claim is not in the information set', !sets.information.has('probability'));
  assert('completeness is not in the reliability set', !sets.reliability.has('class_recall') && !sets.reliability.has('covered'));
  assert('provenance does not carry the claim text', !sets.provenance.has('canonical_text'));

  const secondAssessment = { assessment_id: assessmentId(id, 'replicas', 'other-model', 't2'), claim_id: id, question_id: 'replicas', model: 'other-model', probability: 0.71, verdict: 'supported', assessed_at: 't2' };
  store.appendClaim({ text, anchors: [span('svc.md', text, 'm|n', 0, 33)], assessments: [secondAssessment] });
  assert("a second model's assessment does not overwrite the first", store.assessments.size === 2, `assessments=${store.assessments.size}`);
  assert('a reused claim keeps exactly one identity', store.claims.size === 1 && [...store.assessments.values()].every((assessment) => assessment.claim_id === id));
  assert('the two assessments disagree without a resolution', [...store.assessments.values()].map((assessment) => assessment.probability).join(',') === '0.98,0.71');
}

// ------------------------------------------------------------------ AC-4

section('AC-4 unknown is preserved, never rendered as zero');
{
  const requiredSet = { ref: 'req', digest: 'abc123', items: 12 };
  const plain = measureCoverage({ scope: 'repo:code', domain: 'code', instrument: { name: 'prose_rules', domain: 'prose' }, requiredSet, covered: 0, unanchored: 412 });
  assert('instrument/domain mismatch is reported as mismatch', plain.instrument_fit === 'mismatch');
  assert('mismatch produces no measured number', plain.measured === null);
  const absent = measureCoverage({ scope: 'repo:code', domain: 'code', instrument: null, requiredSet, covered: 0, unanchored: 0 });
  assert('absent instrument is reported as absent', absent.instrument_fit === 'absent');
  const verdict = mayProceed(absent, 0.0);
  assert('sufficiency with no instrument names the instrument side', verdict.ok === false && verdict.side === 'instrument');
  assert('no zero is substituted anywhere', absent.measured === null && verdict.detail !== 0);
  const sparse = measureCoverage({ scope: 'repo:prose', domain: 'prose', instrument: { name: 'prose_rules', domain: 'prose' }, requiredSet, covered: 0, unanchored: 3 });
  const sparseVerdict = mayProceed(sparse, 0.99);
  assert('zero covered names the coverage side, not support', sparseVerdict.side === 'coverage');
}

// ------------------------------------------------------------------ AC-5 (rewritten)

section('AC-5 repeated occurrences: identity separates, ambiguity is reported');

/** Anchors from a source: one per repeated occurrence, each carrying its own birth context. */
function anchorsFrom(text, source = 't.js', minLength = 0) {
  const lines = text.split('\n');
  const anchors = [];
  const seen = new Map();
  let offset = 0;
  lines.forEach((line, index) => {
    const quote = line.trim();
    if (quote.length >= minLength && quote) {
      const occurrence = (seen.get(quote) ?? 0) + 1;
      seen.set(quote, occurrence);
      anchors.push({
        quote,
        occurrence,
        context: `${normalize(lines[index - 1] ?? '')}|${normalize(lines[index + 1] ?? '')}`,
        start: offset,
        end: offset + line.length,
      });
    }
    offset += line.length + 1;
  });
  return anchors;
}

{
  // Distinguishable neighbours: three occurrences, three contexts, three identities.
  const distinct = 'alpha\n  run();\nctx 1\nbeta\n  run();\nctx 2\ngamma\n  run();\nctx 3\n';
  const anchors = anchorsFrom(distinct).filter((anchor) => anchor.quote === 'run();');
  assert('probe found three occurrences', anchors.length === 3, String(anchors.length));
  const ids = anchors.map((anchor) => anchorIdOf('t.js', anchor.quote, anchor.context));
  assert('distinguishable contexts produce three distinct anchor ids', new Set(ids).size === 3, ids.join(','));
  const resolved = anchors.map((anchor) => resolveInText(distinct, anchor));
  assert('each anchor resolves to its own offset', new Set(resolved.map((result) => result.candidates[0])).size === 3, JSON.stringify(resolved.map((result) => result.candidates)));
  assert('all three report verified', resolved.every((result) => result.status === 'verified'));

  // Identical neighbours: the fixture the ordinal rule was written for. A1′ cannot distinguish these,
  // and this is the capability boundary stated in ARA-SCHEMA-02 §4 — not a regression to hide.
  const identical = 'if (ready) {\n  run();\n}\nif (ready) {\n  run();\n}\nif (ready) {\n  run();\n}\n';
  const same = anchorsFrom(identical).filter((anchor) => anchor.quote === 'run();');
  assert('three occurrences exist in the identical-neighbour fixture', same.length === 3, String(same.length));
  assert('identical contexts collapse to one identity', new Set(same.map((anchor) => anchorIdOf('t.js', anchor.quote, anchor.context))).size === 1);
  const collapsed = same.map((anchor) => resolveInText(identical, anchor));
  assert('every collapsed occurrence is reported ambiguous', collapsed.every((result) => result.status === 'ambiguous'), collapsed.map((result) => result.status).join(','));
  assert('ambiguity names all three candidates', collapsed.every((result) => result.candidates.length === 3));
  assert('no collapsed occurrence is silently verified', collapsed.every((result) => result.status !== 'verified'));

  // Legacy content-only ids collapse both fixtures; identity of text alone is never enough.
  assert('content-only ids collapse the distinguishable fixture too', new Set(anchors.map((anchor) => anchorId({ source_id: 't.js', quote: anchor.quote }))).size === 1);

  // Real corpus: repeated lines with distinguishable neighbours keep distinct identities.
  const corpus = await readFile(new URL('tools/score-transcript.js', ROOT), 'utf8');
  const corpusAnchors = anchorsFrom(corpus, 'tools/score-transcript.js', 8);
  const byQuote = new Map();
  for (const anchor of corpusAnchors) byQuote.set(anchor.quote, (byQuote.get(anchor.quote) ?? 0) + 1);
  const [worst, count] = [...byQuote.entries()].sort((a, b) => b[1] - a[1])[0];
  const repeated = corpusAnchors.filter((anchor) => anchor.quote === worst);
  const repeatedIds = repeated.map((anchor) => anchorIdOf('tools/score-transcript.js', anchor.quote, anchor.context));
  assert(`real corpus: "${worst.slice(0, 26)}" repeats ${count}x and gets ${new Set(repeatedIds).size} identities`, count >= 2);
  assert('corpus repeats are verified or ambiguous, never silently wrong', repeated.every((anchor) => ['verified', 'ambiguous'].includes(resolveInText(corpus, anchor).status)));
}

// ------------------------------------------------------------------ AC-6 (rewritten)

section('AC-6 revision stability under A1′: four counts, no silent reattribution');
{
  const file = 'src/spans.js';
  const before = await readFile(new URL(file, ROOT), 'utf8');
  const after = before.replace(/\blocate\b/g, 'locateSpan');
  const anchors = anchorsFrom(before, file, 8).map((anchor) => ({ ...anchor, anchor_id: anchorIdOf(file, anchor.quote, anchor.context) }));
  const results = anchors.map((anchor) => ({ anchor, ...resolveInText(after, anchor) }));
  const counts = { verified: 0, ambiguous: 0, needs_reattribution: 0, unresolved: 0 };
  for (const result of results) counts[result.status] += 1;

  const distinct = new Set(anchors.map((anchor) => anchor.quote));
  const verifiedQuotes = new Set(results.filter((result) => result.status === 'verified').map((result) => result.anchor.quote));
  // A reattribution is landing on a different *occurrence* of the same quote. Comparing offsets would
  // count the legitimate shift every line below the rename as a reattribution (8 of them, previously).
  const rankOf = (text, quote, position) => positionsOf(text, quote).indexOf(position) + 1;
  const reattributed = results.filter((result) => result.status === 'verified' && rankOf(after, result.anchor.quote, result.candidates[0]) !== result.anchor.occurrence);

  assert('occurrences total 101', anchors.length === 101, String(anchors.length));
  assert('distinct quotes total 96', distinct.size === 96, String(distinct.size));
  assert('verified occurrences are 94/101', counts.verified === 94, String(counts.verified));
  assert('verified distinct quotes are 90/96', verifiedQuotes.size === 90, String(verifiedQuotes.size));
  assert('two occurrences are reported ambiguous', counts.ambiguous === 2, String(counts.ambiguous));
  assert('three occurrences need reattribution', counts.needs_reattribution === 3, String(counts.needs_reattribution));
  assert('two occurrences are unresolved', counts.unresolved === 2, String(counts.unresolved));
  assert('no anchor was silently reattributed', reattributed.length === 0, String(reattributed.length));
  assert('unresolved occurrences are exactly the renamed symbol lines', results.filter((result) => result.status === 'unresolved').every((result) => result.anchor.quote.includes('locate')));
  assert('no flagged quote itself contains the renamed symbol', results.filter((result) => result.status === 'needs_reattribution').every((result) => !result.anchor.quote.includes('locate')));
  assert('every flagged quote still exists in the revision', results.filter((result) => result.status === 'needs_reattribution').every((result) => after.includes(result.anchor.quote)));
  assert('the ambiguous quote is a genuine repeat with identical neighbours', [...new Set(results.filter((result) => result.status === 'ambiguous').map((result) => result.anchor.quote))].length === 1);
}

// ------------------------------------------------------------------ AC-7

section('AC-7 edges_unknown is distinct from no_edges');
{
  const store = new ReferenceStore();
  const a = 'Importing file declares a dependency.';
  const b = 'Imported file exists.';
  store.appendClaim({ text: a, anchors: [span('a.js', a, 'o|p', 0, a.length)] });
  store.appendClaim({ text: b, anchors: [span('b.js', b, 'q|r', 0, b.length)] });

  const unknown = store.relationshipsOf(claimId(a));
  assert('no declared extractor yields edges_unknown', unknown.status === 'edges_unknown', unknown.status);
  const none = store.relationshipsOf(claimId(a), { extractor: 'code.imports' });
  assert('a declared extractor that found nothing yields no_edges', none.status === 'no_edges', none.status);
  assert('the two are different statuses', unknown.status !== none.status);
  assert('edges_unknown never reports a count', !('count' in unknown) && unknown.edges.length === 0);
}

// ------------------------------------------------------------------ summary

console.log(`\nschema acceptance v2 (A1′): ${checks - failed}/${checks} checks passed`);
process.exit(failed === 0 ? 0 : 1);
