/**
 * ARA schema acceptance tests — AC-1 … AC-7 against an in-memory reference model.
 *
 * This is a *reference implementation of the contract*, not of ARA: no database, no migration, no
 * storage decision. Its only job is to test whether the schema in ARA-SCHEMA-01.md can actually
 * satisfy its own acceptance criteria.
 *
 * What the existing measurements already support (and what they do not) is stated in
 * ARA-SCHEMA-VALIDATION-01.md. A test that fails here is a finding about the schema, not a bug to
 * be worked around.
 *
 * Usage: node tools/schema-acceptance.js
 */

import { readFile } from 'node:fs/promises';

import { anchorId, resolveAnchor } from '../cards/identity.js';
import { digest, normalizeClaim } from '../src/canonical.js';

const ROOT = new URL('../', import.meta.url);
const H = (schema, ...parts) => digest({ schema, parts }).slice(0, 20);

// ------------------------------------------------------------------ identity

const claimId = (text, domain = 'prose') => `clm_${H('ara/claim/v1', normalizeClaim(text), domain)}`;
const anchorIdOf = (sourceId, quote, occurrence = 1) => `anc_${H('ara/anchor/v1', sourceId, normalizeClaim(quote), String(occurrence))}`;
const relationshipId = (from, to, type) => `rel_${H('ara/relationship/v1', from, to, type)}`;
const assessmentId = (claimIdValue, question, model, at) => `asm_${H('ara/assessment/v1', claimIdValue, question, model, at)}`;
const coverageId = (scope, setDigest, instrument, domain) => `cov_${H('ara/coverage/v1', scope, setDigest, instrument, domain)}`;

