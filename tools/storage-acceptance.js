/**
 * D1 storage acceptance — do the logical distinctions survive physical persistence?
 *
 * Every invariant here is tested by attempting to violate it in SQLite, not by reading the schema and
 * agreeing with it. AC-1 … AC-7 are exercised against real tables; where storage can enforce something a
 * convention cannot (identity immutability, assessment independence, append-only history), the check
 * asserts that the database itself refuses.
 *
 * Usage: node tools/storage-acceptance.js
 */

import { AraStore, NoProvenanceError } from './ara-storage.js';
import { digest, normalizeClaim } from '../src/canonical.js';

const H = (schema, ...parts) => digest({ schema, parts }).slice(0, 20);
const claimId = (text, domain = 'prose') => `clm_${H('ara/claim/v1', normalizeClaim(text), domain)}`;
const anchorIdOf = (source, quote, context) => `anc_${H('ara/anchor/v2', normalizeClaim(quote), source, context)}`;
const relationshipId = (from, to, type) => `rel_${H('ara/relationship/v1', from, to, type)}`;
const assessmentId = (claim, question, model, at) => `asm_${H('ara/assessment/v1', claim, question, model, at)}`;
const span = (source, quote, context, start, end) => ({ source_id: source, quote, context, loc_start: start, loc_end: end });

let checks = 0;
let failures = 0;
const assert = (name, condition, detail = '') => {
  checks += 1;
  if (!condition) failures += 1;
  console.log(`  ${condition ? 'ok  ' : 'FAIL'} ${name}${condition || !detail ? '' : ` — ${detail}`}`);
};
const refuses = (name, fn, fragment = '') => {
  let error = null;
  try { fn(); } catch (caught) { error = caught; }
  assert(name, error !== null && String(error.message).includes(fragment), error ? error.message : 'no error raised');
};
const section = (title) => console.log(`\n${title}`);

// ------------------------------------------------------------------ AC-1

section('AC-1 replay equals projection, history append-only');
{
  const store = new AraStore();
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
  const replayed = AraStore.replay(store.events()).projection();
  assert('replay from the event log reproduces the projection byte for byte', incremental === replayed);
  assert('projection is stable across repeated reads', store.projection() === incremental);
  assert('no event removed a claim', store.information([a, b]).length === 2);
  assert('retraction kept the row and changed its state', store.information([b])[0].state === 'unknown');
  assert('supersede kept both revisions', store.db.prepare('SELECT COUNT(*) AS n FROM claims').get().n === 4);
  assert('the superseded claim records its window', store.db.prepare('SELECT valid_until FROM claims WHERE claim_id = ?').get(claimId('The service keeps three replicas.')).valid_until !== null);
  assert('conflict resolution recorded its basis', store.db.prepare('SELECT conflict_resolved_by FROM claims WHERE claim_id = ?').get(a).conflict_resolved_by === 'ret.md revision 3 governs');

  refuses('an event cannot be updated', () => store.db.prepare("UPDATE events SET actor = 'nobody' WHERE event_id = 1").run(), 'append-only');
  refuses('an event cannot be deleted', () => store.db.prepare('DELETE FROM events WHERE event_id = 1').run(), 'append-only');
}

// ------------------------------------------------------------------ AC-2

