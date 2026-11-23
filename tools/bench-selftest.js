#!/usr/bin/env node
/**
 * Checks the gates in tools/bench-run.js, not the benchmark.
 *
 * Each case spawns the runner with a chosen environment and asserts the exact refusal bullets, so a
 * gate that stops firing is a failure here rather than a quiet widening of what can spend money.
 * The missing-key cases delete OPENROUTER_API_KEY from the child environment: this repo's own
 * sandbox has a real key exported, and a test that only passes because of it would prove nothing.
 *
 * No case reaches a provider. The authorised case carries a placeholder key and must still exit 2,
 * which is itself the check that live execution has not been implemented behind our back.
 */

import { spawnSync } from 'node:child_process';

const RUNNER = 'tools/bench-run.js';
const PLACEHOLDER_KEY = 'not-a-real-key-selftest-only';
const failures = [];
let executed = 0;
let passed = 0;

function check(name, condition, detail = '') {
  executed += 1;
  if (condition) {
    passed += 1;
    console.log(`  PASS  ${name}`);
    return;
  }
  failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
  console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
}

/** The child's environment, with the key removed rather than blanked. */
function withoutKey() {
  const env = { ...process.env };
  delete env.OPENROUTER_API_KEY;
  return env;
}

function withKey() {
  return { ...process.env, OPENROUTER_API_KEY: PLACEHOLDER_KEY };
}

function run(args, env) {
  const result = spawnSync(process.execPath, [RUNNER, ...args], { encoding: 'utf8', env });
  const out = result.stdout ?? '';
  const problems = out
    .split('\n')
    .filter((line) => line.startsWith('- '))
    .map((line) => line.slice(2));
  return { status: result.status, out, err: result.stderr ?? '', problems };
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// The key really is gone in the child, or every case below means something else.
const probe = spawnSync(
  process.execPath,
  ['-e', 'process.stdout.write(process.env.OPENROUTER_API_KEY === undefined ? "absent" : "present")'],
  { encoding: 'utf8', env: withoutKey() },
);
check('the child environment has no OPENROUTER_API_KEY to inherit', probe.stdout === 'absent', `child says ${JSON.stringify(probe.stdout)}`);

const missingKey = 'OPENROUTER_API_KEY is not present in this environment';
const belowFloor = 'budget $0.05 is below the BENCHMARK-01 floor $0.10';

// 1. Everything authorised except the key: the key is the only thing that stops it.
const noKey = run(['--live', '--budget-usd', '0.10'], { ...withoutKey(), BENCH_CONFIRM: 'authorize-spend' });
check('missing key alone refuses the run', noKey.status === 1, `exit ${noKey.status}`);
check(
  'missing key is the only problem reported, so the gates are independent',
  same(noKey.problems, [missingKey]),
  JSON.stringify(noKey.problems),
);
check('the missing-key refusal says no provider was contacted', noKey.out.includes('No provider was contacted'));

// 2. Two gates failing at once are both reported, not the first one only.
const noKeyCheap = run(['--live', '--budget-usd', '0.05'], { ...withoutKey(), BENCH_CONFIRM: 'authorize-spend' });
check(
  'a below-floor budget and a missing key are both refused and both named',
  noKeyCheap.status === 1 && same(noKeyCheap.problems, [belowFloor, missingKey]),
  `exit ${noKeyCheap.status} ${JSON.stringify(noKeyCheap.problems)}`,
);

// 3. The floor itself, with a key present.
const cheap = run(['--live', '--budget-usd', '0.05'], { ...withKey(), BENCH_CONFIRM: 'authorize-spend' });
check('a budget below the floor is refused', cheap.status === 1 && same(cheap.problems, [belowFloor]), `exit ${cheap.status} ${JSON.stringify(cheap.problems)}`);

// 4. A design with no budget file has no floor, so it cannot be authorised at any price.
const unknown = run(['--live', '--design', 'BENCHMARK-99', '--budget-usd', '5'], { ...withKey(), BENCH_CONFIRM: 'authorize-spend' });
check(
  'an unknown design is refused for having no floor',
  unknown.status === 1 && same(unknown.problems, ['no budget floor at context-engine/BENCHMARK-99.budget.json — BENCHMARK-99 cannot be authorised']),
  `exit ${unknown.status} ${JSON.stringify(unknown.problems)}`,
);

// 5. The confirmation phrase is its own gate.
const unconfirmed = run(['--live', '--budget-usd', '0.10'], { ...withKey(), BENCH_CONFIRM: '' });
check(
  'an unconfirmed run is refused at the floor',
  unconfirmed.status === 1 && same(unconfirmed.problems, ['confirm input is "", not "authorize-spend"']),
  `exit ${unconfirmed.status} ${JSON.stringify(unconfirmed.problems)}`,
);

// 6. Every gate satisfied lands on the not-implemented exit, never on a provider.
const authorised = run(['--live', '--budget-usd', '0.10'], { ...withKey(), BENCH_CONFIRM: 'authorize-spend' });
check('a fully authorised run stops at exit 2', authorised.status === 2, `exit ${authorised.status}`);
check('the authorised run reports no refusal', authorised.problems.length === 0, JSON.stringify(authorised.problems));
check(
  'the authorised run says live execution is unimplemented',
  authorised.err.includes('Live execution is not implemented'),
  JSON.stringify(authorised.err.slice(-120)),
);

// 7. The default mode needs no key at all.
const dry = run(['--dry'], withoutKey());
check('the dry run needs no key and exits 0', dry.status === 0 && dry.problems.length === 0, `exit ${dry.status} ${JSON.stringify(dry.problems)}`);

console.log('');
if (failures.length) {
  for (const failure of failures) console.log(`  FAILED: ${failure}`);
  console.log(`0/${executed} checks passed`);
  process.exit(1);
}
console.log(`${passed}/${executed} checks passed`);
