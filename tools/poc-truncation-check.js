#!/usr/bin/env node
/**
 * Proves the truncation gate in context-engine/poc/run-poc.js fails when it should.
 *
 * Run 1 of SMOKE-01 hit its output cap, produced zero findings, and scored 25/25 anyway. The check
 * added after that is only worth having if it goes red on the exact condition it describes, so this
 * drives the runner twice with a scripted provider — once reporting `output_truncated`, once healthy
 * — and asserts the check fails in the first case and passes in the second.
 *
 * No key, no budget, no network, no spend.
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';

const OUT = 'context-engine/runs/poc-truncation';
const GATE = /no scan call was truncated, unparseable or failed/;

const failures = [];
let passed = 0;

function check(name, condition, detail = '') {
  if (condition) {
    passed += 1;
    console.log(`  PASS  ${name}`);
    return;
  }
  failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
  console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
}

mkdirSync(OUT, { recursive: true });

function runWith(script, label) {
  const scriptPath = `${OUT}/${label}-script.json`;
  const outDir = `${OUT}/${label}`;
  mkdirSync(`${OUT}/${label}`, { recursive: true });
  writeFileSync(scriptPath, `${JSON.stringify(script, null, 2)}\n`);
  const result = spawnSync(
    process.execPath,
    ['context-engine/poc/run-poc.js', '--provider', 'scripted', '--script', scriptPath, '--out', `runs/poc-truncation/${label}`],
    { encoding: 'utf8' },
  );
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  const gateLine = output.split('\n').find((line) => GATE.test(line))?.trim() ?? '';
  return { status: result.status, output, gateLine, outDir };
}

// 1. A cut-off response: the provider says output_truncated and returns nothing parseable.
const truncated = runWith(
  [{ payload: null, problems: [{ code: 'output_truncated', finish_reason: 'length', max_tokens: 8000 }] }],
  'truncated',
);
check('a call reporting output_truncated makes the runner exit non-zero', truncated.status === 1, `exit ${truncated.status}`);
check('the truncation gate is the check that fails', /^FAIL\b/.test(truncated.gateLine), JSON.stringify(truncated.gateLine));
check('the failure names the problem code', truncated.gateLine.includes('output_truncated'), JSON.stringify(truncated.gateLine));

// 2. Control: a well-formed payload without the problem must leave the gate green, or the check
// would be red unconditionally and prove nothing.
const healthy = runWith(
  [{ payload: { findings: [], relationships: [], contradictions: [], questions: [] }, problems: [] }],
  'healthy',
);
check('a healthy call leaves the truncation gate green', /^ok\b/.test(healthy.gateLine), JSON.stringify(healthy.gateLine));

console.log('');
if (failures.length) {
  for (const failure of failures) console.log(`  FAILED: ${failure}`);
  console.log(`0/${passed + failures.length} checks passed`);
  process.exit(1);
}
console.log(`${passed}/${passed} checks passed`);