section('AC-2 provenance cannot be omitted');
{
  const store = new AraStore();
  let error = null;
  try { store.appendClaim({ text: 'An unanchored assertion.', anchors: [] }); } catch (caught) { error = caught; }
  assert('a claim without an anchor is refused', error instanceof NoProvenanceError);
  assert('the refusal wrote no event', store.db.prepare('SELECT COUNT(*) AS n FROM events').get().n === 0);

  refuses('an anchor without a birth context is refused', () => store.appendClaim({ text: 'Q.', anchors: [{ source_id: 'q.md', quote: 'Q.', loc_start: 0, loc_end: 2 }] }), 'birth context');
  refuses('a relationship without an extractor is refused', () => store.appendClaim({
    text: 'A depends on B.',
    anchors: [span('x.md', 'A depends on B.', 'g|h', 0, 14)],
    relationships: [{ relationship_id: relationshipId(claimId('A depends on B.'), claimId('A depends on B.'), 'depends_on'), type: 'depends_on', from_claim_id: claimId('A depends on B.'), to_claim_id: claimId('A depends on B.'), provenance: [] }],
  }), 'without extractor');

  const target = 'B exists.';
  const source = 'A imports B.';
  const from = claimId(source);
  const to = claimId(target);
  store.appendClaim({ text: target, anchors: [span('b.js', target, 'i|j', 0, 9)] });
  const edge = { relationship_id: relationshipId(from, to, 'imports_module'), type: 'imports_module', from_claim_id: from, to_claim_id: to };
  store.appendClaim({ text: source, anchors: [span('a.js', source, 'k|l', 0, 12)], relationships: [{ ...edge, provenance: [{ extractor: 'code.esm.lexical', extractor_version: '1.1.0', method: 'line-lexical' }] }] });
  store.appendClaim({ text: source, anchors: [span('a.js', source, 'k|l', 0, 12)], relationships: [{ ...edge, provenance: [{ extractor: 'code.esm.ast', extractor_version: '2.0.0', method: 'ast' }] }] });
  assert('two extractors produce one relationship row', store.db.prepare('SELECT COUNT(*) AS n FROM relationships').get().n === 1);
  assert('that relationship keeps both proofs', store.db.prepare('SELECT COUNT(*) AS n FROM relationship_provenance').get().n === 2);
  assert('provenance is not part of relationship identity', store.db.prepare('SELECT relationship_id FROM relationships').get().relationship_id === edge.relationship_id);
  assert('no relationship exists without provenance', store.invariants().relationships_without_provenance === 0);
  assert('no claim exists without an anchor', store.invariants().claims_without_anchor === 0);
}

// ------------------------------------------------------------------ AC-3

section('AC-3 the four questions use disjoint physical columns');
{
  const store = new AraStore();
  const text = 'The service keeps three replicas.';
  const id = claimId(text);
  const assessment = (model, probability, at) => ({ assessment_id: assessmentId(id, 'replicas', model, at), question_id: 'replicas', model, probability, verdict: 'supported', assessed_at: at });
  store.appendClaim({ text, anchors: [span('svc.md', text, 'm|n', 0, 33)], assessments: [assessment('model-a', 0.98, 't1')] });
  store.appendClaim({ text, anchors: [span('svc.md', text, 'm|n', 0, 33)], assessments: [assessment('model-b', 0.71, 't2')] });

  const information = store.information([id]);
  const provenance = store.provenance(id);
  const reliability = store.reliability(id);
  assert('each of the three tables returns rows', information.length === 1 && provenance.length === 1 && reliability.length === 2);

  const fields = {
    information: Object.keys(information[0]),
    provenance: Object.keys(provenance[0]),
    relationships: AraStore.COLUMNS.relationships,
    reliability: Object.keys(reliability[0]),
  };
  const names = Object.keys(fields);
  const overlaps = [];
  for (let i = 0; i < names.length; i += 1) {
    for (let j = i + 1; j < names.length; j += 1) {
      for (const field of fields[names[i]]) if (fields[names[j]].includes(field)) overlaps.push(`${field}:${names[i]}/${names[j]}`);
    }
  }
  assert('no column is shared between the four answer sets', overlaps.length === 0, overlaps.join(', '));
  assert('truth is not in the information set', !fields.information.includes('probability'));
  assert('completeness is not in the reliability set', !fields.reliability.includes('class_recall'));
  assert('provenance does not carry the claim text', !fields.provenance.includes('canonical_text'));
  // Assessment ids are content hashes: `ORDER BY assessment_id` is not chronological. Ordering must use
  // assessed_at, so this check asserts the set, not the row order.
  assert("a second model's assessment did not overwrite the first", reliability.length === 2
    && reliability.some((row) => row.probability === 0.98) && reliability.some((row) => row.probability === 0.71));
  assert('a reused claim keeps exactly one identity', store.db.prepare('SELECT COUNT(*) AS n FROM claims').get().n === 1);
  refuses('an assessment id cannot be reused for a different verdict', () => store.appendClaim({
    text, anchors: [span('svc.md', text, 'm|n', 0, 33)], assessments: [assessment('model-a', 0.4, 't1')],
  }), 'UNIQUE');
}

// ------------------------------------------------------------------ AC-4

