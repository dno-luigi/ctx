#!/usr/bin/env node
/**
 * BENCHMARK-01 runner. Dry by default, and unable to spend money today.
 *
 * The budget floor is read from `context-engine/<DESIGN>.budget.json`, the file that sits next to
 * the design's pre-registration, so the gate and the document are the same number. A design without
 * such a file has no floor and cannot be authorised at all.
 *
 * Live execution is not implemented: the pre-registered design has no runner yet, so the fully
 * authorised path stops at exit 2 instead of reaching a provider. Keep that true until a runner is
 * written and reviewed.
 *
 *   node tools/bench-run.js --dry [--design BENCHMARK-01]
 *   node tools/bench-run.js --live --budget-usd 0.10     (needs BENCH_CONFIRM and a key)
 */

import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const args = new Map();
for (let index = 2; index < process.argv.length; index += 1) {
  const token = process.argv[index];
  if (!token.startsWith('--')) continue;
  const [key, inline] = token.slice(2).split('=');
  if (inline !== undefined) args.set(key, inline);
  else if (process.argv[index + 1] && !process.argv[index + 1].startsWith('--')) args.set(key, process.argv[++index]);
  else args.set(key, true);
}

const live = args.has('live') && !args.has('dry');
const designId = String(args.get('design') ?? 'BENCHMARK-01');
const budget = Number(args.get('budget-usd') ?? 0);
const confirm = process.env.BENCH_CONFIRM ?? '';

/** The design's own floor, or the reason it has none. */
function readFloor(id) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) return { problem: `design id ${JSON.stringify(id)} does not name a budget file` };
  const path = `context-engine/${id}.budget.json`;
  let record;
  try {
    record = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return { path, problem: `no budget floor at ${path} — ${id} cannot be authorised` };
  }
  if (record.design !== id) return { path, problem: `${path} describes ${JSON.stringify(record.design)}, not ${JSON.stringify(id)}` };
  const floor = Number(record.worst_case_usd);
  if (!Number.isFinite(floor) || floor <= 0) return { path, problem: `${path} has no positive worst_case_usd` };
  return { path, record, floor };
}

const floorInfo = readFloor(designId);
const floor = floorInfo.floor ?? null;

// Priced by a different estimator over a different plan. Shown so the two figures stay visibly
// separate, never used as this design's floor.
const estimate = spawnSync(process.execPath, ['tools/estimate-bench.js', '--json'], { encoding: 'utf8' });
let plan = null;
try {
  plan = estimate.status === 0 ? JSON.parse(estimate.stdout) : null;
} catch {
  plan = null;
}

const reported = plan?.maximum_exposure?.total_usd;
const nominal = plan?.nominal?.total_usd;

const problems = [];
if (floorInfo.problem) problems.push(floorInfo.problem);
if (live) {
  if (confirm !== 'authorize-spend') problems.push(`confirm input is ${JSON.stringify(confirm)}, not "authorize-spend"`);
  if (!Number.isFinite(budget) || budget <= 0) problems.push('--budget-usd must be a positive number');
  else if (floor !== null && budget < floor) problems.push(`budget $${budget.toFixed(2)} is below the ${designId} floor $${floor.toFixed(2)}`);
  if (!process.env.OPENROUTER_API_KEY) problems.push('OPENROUTER_API_KEY is not present in this environment');
}

const lines = [
  `## Benchmark ${designId} — ${live ? 'paid run requested' : 'dry run'}`,
  '',
  '| | |',
  '| --- | --- |',
  `| Floor (worst case) | ${floor === null ? '**none recorded**' : `$${floor.toFixed(2)}`} |`,
  `| Source | ${floorInfo.path ?? '—'}${floorInfo.record ? ` — ${floorInfo.record.basis}` : ''} |`,
  `| Budget offered | ${budget > 0 ? `$${budget.toFixed(2)}` : 'none'} |`,
  `| Estimator (reference only) | ${plan?.series ?? 'unavailable'}${nominal == null ? '' : `: $${Number(nominal).toFixed(4)} nominal / $${Number(reported).toFixed(4)} worst`} — prices another plan, never the floor |`,
  '',
];

if (problems.length) {
  lines.push('**Refused.** No provider was contacted.', '', ...problems.map((problem) => `- ${problem}`), '');
} else if (!live) {
  lines.push(
    '**Nothing was sent.** No provider was contacted. The floor comes from the design\'s own',
    'pre-registration file, not from the estimator.',
    '',
    'A paid run needs `dry_run` unticked, the phrase `authorize-spend` typed into `confirm`, a budget at',
    'or above the floor, and an approval on the `benchmark` environment.',
    '',
  );
}

console.log(lines.join('\n'));
if (process.env.GITHUB_STEP_SUMMARY) writeFileSync(process.env.GITHUB_STEP_SUMMARY, lines.join('\n'), { flag: 'a' });

if (problems.length) process.exit(1);
if (!live) process.exit(0);

console.error('');
console.error('Every authorization check passed. Live execution is not implemented: BENCHMARK-01.md is');
console.error('pre-registered but has no runner, and this file refuses to reach a provider until one exists.');
console.error('No request was made and no money was spent.');
process.exit(2);
