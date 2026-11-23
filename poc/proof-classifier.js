/**
 * Classifier proof: matrix, frozen expectations, independent qualification, negative control.
 * No model calls, no scan, $0.
 *
 * The fixture's expected classifications are authored. This runner compares them with what the
 * classifier computes. That comparison is the evidence: qualification (E1-E4, computed here with
 * plain string and unit logic) and classification (src/classifier.js) are separate derivations, so
 * agreement is not circular.
 *
 * Usage: node context-engine/poc/proof-classifier.js
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { classify, coverageGuard, DEFAULT_UNITS, COVERAGE, SUPPORT } from '../src/classifier.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const fixture = JSON.parse(readFileSync(path.join(root, 'poc/classifier-proof.fixture.json'), 'utf8'));

const CONDITIONS = Object.keys(fixture.conditions);
const UNITS = fixture.units ?? DEFAULT_UNITS;
const failures = [];
const notes = [];

for (const item of fixture.items) {
  for (const condition of CONDITIONS) {
    if (!Array.isArray(item.expected?.[condition])) failures.push(`${item.id}: no frozen expectation for ${condition}`);
  }
}

const matrix = new Map();
for (const item of fixture.items) {
  const row = new Map();
  for (const condition of CONDITIONS) {
    const result = classify({ state: fixture.states[condition], item, units: UNITS });
    row.set(condition, result);
    const [coverage, reason, target] = item.expected?.[condition] ?? [];
    if (result.coverage !== coverage || result.reason !== reason || result.target !== target) {
      failures.push(`${item.id}/${condition}: expected ${coverage}/${reason}/${target} · got ${result.coverage}/${result.reason}/${result.target}`);
    }
  }
  matrix.set(item.id, row);
}

const pad = (value, width) => String(value).padEnd(width);
const cell = (result) => `${result.coverage}/${result.reason}/${result.target}`;
const width = Math.max(...[...matrix.values()].flatMap((row) => [...row.values()].map((result) => cell(result).length)), 12) + 2;

console.log(`classifier proof · ${fixture.items.length} items · ${CONDITIONS.length} conditions · ${fixture.schema}`);
console.log(`baseline untouched: examples/live-approved · bank frozen · estimator frozen\n`);
console.log(`${pad('item', 6)}${pad('branch', 26)}${CONDITIONS.map((condition) => pad(condition, width)).join('')}`);
console.log('-'.repeat(6 + 26 + width * CONDITIONS.length));
for (const item of fixture.items) {
  const row = matrix.get(item.id);
  console.log(`${pad(item.id, 6)}${pad(item.branch, 26)}${CONDITIONS.map((condition) => pad(cell(row.get(condition)), width)).join('')}`);
}

// --- Negative control: unit restoration, not literal matching -------------------------------
console.log('\nnegative control (semantic restoration)');
const literal = fixture.negative_control.absent_literal;
for (const condition of CONDITIONS) {
  const text = fixture.states[condition].join('\n');
  const present = text.includes(literal);
  if (present) failures.push(`negative control: literal ${literal} is present in ${condition}`);
  console.log(`  ${pad(condition, 5)} contains "${literal}": ${present}`);
}
for (const condition of fixture.negative_control.must_assert_in) {
  const result = matrix.get(fixture.negative_control.item)?.get(condition);
  const ok = result?.support === SUPPORT.ASSERTS && result?.evidence?.converted === true;
  if (!ok) failures.push(`negative control: ${fixture.negative_control.item}/${condition} did not assert through conversion`);
  console.log(`  ${pad(condition, 5)} ${fixture.negative_control.item} asserts via unit conversion: ${ok}`);
}
// Permanent assertion: the control must be able to fail. With unit restoration disabled, the same
// item must stop asserting. A control that cannot lose its power is not a control.
console.log('\nnegative control mutation (unit restoration disabled · must stop asserting)');
const control = fixture.items.find((item) => item.id === fixture.negative_control.item);
for (const condition of fixture.negative_control.must_assert_in) {
  const literal = classify({ state: fixture.states[condition], item: { ...control, unit: undefined }, units: UNITS });
  const semantic = matrix.get(control.id).get(condition);
  const discriminating = semantic.support === SUPPORT.ASSERTS && literal.support !== SUPPORT.ASSERTS;
  if (!discriminating) failures.push(`negative control lost power: ${control.id}/${condition} literal=${literal.support} semantic=${semantic.support}`);
  console.log(`  ${pad(condition, 5)} literal=${literal.coverage}/${literal.reason} · semantic=${semantic.coverage}/${semantic.reason} · discriminating=${discriminating}`);
}
notes.push('literal matching of P6 is asserted to fail in every control condition; this is a permanent check, not a one-off observation');

// --- Token-boundary probes (permanent) -------------------------------------------------------
// A revert of containsToken leaves the seven-item matrix unchanged, so these probes are the only
// thing standing between the contract and a silent regression to substring matching.
console.log('\ntoken-boundary probes');
const boundaryCases = [
  ['value 5 does not match 50', () => classify({ state: ['timeout_seconds = 50'], item: { key: 'timeout_seconds', value: 5 } }).support !== SUPPORT.ASSERTS],
  ['standalone value 5 still matches', () => classify({ state: ['timeout_seconds = 5'], item: { key: 'timeout_seconds', value: 5 } }).support === SUPPORT.ASSERTS],
  ['key retention_days does not match archive_retention_days', () => classify({ state: ['archive_retention_days = 45'], item: { key: 'retention_days', value: 14 } }).reason === 'key_absent'],
  ['exact key still resolves', () => classify({ state: ['retention_days = 14'], item: { key: 'retention_days', value: 14 } }).support === SUPPORT.ASSERTS],
  ['nominal value fixed does not match fixedness', () => classify({ state: ['policy = fixedness'], item: { key: 'policy', value: 'fixed' } }).reason === 'evidence_lost'],
  ['digits inside an identifier are not quantities', () => classify({ state: ['retention_days = 45; see ADR-001'], item: { key: 'retention_days', value: 1 } }).support !== SUPPORT.ASSERTS],
  ['supersession does not defeat an asserts claim', () => classify({ state: ['retention_days = 14 (legacy note). This note is superseded by ADR-001.'], item: { key: 'retention_days', value: 14, predicate: 'asserts' } }).support === SUPPORT.ASSERTS],
  ['a competing value refutes an asserts claim with its own reason code', () => classify({ state: ['retention_days = 30'], item: { key: 'retention_days', value: 7, predicate: 'asserts' } }).reason === 'refuted_by_competing_value'],
  ['a competitor does not refute a value that is itself asserted', () => { const result = classify({ state: ['timeout_seconds = 30', 'timeout_seconds = 5'], item: { key: 'timeout_seconds', value: 5, predicate: 'asserts' } }); return result.support === SUPPORT.ASSERTS && result.reason !== 'refuted_by_competing_value'; }],
  ['a unit-equivalent value still asserts beside a raw competitor', () => { const result = classify({ state: ['scheduler: every 30 seconds', 'scheduler: 45 ms'], item: { key: 'scheduler', value: 30000, unit: 'ms', predicate: 'asserts' } }); return result.support === SUPPORT.ASSERTS && result.reason !== 'refuted_by_competing_value'; }],
  ['identifier digits are not competitors', () => classify({ state: ['retention_days = unknown; see ADR-001'], item: { key: 'retention_days', value: 1, predicate: 'asserts' } }).reason === 'evidence_lost'],
];
for (const [label, check] of boundaryCases) {
  const ok = check();
  if (!ok) failures.push(`token-boundary probe failed: ${label}`);
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}`);
}

// --- Qualification (E1-E4), computed independently of the classifier -------------------------
// Deliberately duplicated conversion logic: the check must not share code with what it checks.
const independentQuantities = (text) => {
  const found = [];
  const re = /(?<![\w-])(\d+(?:\.\d+)?)\s*([a-z]+)?/g;
  let match = re.exec(text);
  while (match) {
    const raw = Number(match[1]);
    const unit = UNITS.find((entry) => entry.aliases.includes(String(match[2] ?? '').toLowerCase()));
    found.push({ raw, value: unit ? raw * unit.scale : raw, unit: unit ? unit.base : null });
    match = re.exec(text);
  }
  return found;
};

// Whole-token search, duplicated on purpose: the qualification check must not reuse the classifier.
const escapeToken = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const containsToken = (haystack, needle) => {
  const token = String(needle ?? '');
  if (!token) return false;
  return new RegExp(`(?<![A-Za-z0-9_])${escapeToken(token)}(?![A-Za-z0-9_])`, 'i').test(String(haystack ?? ''));
};

const qualifies = ({ item, condition }) => {
  const text = fixture.states[condition].join('\n');
  const keyPresent = containsToken(text, item.key);
  const valueAbsent = item.value_evidence ? !containsToken(text, item.value) : false;
  const evidenceInSource = typeof item.value_evidence === 'string'
    && fixture.states.A.join('\n').toLowerCase().includes(item.value_evidence.toLowerCase());
  const restorable = typeof item.value === 'number'
    ? independentQuantities(text).some((quantity) => Math.abs(quantity.value - item.value) < 1e-9)
    : containsToken(text, item.value);
  return { keyPresent, valueAbsent, evidenceInSource, restorable, qualifies: keyPresent && valueAbsent && evidenceInSource && !restorable };
};

console.log('\nqualification for evidence_lost cells (E1 key present · E2 value absent · E3 source establishes it · E4 nothing restores it)');
for (const item of fixture.items) {
  for (const condition of CONDITIONS) {
    const result = matrix.get(item.id).get(condition);
    if (result.reason !== 'evidence_lost') continue;
    const q = qualifies({ item, condition });
    if (!q.qualifies) failures.push(`${item.id}/${condition}: classified evidence_lost but E1-E4 do not qualify it`);
    console.log(`  ${pad(item.id + '/' + condition, 9)} E1=${q.keyPresent} E2=${q.valueAbsent} E3=${q.evidenceInSource} E4=${!q.restorable} · ${q.qualifies ? 'qualified' : 'NOT QUALIFIED'}`);
  }
}

// --- F2: coverage uses the instrument denominator, not a model's eligible count --------------
console.log('\ncoverage (F2: denominator = frozen item count, model-independent)');
for (const condition of CONDITIONS) {
  const results = fixture.items.map((item) => matrix.get(item.id).get(condition));
  const count = (coverage) => results.filter((result) => result.coverage === coverage).length;
  const asserted = results.filter((result) => result.support === SUPPORT.ASSERTS).length;
  const defeated = results.filter((result) => result.support === SUPPORT.CONTRADICTS).length;
  const unresolved = results.filter((result) => result.support === SUPPORT.SILENT).length;
  const absent = results.filter((result) => result.support === SUPPORT.ABSENT).length;
  const total = results.length;
  const sum = asserted + defeated + unresolved + absent;
  if (sum !== total) failures.push(`coverage ${condition}: buckets sum to ${sum}, expected ${total}`);
  const reasons = new Map();
  for (const result of results) reasons.set(result.reason, (reasons.get(result.reason) ?? 0) + 1);
  const guard = coverageGuard({ asserted, defeated, unresolved, absent });
  console.log(`  ${pad(condition, 5)} n=${total} · asserted=${asserted} defeated=${defeated} unresolved=${unresolved} absent=${absent} · answerable=${count(COVERAGE.ANSWERABLE)} insufficient=${count(COVERAGE.INSUFFICIENT)} not_in_state=${count(COVERAGE.NOT_IN_STATE)}`);
  console.log(`  ${''.padEnd(5)} unresolved reasons: ${[...reasons].filter(([reason]) => ['competition_unresolved', 'evidence_lost', 'predicate_undeterminable'].includes(reason)).map(([reason, total]) => `${reason}=${total}`).join(', ') || 'none'} · guard=${guard ?? 'ok'}`);
}

// B1p must produce evidence_lost, not a mixture. An aggregate "unresolved=5" would hide a classifier
// that answered the wrong way on the branch the condition exists to exercise.
const b1pUnresolved = fixture.items.map((item) => matrix.get(item.id).get('B1p')).filter((result) => result.support === SUPPORT.SILENT);
const b1pMixed = b1pUnresolved.filter((result) => result.reason !== 'evidence_lost');
if (b1pMixed.length) failures.push(`B1p unresolved cells include non-evidence_lost reasons: ${[...new Set(b1pMixed.map((result) => result.reason))].join(',')}`);
console.log(`\nB1p unresolved breakdown: ${b1pUnresolved.length} cells · ${[...new Set(b1pUnresolved.map((result) => result.reason))].join(', ') || 'none'} · all evidence_lost=${b1pMixed.length === 0}`);

// The guard itself must be able to fire. A rule that cannot trigger is not a guard.
console.log('\ndegeneracy guard self-test');
const guardCases = [
  [{ asserted: 0, defeated: 3, unresolved: 0, absent: 0 }, 'refutation_only'],
  [{ asserted: 0, defeated: 0, unresolved: 5, absent: 1 }, 'unresolved_only'],
  [{ asserted: 1, defeated: 0, unresolved: 5, absent: 1 }, null],
];
for (const [tally, expected] of guardCases) {
  const actual = coverageGuard(tally);
  if (actual !== expected) failures.push(`guard self-test: ${JSON.stringify(tally)} -> ${actual}, expected ${expected}`);
  console.log(`  ${actual === expected ? 'ok  ' : 'FAIL'} ${JSON.stringify(tally)} -> ${actual}`);
}

// --- F1: invariant subset and assertion drift ------------------------------------------------
console.log('\nF1 invariant subset (asserts in every condition)');
const invariant = fixture.items.filter((item) => CONDITIONS.every((condition) => matrix.get(item.id).get(condition).support === SUPPORT.ASSERTS));
console.log(`  items: ${invariant.map((item) => item.id).join(', ') || 'none'} (${invariant.length}/${fixture.items.length})`);
for (const condition of CONDITIONS) {
  const drift = fixture.items.filter((item) => matrix.get(item.id).get('A').support === SUPPORT.ASSERTS && matrix.get(item.id).get(condition).support !== SUPPORT.ASSERTS);
  console.log(`  drift vs A in ${pad(condition, 5)}: ${drift.length ? drift.map((item) => item.id).join(', ') : 'none'}`);
}

// --- Branch coverage -------------------------------------------------------------------------
console.log('\nbranch coverage');
const branches = new Map();
for (const item of fixture.items) {
  for (const condition of CONDITIONS) {
    const result = matrix.get(item.id).get(condition);
    const label = result.reason;
    if (!branches.has(label)) branches.set(label, []);
    branches.get(label).push(`${item.id}/${condition}`);
  }
}
for (const [label, cells] of branches) console.log(`  ${pad(label, 26)} ${cells.length} cells · ${cells.slice(0, 6).join(' ')}${cells.length > 6 ? ' …' : ''}`);
for (const required of ['establishes_claim', 'defeats_predicate', 'competition_unresolved', 'evidence_lost', 'key_absent']) {
  if (!branches.has(required)) failures.push(`branch ${required} does not appear in the matrix`);
}

console.log(`\nnotes`);
for (const note of notes) console.log(`  - ${note}`);
if (failures.length) {
  console.log(`\nRESULT: FAIL (${failures.length})`);
  for (const failure of failures) console.log(`  FAIL ${failure}`);
  process.exit(1);
}
console.log(`\nRESULT: PASS`);
