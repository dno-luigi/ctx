#!/usr/bin/env node
/**
 * BENCHMARK-01 runner.
 *
 * Dry by default: it assembles the plan and prices what it can, and sends nothing. A paid run needs
 * four independent things to be true, and three of them are not settable from inside this file:
 *
 *   1. BENCH_CONFIRM must be exactly `authorize-spend` (the workflow passes your typed input);
 *   2. --budget-usd must cover the *design's* worst-case figure, which comes from the design's own
 *      pre-registration, not from the estimator (see DESIGNS below);
 *   3. OPENROUTER_API_KEY must be present, which only happens in the `benchmark` environment after
 *      a human approves the deployment;
 *   4. the workflow job only starts when you selected a live run.
 *
 * Live execution is NOT implemented. The pre-registered design in BENCHMARK-01.md still needs a
 * runner, so the authorised path stops at exit 2 rather than reaching a provider. That is
 * deliberate: no code path here can spend money today, and this file should keep saying so until
 * the runner is written and reviewed.
 *
 *   node tools/bench-run.js --dry [--design BENCHMARK-01]
 *   node tools/bench-run.js --live --budget-usd 0.10    (requires the confirmations above)
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';

/**
 * Each design carries its own floor. `tools/estimate-bench.js` prices DECISIONS-BENCH-02 — a
 * different task set, model mix and repeat count — so its worst case must never be used as the
 * floor for another design. A design without an entry here cannot be authorised at all.
 */
const DESIGNS = {
  'BENCHMARK-01': {
    worst_case_usd: 0.1,
    basis: 'BENCHMARK-01.md section 8: ~215 calls, ≈$0.10, described there as rough and deliberately conservative',
  },
};

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
const design = DESIGNS[designId] ?? null;
const budget = Number(args.get('budget-usd') ?? 0);
const confirm = process.env.BENCH_CONFIRM ?? '';

const estimate = spawnSync(process.execPath, ['tools/estimate-bench.js', '--json'], { encoding: 'utf8' });
let plan = null;
if (estimate.status === 0) {
  try {
    plan = JSON.parse(estimate.stdout);
  } catch {
    plan = null;
  }
}

const floor = design ? design.worst_case_usd : null;
const estimated = plan?.maximum_exposure?.total_usd ?? null;
const nominal = plan?.nominal?.total_usd ?? null;

const lines = [
  `## Benchmark ${designId} — ${live ? 'paid run requested' : 'dry run'}`,
  '',
  '| | |',
  '| --- | --- |',
  `| Design floor (worst case) | ${floor === null ? '**none recorded — this design cannot be authorised**' : `$${floor.toFixed(2)}`} |`,
  `| Floor basis | ${design ? design.basis : 'unknown design'} |`,
  `| Budget offered | ${budget > 0 ? `$${budget.toFixed(2)}` : 'none'} |`,
  `| Estimator series (reference only) | ${plan?.series ?? 'unavailable'} — prices its own plan, not this design, and is not used for the floor |`,
  `| Estimator nominal / worst | ${nominal === null ? 'unavailable' : `$${Number(nominal).toFixed(4)} / $${Number(estimated).toFixed(4)}`} |`,
  '',
];

if (!live) {
  lines.push(
    '**Nothing was sent.** No provider was contacted. The floor above comes from the design\'s own',
    'pre-registration; the estimator figures are shown only to keep the two numbers visibly separate.',
    '',
    'A paid run needs `dry_run` unticked, the phrase `authorize-spend` typed into `confirm`, a budget at',
    'or above the design floor, and an approval on the `benchmark` environment.',
    '',
  );
  console.log(lines.join('\n'));
  mkdirSync('runs/bench', { recursive: true });
  writeFileSync('runs/bench/plan.json', `${JSON.stringify({ design: designId, floor, at: new Date().toISOString(), nominal, estimated }, null, 2)}\n`);
  if (process.env.GITHUB_STEP_SUMMARY) writeFileSync(process.env.GITHUB_STEP_SUMMARY, lines.join('\n'), { flag: 'a' });
  process.exit(0);
}

const problems = [];
if (!design) problems.push(`no floor is recorded for design ${JSON.stringify(designId)}`);
if (confirm !== 'authorize-spend') problems.push(`confirm input is ${JSON.stringify(confirm)}, not "authorize-spend"`);
if (!Number.isFinite(budget) || budget <= 0) problems.push('--budget-usd must be a positive number');
else if (floor !== null && budget < floor) problems.push(`budget $${budget.toFixed(2)} is below the ${designId} floor $${floor.toFixed(2)}`);
if (!process.env.OPENROUTER_API_KEY) problems.push('OPENROUTER_API_KEY is not present in this environment');

lines.push('**Refused.** No provider was contacted.', '', ...problems.map((problem) => `- ${problem}`), '');
console.log(lines.join('\n'));
if (process.env.GITHUB_STEP_SUMMARY) writeFileSync(process.env.GITHUB_STEP_SUMMARY, lines.join('\n'), { flag: 'a' });

if (problems.length) process.exit(1);

console.error('');
console.error('Every authorization check passed. Live execution is not implemented: BENCHMARK-01.md is');
console.error('pre-registered but has no runner, and this file refuses to reach a provider until one exists.');
console.error('No request was made and no money was spent.');
process.exit(2);
