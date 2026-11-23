#!/usr/bin/env node
/**
 * The spend floor for a design is written twice: as prose in its §8 table, and as the number
 * tools/bench-run.js enforces from `<DESIGN>.budget.json`. This fails when they disagree, so a
 * budget cannot be raised in prose without the gate, or in the gate file without the document.
 *
 * Exit 0 = they agree. Exit 1 = they disagree or a field is missing.
 */

import { readFileSync } from 'node:fs';

const BUDGET = 'context-engine/BENCHMARK-01.budget.json';
const DOC = 'context-engine/BENCHMARK-01.md';

const record = JSON.parse(readFileSync(BUDGET, 'utf8'));
// §8's total row: | **Total** | ~215 | **≈ $0.10** |
const total = readFileSync(DOC, 'utf8').match(/^\|\s*\*\*Total\*\*\s*\|\s*~?(\d+)\s*\|\s*\*\*≈\s*\$([\d.]+)\*\*\s*\|$/m);

const problems = [];
if (record.schema !== 'context-engine/benchmark-budget/v1') problems.push(`${BUDGET}: unexpected schema ${JSON.stringify(record.schema)}`);
if (record.design !== 'BENCHMARK-01') problems.push(`${BUDGET}: design is ${JSON.stringify(record.design)}`);
if (record.design_doc !== 'BENCHMARK-01.md') problems.push(`${BUDGET}: design_doc is ${JSON.stringify(record.design_doc)}`);

if (!total) {
  problems.push(`${DOC} §8 has no "| **Total** | N | **≈ $X** |" row to compare against`);
} else {
  const [, docCalls, docUsd] = total;
  if (Math.round(Number(record.worst_case_usd) * 100) !== Math.round(Number(docUsd) * 100)) {
    problems.push(`floor $${Number(record.worst_case_usd).toFixed(2)} in ${BUDGET} but §8 totals $${docUsd}`);
  }
  if (record.call_estimate !== Number(docCalls)) {
    problems.push(`${record.call_estimate} calls in ${BUDGET} but §8 totals ${docCalls}`);
  }
}

if (problems.length) {
  for (const problem of problems) console.log(`  MISMATCH ${problem}`);
  console.log(`0/1 checks passed`);
  process.exit(1);
}
console.log(`floor $${Number(record.worst_case_usd).toFixed(2)} over ${record.call_estimate} calls agrees with ${DOC} §8`);
console.log(`1/1 checks passed`);
