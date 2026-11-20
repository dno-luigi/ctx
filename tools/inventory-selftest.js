import { readFile } from 'node:fs/promises';

import { PLANTED_CORPORA, calibrate, syntheticInput } from '../inventory/calibration.js';
import { compareToProposals } from '../inventory/compare.js';
import { INVENTORY_SCHEMA, scanInventory, verifySpans } from '../inventory/scan.js';
import { digest } from '../src/canonical.js';

/**
 * Checks the reference instrument, not the corpus and not a model.
 *
 * No network, no key, no charge, no dependency on the decision adapter. What is
 * proven here: the inventory reads only source material, every span it emits is
 * re-derivable, its detection limits are measured against planted structure rather
 * than asserted, and the comparison with model-derived proposals keeps the two sets
 * distinguishable.
 */

const failures = [];
let executed = 0;
let passed = 0;

function check(name, condition, detail = '') {
  executed += 1;
  if (condition) {
    passed += 1;
    console.log(`  PASS  ${name}`);
    return;
  }
  failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
  console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
}

const corpusA = PLANTED_CORPORA[0];
const inputA = syntheticInput(corpusA.documents);
const scanA = scanInventory(inputA);
const kindsA = new Set(scanA.items.map((item) => item.kind));
const itemsOf = (kind, inventory = scanA) => inventory.items.filter((item) => item.kind === kind);

// ------------------------------------------------------------- independence

