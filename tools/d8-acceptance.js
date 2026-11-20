/**
 * D8 acceptance — does the exchange keep AA's observations and ARA's evaluations apart?
 *
 * The central assertion is not that a happy path works, but that authority cannot cross: a submission
 * carrying AA confidence or verdicts is refused, and a response carrying anything resembling AA's own
 * judgement is refused before it leaves.
 *
 * Usage: node tools/d8-acceptance.js
 */

import { AraStore } from './ara-storage.js';
import { Exchange, FORBIDDEN_RESPONSE, mapStatus } from './d8-exchange.js';

let checks = 0;
let failures = 0;
const assert = (name, condition, detail = '') => {
  checks += 1;
  if (!condition) failures += 1;
  console.log(`  ${condition ? 'ok  ' : 'FAIL'} ${name}${condition || !detail ? '' : ` — ${detail}`}`);
};
const section = (title) => console.log(`\n${title}`);

const claim = (text, anchors, extra = {}) => ({ text, domain: 'prose', anchors, ...extra });
const anchor = (source, quote, context, revision, status = 'verified', start = 0, end = 40) => ({
  source_id: source, quote, context, source_revision: revision, status, loc_start: start, loc_end: end,
});
const envelope = (id, claims, extra = {}) => ({ schema: 'aa-ara/v1', direction: 'submit', submission_id: id, claims, ...extra });

// ------------------------------------------------------------------ 1. accepted

section('accepted submission');
{
  const store = new AraStore();
  const exchange = new Exchange(store);
  const result = exchange.submit(envelope('s1', [claim('The service keeps three replicas.', [anchor('svc.md', 'The service keeps three replicas.', 'a|b', 'r1')])]));
  assert('a well-formed observation is accepted', result.disposition === 'accepted', JSON.stringify(result));
  assert('the claim is stored once', store.db.prepare('SELECT COUNT(*) AS n FROM claims').get().n === 1);
  assert('the anchor is stored with verified status', store.db.prepare('SELECT resolution_status FROM anchors').get().resolution_status === 'verified');
  assert('the exchange created the event, not AA', store.events()[0].actor === 'aa.exchange' && store.events()[0].op === 'append');
  assert('the audit log records the acceptance', exchange.log.length === 1 && exchange.log[0].disposition === 'accepted');
}

// ------------------------------------------------------------------ 2. authority leak

section('authority cannot cross as evidence');
{
  const store = new AraStore();
  const exchange = new Exchange(store);
  const before = store.events().length;
  const withConfidence = exchange.submit(envelope('s2', [claim('The service keeps three replicas.', [anchor('svc.md', 'The service keeps three replicas.', 'a|b', 'r1')], { confidence: 0.93 })]));
  assert('a submission carrying AA confidence is rejected', withConfidence.disposition === 'rejected');
  assert('the rejection names the authority leak', String(withConfidence.reason).includes('authority_leak'));
  assert('nothing was written', store.events().length === before && store.db.prepare('SELECT COUNT(*) AS n FROM claims').get().n === 0);
  assert('the refusal is still audited', exchange.log.length === 1 && exchange.log[0].disposition === 'rejected');

  const withVerdict = exchange.submit(envelope('s3', [claim('A claim.', [anchor('x.md', 'A claim.', 'c|d', 'r1')], { verdict: 'supported' })]));
  assert('a verdict is rejected, not sanitised', withVerdict.disposition === 'rejected' && String(withVerdict.reason).includes('verdict'));
  const withAssessment = exchange.submit(envelope('s4', [claim('A claim.', [anchor('x.md', 'A claim.', 'c|d', 'r1')], { assessments: [{ probability: 0.9 }] })]));
  assert('an assessment smuggled into a submission is rejected', withAssessment.disposition === 'rejected');
}

// ------------------------------------------------------------------ 3. dispositions