// ------------------------------------------------------------------ reference store

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

  // The only write path. Every mutation is an event; projections are derived.
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

  // ---- write API with the schema's preconditions

  appendClaim({ text, domain = 'prose', anchors = [], relationships = [], assessments = [], actor = 'extractor' }) {
    const id = claimId(text, domain);
    if (anchors.length === 0) throw new NoProvenanceError(`claim ${id} has no anchor`);
    for (const anchor of anchors) {
      if (!anchor.source_id || !anchor.quote) throw new NoProvenanceError('anchor missing source or quote');
      if (!Number.isInteger(anchor.occurrence) || anchor.occurrence < 1) throw new NoProvenanceError('anchor missing occurrence');
    }
    for (const relationship of relationships) {
      if (!relationship.provenance?.length || !relationship.provenance[0].extractor) throw new NoProvenanceError('relationship without extractor');
    }
    return this.emit('append', actor, { claim_id: id, canonical_text: text, domain }, {
      anchors: anchors.map((anchor) => ({
        anchor_id: anchorIdOf(anchor.source_id, anchor.quote, anchor.occurrence),
        claim_id: id,
        source_id: anchor.source_id,
        source_revision: anchor.source_revision ?? null,
        occurrence: anchor.occurrence,
        locator: { start: anchor.start, end: anchor.end },
        quote: anchor.quote,
      })),
      relationships,
      assessments,
    });
  }

  supersede(oldClaimId, { text, domain = 'prose', anchor }) {
    const id = claimId(text, domain);
    this.emit('append', 'extractor', { claim_id: id, canonical_text: text, domain }, {
      anchors: [{ anchor_id: anchorIdOf(anchor.source_id, anchor.quote, anchor.occurrence), claim_id: id, source_id: anchor.source_id, source_revision: null, occurrence: anchor.occurrence, locator: { start: anchor.start, end: anchor.end }, quote: anchor.quote }],
    });
    return this.emit('supersede', 'system', { claim_id: oldClaimId }, { replacement_claim_id: id });
  }

  conflict(a, b, actor = 'adjudicator') { return this.emit('conflict', actor, { claim_id: a }, { other_claim_id: b }); }
  resolve(a, b, basis) { return this.emit('resolve', 'adjudicator', { claim_id: a }, { other_claim_id: b }, basis); }
  retract(id, cause) { return this.emit('retract', 'system', { claim_id: id }, {}, cause); }

  // ---- replay: the projection must be derivable from the log alone

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

  // ---- the four questions, with disjoint declared field sets

  information(scopeIds) {
    return { fields: ['claim_id', 'canonical_text', 'domain', 'state'], data: scopeIds.map((id) => this.claims.get(id)).filter(Boolean) };
  }

  provenance(id) {
    const anchors = [...this.anchors.values()].filter((anchor) => anchor.claim_id === id);
    return { fields: ['source_id', 'source_revision', 'locator', 'occurrence', 'quote'], data: anchors };
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

// ------------------------------------------------------------------ coverage / sufficiency

function measureCoverage({ scope, domain, instrument, requiredSet, covered, unanchored }) {
  const fit = instrument ? (instrument.domain === domain ? 'fit' : 'mismatch') : 'absent';
  const record = {
    coverage_id: coverageId(scope, requiredSet.digest, instrument?.name ?? 'none', domain),
    scope,
    domain,
    required_set: requiredSet,
    instrument: instrument ?? null,
    measured: fit === 'fit' ? { covered, total: requiredSet.items, class_recall: covered / requiredSet.items } : null,
    instrument_fit: fit,
    unanchored_claims: unanchored,
  };
  return record;
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
  const mark = condition ? 'ok  ' : 'FAIL';
  console.log(`  ${mark} ${name}${condition || !detail ? '' : ` — ${detail}`}`);
};
const section = (title) => console.log(`\n${title}`);

// ------------------------------------------------------------------ AC-1 replay equivalence

section('AC-1 event replay equals projection');
{
  const store = new ReferenceStore();
  store.appendClaim({ text: 'The service keeps three replicas.', anchors: [{ source_id: 'svc.md', quote: 'The service keeps three replicas.', occurrence: 1, start: 0, end: 33 }] });
  store.appendClaim({ text: 'Nothing is deleted before that window closes.', anchors: [{ source_id: 'ret.md', quote: 'Nothing is deleted before that window closes.', occurrence: 1, start: 10, end: 55 }] });
  store.supersede(claimId('The service keeps three replicas.'), { text: 'The service keeps four replicas.', anchor: { source_id: 'svc.md', quote: 'The service keeps four replicas.', occurrence: 1, start: 0, end: 32 } });
  const a = claimId('Nothing is deleted before that window closes.');
  const b = claimId('Records are purged after 30 days.');
  store.appendClaim({ text: 'Records are purged after 30 days.', anchors: [{ source_id: 'ret.md', quote: 'Records are purged after 30 days.', occurrence: 1, start: 60, end: 94 }] });
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

// ------------------------------------------------------------------ AC-2 provenance enforcement

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
    store.appendClaim({ text: 'A depends on B.', anchors: [{ source_id: 'x.md', quote: 'A depends on B.', occurrence: 1, start: 0, end: 14 }], relationships: [{ relationship_id: relationshipId(from, from, 'depends_on'), from_claim_id: from, to_claim_id: from, type: 'depends_on', provenance: [] }] });
  } catch (error) { relThrew = error; }
  assert('relationship without an extractor is refused', relThrew instanceof NoProvenanceError, String(relThrew?.name));

  let occThrew = null;
  try { store.appendClaim({ text: 'Q.', anchors: [{ source_id: 'q.md', quote: 'Q.', start: 0, end: 2 }] }); } catch (error) { occThrew = error; }
  assert('anchor without an occurrence ordinal is refused', occThrew instanceof NoProvenanceError, String(occThrew?.name));

  // Relationship identity vs proof identity: one logical edge, many independent proofs.
  const relStore = new ReferenceStore();
  const target = 'B exists.';
  const source = 'A imports B.';
  const edge = { relationship_id: relationshipId(claimId(source), claimId(target), 'depends_on'), from_claim_id: claimId(source), to_claim_id: claimId(target), type: 'depends_on' };
  relStore.appendClaim({ text: target, anchors: [{ source_id: 'b.js', quote: target, occurrence: 1, start: 0, end: 9 }] });
  const anchorA = [{ source_id: 'a.js', quote: source, occurrence: 1, start: 0, end: 12 }];
  relStore.appendClaim({ text: source, anchors: anchorA, relationships: [{ ...edge, provenance: [{ extractor: 'code.imports', extractor_version: '1' }] }] });
  relStore.appendClaim({ text: source, anchors: anchorA, relationships: [{ ...edge, provenance: [{ extractor: 'rules.prose', extractor_version: '1' }] }] });
  const storedEdge = relStore.relationships.get(edge.relationship_id);
  assert('two extractors agreeing produce one logical edge', relStore.relationships.size === 1, `edges=${relStore.relationships.size}`);
  assert('that edge keeps both independent proofs', storedEdge?.provenance.length === 2, storedEdge?.provenance.map((proof) => proof.extractor).join(','));
}

