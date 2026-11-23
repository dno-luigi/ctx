/**
 * Coverage over the existing baseline snapshot. Read-only: no scan, no model call, $0.
 *
 * The item set is derived mechanically from the source tree — every numeric assignment it contains —
 * because no bank exists yet (bank authoring is a separate authorisation). These are not
 * experimental items and these counts are not benchmark results; they are a measurement of what the
 * four state forms make answerable.
 *
 * Conditions:
 *   A   source tree
 *   B1  snapshot item text only (evidence quotes stripped)
 *   B2  snapshot item text plus evidence quotes
 *   C   pack-medium item text
 *   B1p B1 with numeric literals redacted — a PROPOSED condition, reported separately, never
 *       substituted for B1
 *
 * Items are `asserts` claims: the question is whether the state records the pair, not whether the
 * value is current. Currency needs supersession edges, which the source does not carry for most
 * keys.
 *
 * Usage: node context-engine/poc/coverage-baseline.js
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { classify, coverageGuard, COVERAGE, SUPPORT } from '../src/classifier.js';

const failures = [];

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const sourceRoot = path.join(root, 'fixtures/poc-repo');
const snapshot = JSON.parse(readFileSync(path.join(root, 'examples/live-approved/snapshot-poc-repo.json'), 'utf8'));
const pack = JSON.parse(readFileSync(path.join(root, 'examples/live-approved/pack-medium.json'), 'utf8'));

const walk = (dir) =>
  readdirSync(dir).flatMap((name) => {
    const entry = path.join(dir, name);
    return statSync(entry).isDirectory() ? walk(entry) : [entry];
  });

const files = walk(sourceRoot).sort();
const sourceText = files.map((file) => readFileSync(file, 'utf8')).join('\n');

const ASSIGNMENTS = [
  /"([A-Za-z_][A-Za-z0-9_]*)"\s*:\s*(\d+(?:\.\d+)?)/g,
  /(?:const|let|var)\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(\d+(?:\.\d+)?)/g,
  /^[ \t]*([A-Za-z_][A-Za-z0-9_]*)[ \t]*=[ \t]*(\d+(?:\.\d+)?)/gm,
];

const items = [];
const seen = new Set();
for (const file of files) {
  const text = readFileSync(file, 'utf8');
  for (const pattern of ASSIGNMENTS) {
    pattern.lastIndex = 0;
    let match = pattern.exec(text);
    while (match) {
      const key = match[1];
      const value = Number(match[2]);
      const id = `${key}=${value}`;
      if (!seen.has(id)) {
        seen.add(id);
        items.push({ id, key, value, predicate: 'asserts', file: path.relative(sourceRoot, file) });
      }
      match = pattern.exec(text);
    }
  }
}

const snapshotItems = Object.entries(snapshot.sections ?? {}).flatMap(([section, list]) =>
  Array.isArray(list) ? list.map((entry) => ({ section, ...entry })) : []);
const packItems = Object.entries(pack.sections ?? {}).flatMap(([section, list]) =>
  Array.isArray(list) ? list.map((entry) => ({ section, ...entry })) : []);

const states = {
  A: sourceText.split('\n'),
  B1: snapshotItems.map((entry) => String(entry.text ?? '')),
  B2: snapshotItems.flatMap((entry) => [String(entry.text ?? ''), ...(entry.evidence ?? []).map((ref) => String(ref.quote ?? ''))]),
  C: packItems.map((entry) => String(entry.text ?? '')),
};
states.B1p = states.B1.map((line) => line.replace(/\b\d+(?:\.\d+)?\b/g, '[redacted]'));

const CONDITIONS = ['A', 'B1', 'B2', 'C', 'B1p'];
const PROPOSED = new Set(['B1p']);

console.log(`baseline coverage probe · snapshot ${snapshot.snapshot_id ?? '(no id)'} · pack ${pack.pack_id ?? '(no id)'}`);
console.log(`source files=${files.length} · derived items=${items.length} · snapshot items=${snapshotItems.length} · pack items=${packItems.length}`);
console.log(`derived item set (mechanical, not the bank): ${items.map((item) => item.id).join(', ')}\n`);

const pad = (value, width) => String(value).padEnd(width);
const pct = (part, whole) => (whole ? `${((part / whole) * 100).toFixed(0)}%` : '—');

console.log(`${pad('item', 26)}${CONDITIONS.map((condition) => pad(condition, 30)).join('')}`);
console.log('-'.repeat(26 + 30 * CONDITIONS.length));
for (const item of items) {
  const cells = CONDITIONS.map((condition) => {
    const result = classify({ state: states[condition], item });
    return pad(`${result.coverage.split('_')[0]}/${result.reason}`, 30);
  });
  console.log(`${pad(item.id, 26)}${cells.join('')}`);
}

console.log('\ncoverage split per condition (denominator = derived item count)');
for (const condition of CONDITIONS) {
  const results = items.map((item) => classify({ state: states[condition], item }));
  const count = (predicate) => results.filter(predicate).length;
  const asserted = count((result) => result.support === SUPPORT.ASSERTS);
  const defeated = count((result) => result.support === SUPPORT.CONTRADICTS);
  const unresolved = count((result) => result.support === SUPPORT.SILENT);
  const absent = count((result) => result.support === SUPPORT.ABSENT);
  const n = results.length;
  const label = PROPOSED.has(condition) ? `${condition} (proposed)` : condition;
  console.log(
    `  ${pad(label, 15)} n=${n} · asserted=${asserted} (${pct(asserted, n)}) · defeated=${defeated} (${pct(defeated, n)}) · ` +
      `unresolved=${unresolved} (${pct(unresolved, n)}) · absent=${absent} (${pct(absent, n)}) · ` +
      `coverage=${pct(asserted + defeated, n)}`,
  );
  const reasons = new Map();
  for (const result of results) reasons.set(result.reason, (reasons.get(result.reason) ?? 0) + 1);
  console.log(`  ${''.padEnd(15)} reasons: ${[...reasons].map(([reason, total]) => `${reason}=${total}`).join(', ')}`);
  const guard = coverageGuard({ asserted, defeated, unresolved, absent });
  console.log(`  ${''.padEnd(15)} guard: ${guard ?? 'ok'}${guard && PROPOSED.has(condition) ? ' (proposed condition — not eligible for the A/B1/B2/C comparison)' : ''}`);
}

// --- Qualification (E1-E4) for evidence_lost cells, computed without the classifier -------------
// Duplicated on purpose: the check must not reuse the code it is checking.
const escapeToken = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const containsToken = (haystack, needle) => {
  const token = String(needle ?? '');
  if (!token) return false;
  return new RegExp(`(?<![A-Za-z0-9_])${escapeToken(token)}(?![A-Za-z0-9_])`, 'i').test(String(haystack ?? ''));
};
const independentQuantities = (text) => {
  const found = [];
  const pattern = /(?<![\w-])(\d+(?:\.\d+)?)\s*([a-z]+)?/g;
  let match = pattern.exec(text);
  while (match) {
    found.push(Number(match[1]));
    match = pattern.exec(text);
  }
  return found;
};

console.log('\nqualification for evidence_lost cells (E1 key present · E2 value absent · E3 source asserts it · E4 nothing restores it)');
const b1pText = states.B1p.join('\n');
const sourceLines = states.A;
let qualified = 0;
let evidenceLost = 0;
for (const item of items) {
  const result = classify({ state: states.B1p, item });
  if (result.reason !== 'evidence_lost') continue;
  evidenceLost += 1;
  const e1 = containsToken(b1pText, item.key);
  const e2 = !containsToken(b1pText, item.value);
  const e3 = sourceLines.some((line) => containsToken(line, item.key) && containsToken(line, item.value));
  const e4 = !independentQuantities(b1pText).some((value) => Math.abs(value - item.value) < 1e-9);
  const ok = e1 && e2 && e3 && e4;
  if (ok) qualified += 1;
  else failures.push(`${item.id}: evidence_lost but E1-E4 not satisfied`);
  console.log(`  ${pad(item.id, 22)} E1=${e1} E2=${e2} E3=${e3} E4=${e4} · ${ok ? 'qualified' : 'NOT QUALIFIED'}`);
}
console.log(`  qualified ${qualified}/${evidenceLost} evidence_lost cells`);

console.log(`\nnote: derived items are \`asserts\` claims over numeric assignments in the source.`);
console.log(`note: B1p is a proposed condition and is not part of A/B1/B2/C.`);
console.log(`note: coverage is computed from the representation; support does not establish truth.`);
if (failures.length) {
  console.log(`\nRESULT: FAIL (${failures.length})`);
  for (const failure of failures) console.log(`  FAIL ${failure}`);
  process.exit(1);
}
console.log(`\nRESULT: PASS`);
