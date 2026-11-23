#!/usr/bin/env node
/**
 * Every offline check the engine ships with, with a report instead of a bare exit code.
 *
 * A green run means these checks agree with the reference data they were written against.
 * It does not show the engine works as intended: that is what BENCHMARK-01.md measures, and that
 * benchmark is designed and pre-registered but not run. A passing suite is the easiest thing to
 * mistake for evidence, so the summary says so on every run.
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';

// Enumerate the files rather than passing 'tests/': Node 20 accepts a directory there, Node 22
// resolves the trailing-slash path as a file and reports zero passing tests.
const TEST_FILES = readdirSync('tests')
  .filter((file) => file.endsWith('.test.js'))
  .sort()
  .map((file) => `tests/${file}`);

const CHECKS = [
  ['unit tests', ['--test', ...TEST_FILES]],
  ['classifier proof', ['poc/proof-classifier.js']],
  ['coverage baseline', ['poc/coverage-baseline.js']],
  ['offline POC (stub)', ['poc/run-poc.js', '--out', 'runs/poc']],
];

const INTERESTING = /passed|PASS|RESULT|checks|%/i;
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
const markdown = [
  `## Engine checks — ${failed.length ? `${failed.length} failed` : 'all passed'}`,
  '',
  '| Check | Result | Detail | s |',
  '| --- | --- | --- | --- |',
  ...rows.map((row) => `| ${row.name} | ${row.ok ? 'pass' : '**FAIL**'} | ${row.detail.replace(/\|/g, '\\|')} | ${row.seconds} |`),
  '',
  '**What this proves:** these checks agree with their own reference data on this commit.',
  '',
  '**What this does not prove:** that the engine works as intended. `BENCHMARK-01.md` measures that,',
  'and it has not been run. A green run is a regression signal, not a result.',
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