// ------------------------------------------------------------------ AC-3 separation of the four questions

section('AC-3 the four questions use disjoint fields');
{
  const store = new ReferenceStore();
  const text = 'The service keeps three replicas.';
  const id = claimId(text);
  store.appendClaim({
    text,
    anchors: [{ source_id: 'svc.md', quote: text, occurrence: 1, start: 0, end: 33 }],
    assessments: [{ assessment_id: assessmentId(id, 'replicas', 'm', 't1'), claim_id: id, question_id: 'replicas', model: 'm', probability: 0.98, verdict: 'supported', assessed_at: 't1' }],
  });
  const a = store.information([id]);
  const b = store.provenance(id);
  const c = store.relationshipsOf(id, { extractor: 'code.imports' });
  const d = store.reliability(id);
  const sets = { information: new Set(a.fields), provenance: new Set(b.fields), relationships: new Set(['relationship_id', 'type', 'from_claim_id', 'to_claim_id', 'extractor']), reliability: new Set(d.fields) };
  const names = Object.keys(sets);
  let overlaps = 0;
  for (let i = 0; i < names.length; i += 1) {
    for (let j = i + 1; j < names.length; j += 1) {
      for (const field of sets[names[i]]) if (sets[names[j]].has(field)) { overlaps += 1; console.log(`      overlap ${field}: ${names[i]} ∩ ${names[j]}`); }
    }
  }
  assert('no field is shared between the four answer sets', overlaps === 0, `${overlaps} overlaps`);
  assert('truth of a claim is not in the information set', !sets.information.has('probability'));
  assert('completeness is not in the reliability set', !sets.reliability.has('class_recall') && !sets.reliability.has('covered'));
  assert('provenance does not carry the claim text', !sets.provenance.has('canonical_text'));

  // Assessment independence: a reused claim is never a reused verdict.
  const secondAssessment = { assessment_id: assessmentId(id, 'replicas', 'other-model', 't2'), claim_id: id, question_id: 'replicas', model: 'other-model', probability: 0.71, verdict: 'supported', assessed_at: 't2' };
  store.appendClaim({ text, anchors: [{ source_id: 'svc.md', quote: text, occurrence: 1, start: 0, end: 33 }], assessments: [secondAssessment] });
  assert('a second model\'s assessment does not overwrite the first', store.assessments.size === 2, `assessments=${store.assessments.size}`);
  assert('a reused claim keeps exactly one identity', store.claims.size === 1 && [...store.assessments.values()].every((assessment) => assessment.claim_id === id));
  assert('the two assessments disagree without a resolution', [...store.assessments.values()].map((assessment) => assessment.probability).join(',') === '0.98,0.71');
}

// ------------------------------------------------------------------ AC-4 unknown is not zero

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

// ------------------------------------------------------------------ AC-5 repeated-occurrence attribution

section('AC-5 repeated occurrences keep distinct anchors');
{
  const text = 'if (ready) {\n  run();\n}\nif (ready) {\n  run();\n}\nif (ready) {\n  run();\n}\n';
  const quote = '  run();';
  const occurrences = [1, 2, 3];
  const ids = occurrences.map((occurrence) => anchorIdOf('t.js', quote, occurrence));
  assert('three occurrences produce three distinct anchor ids', new Set(ids).size === 3, ids.join(','));
  const legacy = occurrences.map(() => anchorId({ source_id: 't.js', quote }));
  assert('content-only ids would collapse them to one', new Set(legacy).size === 1);

  // Locators must be the real occurrence offsets. A fixed step (index * 5) lands on the first
  // occurrence three times and the disambiguator then correctly resolves all three to it — a test
  // defect that looks exactly like an attribution failure.
  const positions = [];
  for (let at = text.indexOf(quote); at !== -1; at = text.indexOf(quote, at + 1)) positions.push(at);
  assert('probe found three real occurrences', positions.length === 3, JSON.stringify(positions));
  const resolved = occurrences.map((occurrence, index) => resolveAnchor({ sources: [{ id: 't.js', content: { text } }] }, { anchor_id: ids[index], quote, locator: { source_id: 't.js', start: positions[index], end: positions[index] + quote.length } }));
  assert('each anchor resolves to its own offset', new Set(resolved.map((result) => result.span.start)).size === 3, JSON.stringify(resolved.map((result) => result.span.start)));
  assert('all three resolve successfully', resolved.every((result) => result.ok));

  const corpus = await readFile(new URL('tools/score-transcript.js', ROOT), 'utf8');
  const lineCounts = new Map();
  for (const line of corpus.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length < 8) continue;
    lineCounts.set(trimmed, (lineCounts.get(trimmed) ?? 0) + 1);
  }
  const [worstQuote, count] = [...lineCounts.entries()].sort((a, b) => b[1] - a[1])[0];
  const corpusIds = Array.from({ length: count }, (_, index) => anchorIdOf('tools/score-transcript.js', worstQuote, index + 1));
  assert(`real corpus: "${worstQuote.slice(0, 28)}" repeats ${count}x and gets ${count} distinct ids`, new Set(corpusIds).size === count);
}

