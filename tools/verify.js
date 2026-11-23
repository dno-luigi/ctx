#!/usr/bin/env node
/**
 * One entry point for every offline check, with a report instead of a bare exit code.
 *
 * A green run here means the checks agree with the reference data they were written against.
 * It does not show the engine works as intended: that is what BENCHMARK-01.md measures, and it
 * is not run here because it costs money. Keep that sentence in the summary; a passing suite is
 * the thing that is easiest to mistake for evidence.
 *
 * Writes runs/verify-summary.md and, on GitHub Actions, the job summary.
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';

const CHECKS = [
  ['engine selftest', ['tools/selftest.js']],
  ['decision selftest', ['tools/decisions-selftest.js']],
  ['inventory selftest', ['tools/inventory-selftest.js']],
  ['adapter contract', ['tools/contract-test.js']],
  ['usage capture', ['tools/usage-capture.js', '--selftest']],
  ['blind packet', ['tools/blind-packet.js', '--selftest']],
  ['transcript scorer', ['tools/score-transcript.js', '--selftest']],
  ['classifier proof', ['context-engine/poc/proof-classifier.js']],
  ['coverage baseline', ['context-engine/poc/coverage-baseline.js']],
  ['ARA freeze', ['tools/ara-freeze.js', '--verify']],
  ['AC-6 under A1′', ['tools/ac6-refined.js']],
  ['schema acceptance', ['tools/schema-acceptance.js']],
  ['schema acceptance v2', ['tools/schema-acceptance-v2.js']],
  ['storage acceptance', ['tools/storage-acceptance.js']],
  ['D8 acceptance', ['tools/d8-acceptance.js']],
  ['D6 evaluation', ['tools/d6-eval.js']],
  ['D6 held-out', ['tools/d6-heldout.js']],
];

const INTERESTING = /passed|PASS|RESULT|checks|intact|verified|%/i;

const rows = [];
for (const [name, args] of CHECKS) {
  const started = Date.now();
  const run = spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 180000 });
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  const output = `${run.stdout ?? ''}${run.stderr ?? ''}`.trim();
  const lines = output.split('\n').map((line) => line.trim()).filter(Boolean);
  const detail = (lines.filter((line) => INTERESTING.test(line)).pop() ?? lines.pop() ?? '').slice(0, 110);
  rows.push({ name, ok: run.status === 0, detail, seconds });
}

const failed = rows.filter((row) => !row.ok);
const stamp = new Date().toISOString().replace(/\.\d+Z$/, 'Z');

const table = [
  '| Check | Result | Detail | s |',
  '| --- | --- | --- | --- |',
  ...rows.map((row) => `| ${row.name} | ${row.ok ? 'pass' : '**FAIL**'} | ${row.detail.replace(/\|/g, '\\|')} | ${row.seconds} |`),
].join('\n');

const markdown = [
  `## Offline checks — ${failed.length ? `${failed.length} failed` : 'all passed'}`,
  '',
  table,
  '',
  '**What this proves:** each check agrees with the reference data it was written against, on this commit.',
  '',
  '**What this does not prove:** that the engine works as intended. Effectiveness is measured by',
  '`context-engine/BENCHMARK-01.md`, which is designed and pre-registered but not run, because it spends',
  'money. A green run is a regression signal, not a result.',
  '',
  `_${rows.length} checks, ${stamp}_`,
  '',
].join('\n');

console.log(markdown);
mkdirSync('runs', { recursive: true });
writeFileSync('runs/verify-summary.md', markdown);
if (process.env.GITHUB_STEP_SUMMARY) writeFileSync(process.env.GITHUB_STEP_SUMMARY, markdown, { flag: 'a' });

if (failed.length) {
  console.error(`verify failed: ${failed.map((row) => row.name).join(', ')}`);
  process.exit(1);
}