section('duplicate, stale, previously unseen');
{
  const store = new AraStore();
  const exchange = new Exchange(store);
  const first = envelope('d1', [claim('Replicas are three.', [anchor('svc.md', 'Replicas are three.', 'a|b', 'r1')])]);
  exchange.submit(first);
  const events = store.events().length;

  const sameId = exchange.submit(first);
  assert('the same submission id is a duplicate', sameId.disposition === 'duplicate' && sameId.written === 0);
  assert('a duplicate writes no events', store.events().length === events);

  const otherId = exchange.submit(envelope('d2', [claim('Replicas are three.', [anchor('svc.md', 'Replicas are three.', 'a|b', 'r1')])]));
  assert('the same claim and anchors under a new id is a duplicate', otherId.disposition === 'duplicate');

  const unseen = exchange.submit(envelope('d3', [claim('A new observation.', [anchor('other.md', 'A new observation.', 'c|d', 'r1')])]));
  assert('a previously unseen claim is accepted', unseen.disposition === 'accepted');

  const advance = exchange.submit(envelope('d4', [claim('Replicas are four.', [anchor('svc.md', 'Replicas are four.', 'e|f', 'r2')])], { supersedes_revision: 'r1' }));
  assert('a declared revision advance is accepted', advance.disposition === 'accepted', JSON.stringify(advance));
  const stale = exchange.submit(envelope('d5', [claim('Replicas are three again.', [anchor('svc.md', 'Replicas are three again.', 'g|h', 'r1')])]));
  assert('an undeclared older revision is stale', stale.disposition === 'stale', JSON.stringify(stale));
  assert('a stale submission writes nothing', store.db.prepare('SELECT COUNT(*) AS n FROM claims').get().n === 3);
  assert('the stale reason names the source', String(stale.reason).includes('svc.md'));
}

// ------------------------------------------------------------------ 4. status mapping

section('statuses cross unchanged, never upgraded');
{
  const store = new AraStore();
  const exchange = new Exchange(store);
  exchange.submit(envelope('m1', [claim('Four statuses cross.', [
    anchor('s.md', 'Quoted ambiguous text.', 'i|j', 'r1', 'ambiguous', 0, 22),
    anchor('s.md', 'Quoted unmatched text.', 'k|l', 'r1', 'not_matched', 30, 52),
    anchor('s.md', 'Quoted stale text.', 'm|n', 'r1', 'stale', 60, 78),
    anchor('s.md', 'Quoted absent text.', 'o|p', 'r1', 'not_covered', 90, 110),
  ])]));
  const statuses = store.db.prepare('SELECT quote, resolution_status FROM anchors ORDER BY quote').all();
  const byQuote = Object.fromEntries(statuses.map((row) => [row.quote, row.resolution_status]));
  assert('ambiguous arrives as ambiguous', byQuote['Quoted ambiguous text.'] === 'ambiguous');
  assert('not_matched arrives as unresolved, not absent', byQuote['Quoted unmatched text.'] === 'unresolved');
  assert('stale arrives as needs_reattribution', byQuote['Quoted stale text.'] === 'needs_reattribution');
  assert('not_covered arrives as unresolved', byQuote['Quoted absent text.'] === 'unresolved');
  assert('no status is upgraded to verified at the boundary', statuses.every((row) => row.resolution_status !== 'verified'));
  assert('the mapping is total over the AA vocabulary', ['verified', 'ambiguous', 'stale', 'not_matched', 'not_covered'].every((status) => ['verified', 'ambiguous', 'needs_reattribution', 'unresolved'].includes(mapStatus(status))));
}

// ------------------------------------------------------------------ 5. unknowns

section('explicit unknowns are recorded, not turned into claims');
{
  const store = new AraStore();
  const exchange = new Exchange(store);
  const result = exchange.submit(envelope('u1', [claim('Known claim.', [anchor('u.md', 'Known claim.', 'q|r', 'r1')])], {
    unknowns: [{ kind: 'retrieval', detail: 'source u.md head revision unavailable' }],
  }));
  assert('a submission with explicit unknowns is accepted', result.disposition === 'accepted');
  assert('unknowns do not become claims', store.db.prepare('SELECT COUNT(*) AS n FROM claims').get().n === 1);
  const response = exchange.respond(result.claim_ids);
  assert('the response reports unknowns received', response.unknowns_received === 1);
  assert('the unknown is not rendered as a resolution status', !JSON.stringify(response.claims).includes('head revision unavailable'));
}

// ------------------------------------------------------------------ 6. response shape

