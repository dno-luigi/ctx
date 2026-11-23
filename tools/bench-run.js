#!/usr/bin/env node
/**
 * BENCHMARK-01 runner.
 *
 * Dry by default: it assembles the plan and prices it with the calibrated estimator, and sends
 * nothing. A paid run needs four independent things to be true, and three of them are not
 * settable from inside this file:
 *
 *   1. BENCH_CONFIRM must be exactly `authorize-spend` (the workflow passes your typed input);
 *   2. --budget-usd must be a real number, not below the estimator's worst-case exposure;
 *   3. OPENROUTER_API_KEY must be present, which only happens in the `benchmark` environment
 *      after a human approves the deployment;
 *   4. the workflow job itself only starts when you selected a live run.
 *
 * Live execution is NOT implemented. The pre-registered design in BENCHMARK-01.md still needs a
 * runner, so the authorised path stops at exit 2 rather than reaching a provider. That is
 * deliberate: no code path here can spend money today, and this file should keep saying so until
 * the runner is written and reviewed.
 *
 *   node tools/bench-run.js --dry [--design BENCHMARK-01]
 *   node tools/bench-run.js --live --budget-usd 5    (requires the confirmations above)
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';

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
const design = String(args.get('design') ?? 'BENCHMARK-01');
const budget = Number(args.get('budget-usd') ?? 0);
const confirm = process.env.BENCH_CONFIRM ?? '';

const estimate = spawnSync(process.execPath, ['tools/estimate-bench.js', '--json'], { encoding: 'utf8' });
if (estimate.status !== 0) {
  console.error('estimator failed; refusing to plan a run whose cost is unknown');
  console.error((estimate.stderr ?? '').split('\n').slice(-5).join('\n'));
  process.exit(1);
}

let plan;
try {
  plan = JSON.parse(estimate.stdout);
} catch {
  console.error('estimator did not return JSON; refusing to continue');
  process.exit(1);
}

const nominal = plan.nominal?.total_usd ?? null;
const worst = plan.maximum_exposure?.total_usd ?? null;
const cells = (plan.plan?.tasks ?? 0) * (plan.plan?.repeats ?? 0) * (plan.plan?.conditions?.length ?? 0) * (plan.plan?.models?.length ?? 0);

const lines = [
  `## Benchmark ${design} — ${live ? 'paid run requested' : 'dry run'}`,
  '',
  `| | |`,
  `| --- | --- |`,
  `| Design | ${design} (pre-registered, see \`context-engine/BENCHMARK-01.md\`) |`,
  `| Tasks × repeats × conditions × models | ${plan.plan?.tasks ?? '?'} × ${plan.plan?.repeats ?? '?'} × ${plan.plan?.conditions?.length ?? '?'} × ${plan.plan?.models?.length ?? '?'} = ${cells} cells |`,
  `| Estimator series | ${plan.series ?? 'unknown'} — the estimator prices its own plan, not this design |`,
  `| Nominal cost | ${nominal === null ? 'unknown' : `$${Number(nominal).toFixed(4)}`} |`,
  `| Worst-case exposure | ${worst === null ? 'unknown' : `$${Number(worst).toFixed(4)}`} |`,
  `| Budget offered | ${budget > 0 ? `$${budget.toFixed(2)}` : 'none'} |`,
  '',
];

if (!live) {
  lines.push(
    `**Nothing was sent.** The figures above price the estimator's series \`${plan.series}\`. BENCHMARK-01 has`,
    'its own pre-registered estimate in section 8 of the design doc, which this tool does not produce: the two',
    'numbers are not interchangeable. The estimator is calibrated against provider-reported usage, and no',
    'provider was contacted.',
    '',
    'A paid run needs `dry_run` unticked, the phrase `authorize-spend` typed into `confirm`, a budget at',
    'or above the worst-case exposure, and an approval on the `benchmark` environment.',
    '',
  );
  console.log(lines.join('\n'));
  mkdirSync('runs/bench', { recursive: true });
  writeFileSync('runs/bench/plan.json', `${JSON.stringify({ design, at: new Date().toISOString(), nominal, worst, cells }, null, 2)}\n`);
  if (process.env.GITHUB_STEP_SUMMARY) writeFileSync(process.env.GITHUB_STEP_SUMMARY, lines.join('\n'), { flag: 'a' });
  process.exit(0);
}

const problems = [];
if (confirm !== 'authorize-spend') problems.push(`confirm input is ${JSON.stringify(confirm)}, not "authorize-spend"`);
if (!Number.isFinite(budget) || budget <= 0) problems.push('--budget-usd must be a positive number');
else if (worst !== null && budget < worst) problems.push(`budget $${budget.toFixed(2)} is below the worst-case exposure $${Number(worst).toFixed(4)}`);
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