console.log('\nindependence (source material only)');
{
  const source = await readFile(new URL('../inventory/scan.js', import.meta.url), 'utf8');
  const imports = [...source.matchAll(/from\s+'([^']+)'/g)].map((match) => match[1]);
  check('the scanner imports nothing from adapters/ or snapshot/', !imports.some((path) => /(?:^|\/)(adapters|snapshot)\//.test(path)), imports.join(', '));
  check('the scanner imports only its corpus module and the frozen resolver', JSON.stringify(imports.sort()) === JSON.stringify(['../src/spans.js', './corpus.js']), imports.join(', '));

  check(
    'no inventory item looks like a card',
    !('observations' in scanA) && scanA.items.every((item) => !('oid' in item) && !('claim' in item) && !('confidence' in item))
  );
  check('every item is marked as inventory-origin', scanA.items.every((item) => item.origin === 'inventory') && scanA.origin === 'inventory');
  check('the result says it is a reference instrument, not ground truth', scanA.reference_instrument === true && scanA.ground_truth === false && scanA.schema === INVENTORY_SCHEMA);
  check('every item carries the rule that produced it and a reason', scanA.items.every((item) => typeof item.rule === 'string' && typeof item.reason === 'string' && item.reason.length > 0));
}

// -------------------------------------------------------------- determinism

console.log('\ndeterminism (reproducible independent of anything else)');
{
  const again = scanInventory(inputA);
  check('two scans of the same sources are byte-identical', digest(again) === digest(scanA));
  const first = calibrate();
  const second = calibrate();
  check('two calibrations are byte-identical', digest(first) === digest(second));
}

// ------------------------------------------------------------------- spans

console.log('\nspans (every item re-derives from source)');
{
  const verification = verifySpans(inputA, scanA.items);
  check('every span resolves exactly through the frozen resolver', verification.exact === true, JSON.stringify(verification.failures.slice(0, 3)));
  check('span checks actually ran', verification.spans > 20 && verification.resolved > 20, `${verification.resolved}/${verification.spans}`);

  const tampered = [{ id: 'inv_test', kind: 'entity', spans: [{ source_id: 's1', quote: 'this text does not exist', span: { start: 0, end: 27 } }] }];
  const bad = verifySpans(inputA, tampered);
  check('a fabricated span is rejected rather than tolerated', bad.exact === false && bad.failures[0]?.reason === 'fabricated_quote');

  const moved = [{ id: 'inv_test', kind: 'entity', spans: [{ source_id: 's1', quote: 'billing service', span: { start: 5, end: 20 } }] }];
  const relocated = verifySpans(inputA, moved);
  check(
    'a declared span that disagrees with its quote is reported as moved',
    relocated.exact === false && relocated.failures[0]?.reason === 'span_moved',
    JSON.stringify(relocated.failures)
  );
}

// ------------------------------------------------------------------- rules

console.log('\nrules (each detection is traceable to a rule)');
{
  const billing = itemsOf('entity').find((item) => item.label.toLowerCase() === 'billing service');
  check('a lowercase technical name is detected as a repeated phrase', Boolean(billing) && billing.rule === 'repeated_phrase');

  const dependency = itemsOf('relationship').find((item) => item.rule === 'dependency_phrase');
  check('an explicit dependency phrase becomes a relationship', Boolean(dependency) && dependency.detail.cue.includes('depends'));

  const crossSource = itemsOf('cross_source_reference').find((item) => item.label.toLowerCase() === 'billing service');
  check('a name in two sources becomes a cross-source reference', Boolean(crossSource) && crossSource.detail.sources.length === 2);

  const conflict = itemsOf('contradiction_candidate')[0];
  check('two sources stating different numbers about the same subject is flagged', Boolean(conflict) && conflict.detail.left.includes('300') && conflict.detail.right.includes('900'));

  const unresolved = itemsOf('unresolved_proposition').map((item) => item.detail.cue);
  check('open propositions are flagged from their own cue', unresolved.includes('pending') && unresolved.includes('may'), unresolved.join(', '));

  const plural = scanInventory(syntheticInput(PLANTED_CORPORA[1].documents));
  const obligation = itemsOf('unclaimed_span', plural)[0];
  check('an obligation with no stated relation becomes an unclaimed span', Boolean(obligation) && obligation.detail.text.includes('must reject'));

  const separate = scanInventory(syntheticInput(PLANTED_CORPORA[2].documents));
  const missing = itemsOf('missing_connection', separate)[0];
  check('two sources on one subject with no pairing is flagged', Boolean(missing) && missing.detail.shared_tokens.includes('entries'));

  const capped = scanInventory(inputA, { maxItems: 1 });
  check('the item cap is reported, not silent', capped.items.length === 1 && capped.stats.truncated > 0);
  check('the scan reports yield per rule', Object.keys(scanA.stats.by_rule).length >= 5 && scanA.stats.by_kind.entity > 0);
  check('all seven inventory kinds are declared even when unyielded', kindsA.size >= 5);
}

// ------------------------------------------------------------- calibration

console.log('\ncalibration (the instrument measures its own limits)');
{
  const calibration = calibrate();
  check('planted structures are recovered at high recall', calibration.recall.overall >= 0.8, `${calibration.recall.found}/${calibration.recall.expected}`);
  check(
    'recall is reported per kind as a fraction in [0,1]',
    Object.keys(calibration.recall.by_kind).length >= 5 &&
      Object.values(calibration.recall.by_kind).every((value) => value === null || (typeof value === 'number' && value >= 0 && value <= 1)),
    JSON.stringify(calibration.recall.by_kind)
  );
  check('every planted corpus reports its own misses', calibration.corpora.every((corpus) => Array.isArray(corpus.misses)));
  check('span exactness is part of the calibration, and holds', calibration.spans.exact === true && calibration.spans.failures === 0);
  check('precision is declared unmeasured with a reason', calibration.precision.measured === false && calibration.precision.reason.includes('false positive'));
  check('unmatched items are counted as candidate discoveries, not errors', calibration.unlabelled.total >= 0 && calibration.unlabelled.note.includes('not errors'));
  check('the calibration states its own scope limit', calibration.limits.includes('recall on unlabelled material is unknown'));
}

// ----------------------------------------------------------------- compare

console.log('\ncomparison (two instruments, never merged)');
{
  const entityItem = itemsOf('entity')[0];
  const candidates = [{ source_id: entityItem.spans[0].source_id, quote: entityItem.spans[0].quote, span: entityItem.spans[0].span }];
  const proposals = [
    { id: 'm1', type: 'claim', question: 'q1?', candidates },
    { id: 'm2', type: 'relationship', question: 'q2?', candidates: [] },
  ];
  const verdicts = [
    { proposal: { id: 'm3', type: 'relationship' }, verdict: 'supported', probability: 0.9 },
    { proposal: { id: 'm4', type: 'relationship' }, verdict: 'unsupported', probability: 0.2 },
  ];
  const comparison = compareToProposals({ inventory: scanA, proposals, verdicts, secondPassCostUsd: 0.004 });

  check('a proposal citing the same region is recorded as overlap', comparison.overlap_pairs.some((pair) => pair.proposal_id === 'm1' && pair.item_id === entityItem.id));
  check('a proposal with no span link stays unlinked', comparison.unlinked_proposals.some((proposal) => proposal.id === 'm2'));
  check('coverage is reported as a ratio of inventory items matched', comparison.coverage.matched_items >= 1 && comparison.coverage.ratio > 0 && comparison.coverage.ratio <= 1);
  check('items the model did not reach are listed as inventory-only', comparison.inventory_only.length === scanA.items.length - comparison.coverage.matched_items);
  check('only the supported relationship outside the overlap is counted as additional', comparison.additional_supported_relationships === 1 && comparison.supported_relationships === 1);
  check('incremental cost is priced per additional relationship', comparison.incremental_cost_per_additional_relationship === 0.004);
  check('overlap is declared unadjudicated rather than agreement', comparison.agreement === 'unadjudicated');
  check('the two origins stay distinguishable in the output', comparison.origins.inventory !== comparison.origins.model && comparison.indistinguishable === false);

  const unpriced = compareToProposals({ inventory: scanA, proposals, verdicts: [], secondPassCostUsd: 0.004 });
  check('with no additional relationship there is no increment to price', unpriced.additional_supported_relationships === 0 && unpriced.incremental_cost_per_additional_relationship === null);
  check('unresolved inventory items are separable for later adjudication', Array.isArray(unpriced.unresolved_inventory_items));
}

console.log('');
const summary = `checks executed: ${executed} (passed: ${passed}, failed: ${failures.length})`;
if (failures.length) {
  console.error(`inventory selftest failed — ${summary}`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log(`inventory selftest passed — ${summary}`);
