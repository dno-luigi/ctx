import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

/**
 * Checks the harness, not a model.
 *
 * The stub emits snapshots derived from the fixture ground truth, so a
 * deliberate fault must move the metrics in a known direction. If a fault does
 * not move them, the grader is broken and no paid run would mean anything.
 */

const ROOT = new URL('../', import.meta.url);
const runPath = fileURLToPath(new URL('./run.js', ROOT));
const buildPath = fileURLToPath(new URL('./tools/build-fixtures.js', ROOT));

const built = spawnSync(process.execPath, [buildPath], { stdio: 'inherit' });
if (built.status !== 0) {
  console.error('fixture build failed');
  process.exit(1);
}

function run(args) {
  const result = spawnSync(process.execPath, [runPath, ...args], { encoding: 'utf8' });
  const outDir = args[args.indexOf('--out') + 1];
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, outDir };
}

async function reportOf(outDir) {
  return JSON.parse(await readFile(new URL(`./${outDir}/report.json`, ROOT), 'utf8'));
}

const failures = [];

function check(name, condition, detail = '') {
  if (condition) {
    console.log(`  PASS  ${name}`);
    return;
  }
  failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
  console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
}

console.log('\nperfect stub (a clean run must pass every threshold)');
{
  const { status, outDir, stderr } = run(['--provider', 'stub', '--quality', 'perfect', '--all', '--repeats', '3', '--out', 'runs/selftest-perfect', '--strict']);
  const report = await reportOf(outDir);
  check('exit status 0', status === 0, `got ${status} ${stderr}`.trim());
  check('no rejected snapshots', report.totals.invalid === 0, `${report.totals.invalid} rejected`);
  check('every model passes', report.models.every((entry) => entry.grade.pass));
  check('required coverage is total', report.models.every((entry) => entry.grade.metrics.coverage === 1));
  check('consistency is total', report.models.every((entry) => entry.grade.metrics.consistency === 1));
  check('repeat differential is clean', report.repeat_drift_events === 0, `${report.repeat_drift_events} drift events`);
  check('F2 variants produce no spurious change', report.rda.every((row) => row.spurious_innovation === 0));
  check('F4 is skipped, not scored', report.run.skipped.some((entry) => entry.id === 'F4'));
}

console.log('\ndrifty stub (unstable claims must fail consistency)');
{
  const { status, outDir } = run(['--provider', 'stub', '--quality', 'drifty', '--all', '--repeats', '3', '--out', 'runs/selftest-drifty', '--strict']);
  const report = await reportOf(outDir);
  check('strict run exits 1', status === 1, `got ${status}`);
  const consistency = report.models[0].grade.metrics.consistency;
  check('consistency falls below threshold', consistency !== null && consistency < report.thresholds.values.consistency_min, `consistency ${consistency}`);
  check('coverage is still reported', report.models[0].grade.metrics.coverage > 0);
}

console.log('\nsloppy stub (a fabricated citation must be rejected)');
{
  const { status, outDir } = run(['--provider', 'stub', '--quality', 'sloppy', '--all', '--repeats', '2', '--out', 'runs/selftest-sloppy']);
  const report = await reportOf(outDir);
  check('run exits 1 on rejected snapshots', status === 1, `got ${status}`);
  check('rejected snapshots are counted', report.totals.invalid > 0, `${report.totals.invalid} rejected`);
  check('every fixture reported a rejection', report.models[0].grade.per_fixture.every((grade) => grade.invalid_snapshots > 0));
  check('rejection names the fabricated quote', report.invalid_details.some((detail) => detail.errors.some((error) => error.includes('fabricated_quote'))));
}

console.log('\ninjective stub (an obeyed instruction must fail the injection fixture)');
{
  const { status, outDir } = run(['--provider', 'stub', '--quality', 'injective', '--all', '--repeats', '2', '--out', 'runs/selftest-injective', '--strict']);
  const report = await reportOf(outDir);
  const injection = report.models[0].grade.per_fixture.find((grade) => grade.fixture === 'F6');
  check('strict run exits 1', status === 1, `got ${status}`);
  check('F6 injection pass rate is zero', injection?.injection.pass_rate === 0, `pass rate ${injection?.injection.pass_rate}`);
}

console.log('');
if (failures.length) {
  console.error(`selftest failed (${failures.length}):`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log('selftest passed: graders discriminate as specified.');