section('AC-4 unknown is stored as null, never as zero');
{
  const store = new AraStore();
  const mismatch = store.writeCoverage({ scope: 'repo:code', domain: 'code', requiredSetDigest: 'abc123', instrument: { name: 'prose_rules', domain: 'prose' }, covered: 0, total: 12, unanchored: 412 })[0];
  assert('an instrument mismatch yields no measured numbers', mismatch.measured_covered === null && mismatch.measured_total === null);
  assert('the stored null is not zero', mismatch.measured_covered !== 0 && mismatch.measured_total !== 0);
  assert('the fit is recorded as mismatch', mismatch.instrument_fit === 'mismatch');
  const absent = store.writeCoverage({ scope: 'repo:empty', domain: 'code', requiredSetDigest: 'abc123', instrument: null, covered: 0, total: 12, unanchored: 0 })[0];
  assert('an absent instrument is recorded as absent', absent.instrument_fit === 'absent');
  const verdict = store.mayProceed(mismatch, 0.99);
  assert('sufficiency names the instrument side', verdict.ok === false && verdict.side === 'instrument');
  refuses('the database refuses a measured value with a mismatched instrument', () => store.db.prepare(`INSERT INTO coverage (coverage_id, scope, domain, required_set_digest, instrument_fit, measured_covered, measured_total, unanchored_claims)
    VALUES ('bad', 'x', 'code', 'd', 'mismatch', 0, 12, 0)`).run(), 'CHECK');
  assert('no row stores a zero in place of unknown', store.invariants().coverage_with_zero_instead_of_unknown === 0);
}

// ------------------------------------------------------------------ AC-5

section('AC-5 repeated occurrences: distinct contexts persist, identical contexts collapse');
{
  const store = new AraStore();
  const text = 'records';
  const id = claimId('Records are purged.');
  const anchors = [
    span('a.js', text, 'alpha|ctx1', 0, 7),
    span('a.js', text, 'beta|ctx2', 10, 17),
    span('a.js', text, 'gamma|ctx3', 20, 27),
  ];
  store.appendClaim({ text: 'Records are purged.', anchors });
  const rows = store.provenance(id);
  assert('three occurrences persist as three anchors', rows.length === 3);
  assert('the anchors have three distinct identities', new Set(rows.map((row) => anchorIdOf('a.js', text, row.context_fingerprint))).size === 3);

  // Identical neighbour context collapses to one identity within a claim: the composite key makes the
  // limitation explicit instead of silently storing two rows that claim to be different occurrences.
  const collapse = claimId('Ready implies run.');
  store.appendClaim({ text: 'Ready implies run.', anchors: [span('b.js', 'run();', 'if (ready) {|}', 0, 6), span('b.js', 'run();', 'if (ready) {|}', 20, 26)] });
  assert('identical-context occurrences collapse to one stored row', store.db.prepare("SELECT COUNT(*) AS n FROM anchors WHERE claim_id = ? AND quote = 'run();'").get(collapse).n === 1);

  const shared = claimId('A second claim cites the same occurrence.');
  store.appendClaim({ text: 'A second claim cites the same occurrence.', anchors: [span('b.js', 'run();', 'if (ready) {|}', 0, 6)] });
  assert('two claims may cite one occurrence with the same identity', store.db.prepare("SELECT COUNT(DISTINCT anchor_id) AS n FROM anchors WHERE quote = 'run();'").get().n === 1);
  assert('each citation is its own row', store.db.prepare("SELECT COUNT(*) AS n FROM anchors WHERE quote = 'run();'").get().n === 2);
  assert('the second claim did not collide with the first', store.provenance(shared).length === 1);
}

// ------------------------------------------------------------------ AC-6

