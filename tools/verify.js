#!/usr/bin/env node
/**
 * One entry point for every offline check, with a report instead of a bare exit code.
 *
 * A green run here means the checks agree with the reference data they were written against.
 * It does not show the engine works as intended: that is what BENCHMARK-01.md measures, and it
 * is not run here because it costs money. Keep that sentence in the summary; a passing suite is
 * the thing that is easiest to mistake for evidence.
 *
 * Counts are compared against baseline/verify-counts.json, which records the last run someone
 * chose to accept as green. The baseline is never updated automatically: rewriting it from a
 * workflow would let a regression become the new reference by passing once.
 *
 *   node tools/verify.js                     report, compare to baseline
 *   node tools/verify.js --update-baseline   record this run's counts (only if every check passed)
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';

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
  ['pilot freeze', ['tools/freeze-verify.js']],
  ['benchmark budget', ['tools/bench-budget-check.js']],
  ['benchmark gates', ['tools/bench-selftest.js']],
  ['poc truncation gate', ['tools/poc-truncation-check.js']],
];

const BASELINE = 'baseline/verify-counts.json';
const INTERESTING = /passed|PASS|RESULT|checks|intact|verified|%/i;
const updateBaseline = process.argv.includes('--update-baseline');

/**
 * The number a check reports about itself. Anchored to the wording these tools actually use, because
 * taking the first ratio in the output picked up unrelated figures (`94/96` where the check reports
 * `39/39`) and would have made the baseline meaningless.
 */
function measure(output) {
  const passed = output.match(/(\d+)\s*\/\s*(\d+)\s+(?:checks passed|baseline artifacts|artifacts match)/);
  if (passed) return { n: Number(passed[1]), of: Number(passed[2]) };
  const executed = output.match(/checks executed:\s*(\d+)\s*\(passed:\s*(\d+)/);
  if (executed) return { n: Number(executed[2]), of: Number(executed[1]) };
  // Only AC-6 reports a headline percentage. coverage-baseline prints five condition figures
  // (100/83/83/67/0); recording the first as "the" number would read as progress that isn't there.
  const percent = output.match(/distinct quotes \(([\d.]+)%\)/);
  if (percent) return { n: Number(percent[1]), of: null };
  return null;
}

function localCommit() {
  if (process.env.GITHUB_SHA) return process.env.GITHUB_SHA;
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}

function readBaseline() {
  if (!existsSync(BASELINE)) return null;
  try {
    return JSON.parse(readFileSync(BASELINE, 'utf8'));
  } catch {
    return null;
  }
}

const rows = [];
const failures = [];
for (const [name, args] of CHECKS) {
  const started = Date.now();
  const run = spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 180000 });
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  const output = `${run.stdout ?? ''}${run.stderr ?? ''}`.trim();
  const lines = output.split('\n').map((line) => line.trim()).filter(Boolean);
  const detail = (lines.filter((line) => INTERESTING.test(line)).pop() ?? lines.pop() ?? '').slice(0, 110);
  const ok = run.status === 0;
  rows.push({
    name,
    ok,
    detail: ok ? detail : (detail || run.error?.message || 'failed'),
    seconds,
    count: measure(output),
  });
  if (!ok) failures.push({ name, output });
}

const base = readBaseline();

function delta(row) {
  if (!row.count) return '—';
  const prior = base?.counts?.[row.name];
  if (!prior) return base ? 'new' : '—';
  const change = row.count.n - prior.n;
  return change === 0 ? '0' : `${change > 0 ? '+' : ''}${change}`;
}

const stamp = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
const failed = rows.filter((row) => !row.ok);

const markdown = [
  `## Offline checks — ${failed.length ? `${failed.length} failed` : 'all passed'}`,
  '',
  '| Check | Result | Detail | Δ | s |',
  '| --- | --- | --- | --- | --- |',
  ...rows.map((row) => `| ${row.name} | ${row.ok ? 'pass' : '**FAIL**'} | ${row.detail.replace(/\|/g, '\\|')} | ${delta(row)} | ${row.seconds} |`),
  '',
  base
    ? `Δ is against the accepted baseline from \`${(base.commit ?? 'unknown').slice(0, 7)}\` (${base.recorded_at ?? 'undated'}), not against the previous run.`
    : 'No baseline recorded, so Δ is suppressed. Record one with `npm run verify -- --update-baseline`.',
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
  for (const failure of failures) {
    console.error(`\n--- ${failure.name} failed; last output ---`);
    console.error(failure.output.split('\n').slice(-15).join('\n'));
  }
  console.error(`verify failed: ${failed.map((row) => row.name).join(', ')}`);
  process.exit(1);
}

if (updateBaseline) {
  const counts = Object.fromEntries(rows.filter((row) => row.count).map((row) => [row.name, row.count]));
  const record = {
    schema: 'gca-verify-counts/v1',
    commit: localCommit(),
    recorded_at: stamp,
    counts,
  };
  writeFileSync(BASELINE, `${JSON.stringify(record, null, 2)}\n`);
  console.log(`baseline recorded: ${Object.keys(counts).length} counts -> ${BASELINE}`);
}