// ------------------------------------------------------------------ AC-6 revision stability

section('AC-6 identity survives a real revision, breaks exactly where the symbol is');
{
  const file = 'src/spans.js';
  const before = await readFile(new URL(file, ROOT), 'utf8');
  const after = before.replace(/\blocate\b/g, 'locateSpan');
  const anchors = [];
  const seen = new Map();
  for (const line of before.split('\n')) {
    const quote = line.trim();
    if (quote.length < 8) continue;
    const occurrence = (seen.get(quote) ?? 0) + 1;
    seen.set(quote, occurrence);
    anchors.push({ anchor_id: anchorIdOf(file, quote, occurrence), quote, locator: { source_id: file, start: before.indexOf(line), end: before.indexOf(line) + line.length } });
  }
  const results = anchors.map((anchor) => ({ anchor, result: resolveAnchor({ sources: [{ id: file, content: { text: after } }] }, anchor) }));
  const survived = results.filter((entry) => entry.result.ok);
  const broke = results.filter((entry) => !entry.result.ok);

  // Two units, both true: distinct content quotes (what CODE-STRESS-01 reported) and occurrences
  // (what occurrence-aware identity distinguishes). They differ because 5 quotes repeat.
  const contentId = (quote) => anchorId({ source_id: file, quote });
  const distinctQuotes = new Set(anchors.map((anchor) => contentId(anchor.quote))).size;
  const survivingQuotes = new Set(survived.map((entry) => contentId(entry.anchor.quote))).size;
  assert('occurrence-aware anchors outnumber distinct content quotes', anchors.length > distinctQuotes, `${anchors.length} occurrences vs ${distinctQuotes} quotes`);
  assert('distinct quotes survive at the measured rate (94/96)', survivingQuotes === 94 && distinctQuotes === 96, `${survivingQuotes}/${distinctQuotes}`);
  assert('occurrences survive at the same rate (99/101)', survived.length === 99 && anchors.length === 101, `${survived.length}/${anchors.length}`);
  assert('exactly the symbol lines break', broke.length === 2, `broke=${broke.length}`);
  assert('every break mentions the renamed symbol', broke.every((entry) => entry.anchor.quote.includes('locate')), broke.map((entry) => entry.anchor.quote.slice(0, 30)).join(' | '));
}

// ------------------------------------------------------------------ AC-7 unknown edges vs no edges

section('AC-7 edges_unknown is distinct from no_edges');
{
  const store = new ReferenceStore();
  const a = 'Importing file declares a dependency.';
  const b = 'Imported file exists.';
  store.appendClaim({ text: a, anchors: [{ source_id: 'a.js', quote: a, occurrence: 1, start: 0, end: a.length }] });
  store.appendClaim({ text: b, anchors: [{ source_id: 'b.js', quote: b, occurrence: 1, start: 0, end: b.length }] });

  const unknown = store.relationshipsOf(claimId(a));
  assert('no declared extractor yields edges_unknown', unknown.status === 'edges_unknown', unknown.status);
  const none = store.relationshipsOf(claimId(a), { extractor: 'code.imports' });
  assert('a declared extractor that found nothing yields no_edges', none.status === 'no_edges', none.status);
  assert('the two are different statuses', unknown.status !== none.status);
  assert('edges_unknown never reports a count', !('count' in unknown) && unknown.edges.length === 0);
}

// ------------------------------------------------------------------ summary

console.log(`\nschema acceptance: ${checks - failed}/${checks} checks passed`);
process.exit(failed === 0 ? 0 : 1);