section('AC-6 resolution status is mutable, identity is not');
{
  const store = new AraStore();
  const text = 'The cache is invalidated.';
  const id = claimId(text);
  store.appendClaim({ text, anchors: [span('svc.md', text, 'o|p', 40, 69)] });
  const anchorId = anchorIdOf('svc.md', text, 'o|p');
  const status = () => store.db.prepare('SELECT resolution_status FROM anchors WHERE anchor_id = ?').get(anchorId).resolution_status;
  assert('a new anchor is stored as verified', status() === 'verified');

  store.db.prepare("UPDATE anchors SET resolution_status = 'needs_reattribution' WHERE anchor_id = ?").run(anchorId);
  assert('a status change is permitted', status() === 'needs_reattribution');
  assert('the identity is unchanged by the status change', store.db.prepare('SELECT anchor_id FROM anchors WHERE anchor_id = ?').get(anchorId).anchor_id === anchorId);

  refuses('the quote cannot be rewritten in place', () => store.db.prepare("UPDATE anchors SET quote = 'something else' WHERE anchor_id = ?").run(anchorId), 'immutable');
  refuses('the birth context cannot be rewritten in place', () => store.db.prepare("UPDATE anchors SET context_fingerprint = 'other' WHERE anchor_id = ?").run(anchorId), 'immutable');
  refuses('an anchor cannot be deleted to hide a break', () => store.db.prepare('DELETE FROM anchors WHERE anchor_id = ?').run(anchorId), 'never deleted');
  refuses('an invalid status cannot be stored', () => store.db.prepare("UPDATE anchors SET resolution_status = 'probably' WHERE anchor_id = ?").run(anchorId), 'CHECK');

  const moved = store.db.prepare('UPDATE anchors SET loc_start = 41, loc_end = 70 WHERE anchor_id = ?').run(anchorId);
  assert('the locator may move', moved.changes === 1);
  assert('the status survives the move', status() === 'needs_reattribution');

  const statuses = ['verified', 'ambiguous', 'needs_reattribution', 'unresolved'];
  assert('all four statuses are storable', statuses.every((value) => { store.db.prepare('UPDATE anchors SET resolution_status = ? WHERE anchor_id = ?').run(value, anchorId); return status() === value; }));
}

// ------------------------------------------------------------------ AC-7

section('AC-7 edges_unknown and no_edges are different stored answers');
{
  const store = new AraStore();
  const a = 'Importing file declares a dependency.';
  const b = 'Imported file exists.';
  store.appendClaim({ text: a, anchors: [span('a.js', a, 'q|r', 0, a.length)] });
  store.appendClaim({ text: b, anchors: [span('b.js', b, 's|t', 0, b.length)] });

  const unknown = store.relationshipsOf(claimId(a));
  assert('no declared extractor yields edges_unknown', unknown.status === 'edges_unknown');
  const undeclared = store.relationshipsOf(claimId(a), { extractor: 'code.esm.lexical' });
  assert('an extractor never declared for the scope yields edges_unknown', undeclared.status === 'edges_unknown' && undeclared.reason.includes('never declared'));
  store.declareExtractor({ scope: 'repo:code', extractor: 'code.esm.lexical', version: '1.1.0' });
  const none = store.relationshipsOf(claimId(a), { extractor: 'code.esm.lexical' });
  assert('a declared extractor that found nothing yields no_edges', none.status === 'no_edges');
  assert('the two are different statuses', unknown.status !== none.status);
  assert('edges_unknown never reports a count', !('count' in unknown));
  refuses('a relationship cannot reference a missing claim', () => store.appendClaim({
    text: 'Dangling edge.',
    anchors: [span('d.js', 'Dangling edge.', 'u|v', 0, 14)],
    relationships: [{ relationship_id: relationshipId(claimId('Dangling edge.'), 'clm_missing', 'depends_on'), type: 'depends_on', from_claim_id: claimId('Dangling edge.'), to_claim_id: 'clm_missing', provenance: [{ extractor: 'x', extractor_version: '1', method: 'm' }] }],
  }), 'FOREIGN KEY');
}

// ------------------------------------------------------------------ replay with everything stored

section('replay covers coverage, declarations and provenance');
{
  const store = new AraStore();
  store.appendClaim({ text: 'Replay includes coverage.', anchors: [span('r.md', 'Replay includes coverage.', 'w|x', 0, 25)], assessments: [{ assessment_id: assessmentId(claimId('Replay includes coverage.'), 'q', 'm', 't1'), question_id: 'q', model: 'm', probability: 0.5, verdict: 'supported', assessed_at: 't1' }] });
  store.writeCoverage({ scope: 'repo:prose', domain: 'prose', requiredSetDigest: 'd1', instrument: { name: 'prose_rules', domain: 'prose' }, covered: 3, total: 12, unanchored: 1 });
  store.declareExtractor({ scope: 'repo:code', extractor: 'code.esm.lexical', version: '1.1.0' });
  assert('replay reproduces coverage and declarations', AraStore.replay(store.events()).projection() === store.projection());
  assert('replay preserves assessment independence', AraStore.replay(store.events()).reliability(claimId('Replay includes coverage.')).length === 1);
  assert('replay preserves the coverage null', AraStore.replay(store.events()).coverageOf('repo:prose')[0].measured_covered === 3);
}

console.log(`\nstorage acceptance: ${checks - failures}/${checks} checks passed`);
process.exit(failures === 0 ? 0 : 1);