section('ARA returns evaluation, not observation');
{
  const store = new AraStore();
  const exchange = new Exchange(store);
  const result = exchange.submit(envelope('r1', [claim('Response subject.', [anchor('v.md', 'Response subject.', 's|t', 'r1')])]));
  const response = exchange.respond(result.claim_ids, { scope: 'repo:prose' });
  assert('the response carries ARA assessments and coverage', Array.isArray(response.claims) && Array.isArray(response.coverage));
  assert('with no coverage recorded the insufficiency names the instrument side', response.insufficiency.side === 'instrument');
  const serialised = JSON.stringify(response);
  const leaks = FORBIDDEN_RESPONSE.filter((field) => serialised.includes(`"${field}"`));
  assert('the response carries no forbidden authority field', leaks.length === 0, leaks.join(','));

  store.writeCoverage({ scope: 'repo:prose', domain: 'prose', requiredSetDigest: 'd1', instrument: { name: 'prose_rules', domain: 'prose' }, covered: 3, total: 12, unanchored: 2 });
  const insufficient = exchange.respond(result.claim_ids, { scope: 'repo:prose' });
  assert('incomplete coverage names the coverage side', insufficient.insufficiency.side === 'coverage' && insufficient.insufficiency.detail === '3/12');
  assert('no zero is reported for missing coverage', insufficient.insufficiency.detail !== 0);
}

// ------------------------------------------------------------------ 7. audit and replay

section('exchange is independently auditable and replayable');
{
  const store = new AraStore();
  const exchange = new Exchange(store);
  exchange.submit(envelope('a1', [claim('Audit claim one.', [anchor('a.md', 'Audit claim one.', 'u|v', 'r1')])]));
  exchange.submit(envelope('a2', [claim('Audit claim one.', [anchor('a.md', 'Audit claim one.', 'u|v', 'r1')], { confidence: 0.5 })]));
  exchange.submit(envelope('a3', [claim('Audit claim two.', [anchor('b.md', 'Audit claim two.', 'w|x', 'r1')])]));
  const result = exchange.submit(envelope('a4', [claim('Audit claim two.', [anchor('b.md', 'Audit claim two.', 'w|x', 'r1')])]));
  exchange.respond([result.claim_ids?.[0] ?? store.db.prepare('SELECT claim_id FROM claims LIMIT 1').get().claim_id]);

  assert('the audit chain is valid', exchange.audit().valid, exchange.audit().broken.join(','));
  assert('rejections are part of the audited history', exchange.log.some((entry) => entry.disposition === 'rejected'));

  const fresh = new AraStore();
  const replayed = Exchange.replay(exchange.log, fresh);
  assert('replay reproduces every disposition', replayed.divergences.length === 0, replayed.divergences.join(';'));
  assert('replay reproduces the store projection', fresh.projection() === store.projection());
  assert('replay reproduces the audit chain', replayed.audit.valid);

  const tampered = JSON.parse(JSON.stringify(exchange.log));
  tampered[0].envelope.claims[0].text = 'Audit claim one, edited later.';
  const auditAfterTamper = new Exchange(store);
  auditAfterTamper.log = tampered;
  assert('tampering with a recorded envelope breaks the chain', auditAfterTamper.audit().valid === false);
}

// ------------------------------------------------------------------ 8. malformed

section('malformed submissions are refused, not repaired');
{
  const store = new AraStore();
  const exchange = new Exchange(store);
  assert('wrong schema is refused', exchange.submit({ ...envelope('z1', [claim('X.', [anchor('x.md', 'X.', 'y|z', 'r1')])]), schema: 'other/v1' }).disposition === 'rejected');
  assert('wrong direction is refused', exchange.submit({ ...envelope('z2', [claim('X.', [anchor('x.md', 'X.', 'y|z', 'r1')])]), direction: 'response' }).disposition === 'rejected');
  assert('an empty claim list is refused', exchange.submit(envelope('z3', [])).disposition === 'rejected');
  assert('a malformed unknown is refused', exchange.submit(envelope('z4', [claim('X.', [anchor('x.md', 'X.', 'y|z', 'r1')])], { unknowns: [{ kind: 'retrieval' }] })).disposition === 'rejected');
  assert('no refusal wrote a claim', store.db.prepare('SELECT COUNT(*) AS n FROM claims').get().n === 0);
}

console.log(`\nD8 acceptance: ${checks - failures}/${checks} checks passed`);
process.exit(failures === 0 ? 0 : 1);
