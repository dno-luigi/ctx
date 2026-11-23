#!/usr/bin/env node
/**
 * The spend floor for a design is written twice: as prose in its spend table, and as the number
 * tools/bench-run.js enforces from `<DESIGN>.budget.json`. This fails when they disagree, so a
 * budget cannot be raised in prose without the gate, or in the gate file without the document.
 *
 * Every `context-engine/*.budget.json` is checked, not just BENCHMARK-01: a second design added
 * beside it would otherwise reintroduce exactly the drift this check exists to prevent.
 *
 * Exit 0 = every design agrees. Exit 1 = one disagrees, or a field is missing.
 */

import { readdirSync, readFileSync } from 'node:fs';

const DIR = 'context-engine';
const BUDGET_FILES = readdirSync(DIR)
  .filter((name) => name.endsWith('.budget.json'))
  .sort();

const problems = [];
let checked = 0;

if (!BUDGET_FILES.includes('BENCHMARK-01.budget.json')) problems.push(`${DIR}/BENCHMARK-01.budget.json is missing`);

for (const file of BUDGET_FILES) {
  const budgetPath = `${DIR}/${file}`;
  const design = file.replace(/\.budget\.json$/, '');
  let record;
  try {
    record = JSON.parse(readFileSync(budgetPath, 'utf8'));
  } catch (error) {
    problems.push(`${budgetPath}: ${error.message}`);
    continue;
  }
  if (record.schema !== 'context-engine/benchmark-budget/v1') problems.push(`${budgetPath}: unexpected schema ${JSON.stringify(record.schema)}`);
  if (record.design !== design) problems.push(`${budgetPath}: design is ${JSON.stringify(record.design)}, not ${JSON.stringify(design)}`);
  if (typeof record.design_doc !== 'string') {
    problems.push(`${budgetPath}: design_doc is missing`);
    continue;
  }

  let doc;
  try {
    doc = readFileSync(`${DIR}/${record.design_doc}`, 'utf8');
  } catch {
    problems.push(`${budgetPath}: design_doc ${record.design_doc} does not exist`);
    continue;
  }

  // The spend table's total row: | **Total** | ~215 | **≈ $0.10** |
  const total = doc.match(/^\|\s*\*\*Total\*\*\s*\|\s*~?(\d+)\s*\|\s*\*\*≈\s*\$([\d.]+)\*\*\s*\|$/m);
  if (!total) {
    problems.push(`${DIR}/${record.design_doc} has no "| **Total** | N | **≈ $X** |" row to compare against`);
    continue;
  }

  const [, docCalls, docUsd] = total;
  if (Math.round(Number(record.worst_case_usd) * 100) !== Math.round(Number(docUsd) * 100)) {
    problems.push(`floor $${Number(record.worst_case_usd).toFixed(2)} in ${budgetPath} but ${record.design_doc} totals $${docUsd}`);
  }
  if (record.call_estimate !== Number(docCalls)) {
    problems.push(`${record.call_estimate} calls in ${budgetPath} but ${record.design_doc} totals ${docCalls}`);
  }
  checked += 1;
}

if (problems.length) {
  for (const problem of problems) console.log(`  MISMATCH ${problem}`);
  console.log(`0/${Math.max(checked, 1)} checks passed`);
  process.exit(1);
}
console.log(`${checked}/${checked} designs agree with their spend tables: ${BUDGET_FILES.map((name) => name.replace(/\.budget\.json$/, '')).join(', ')}`);
console.log(`${checked}/${checked} checks passed`);
