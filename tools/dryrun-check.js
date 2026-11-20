/**
 * Harness dry run — one fixture per arm, synthetic transcripts, known answers.
 *
 * This validates the measurement machinery, not the hypotheses. The transcripts are
 * hand-authored, so a match here says the scorer computes what it claims, that the arms are
 * distinguishable on every metric they are supposed to distinguish, and that the blind packet
 * really removes arm identity.
 *
 * It says nothing about whether either arm helps an agent, and must never be cited as a result.
 *
 * Usage: node tools/dryrun-check.js
 */

import { readFile } from 'node:fs/promises';

import { buildPacket, isBlind } from './blind-packet.js';
import { captureUsage } from './usage-capture.js';
import { scoreTranscript } from './score-transcript.js';

const ROOT = new URL('../', import.meta.url);

const patch = JSON.parse(await readFile(new URL('pilot/patches/C4.json', ROOT), 'utf8'));
const expected = JSON.parse(await readFile(new URL('pilot/dryrun/expected.json', ROOT), 'utf8'));
const arms = {};
for (const arm of ['control', 'treatment']) {
  arms[arm] = JSON.parse(await readFile(new URL(`pilot/dryrun/transcripts/C4.${arm}.json`, ROOT), 'utf8'));
}

let checks = 0;
let failed = 0;
const assert = (name, ok, detail) => {
  checks += 1;
  if (!ok) failed += 1;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ` — ${detail}`}`);
};

const scored = {};
for (const [arm, transcript] of Object.entries(arms)) {
  const score = scoreTranscript(transcript, patch.gold);
  scored[arm] = score;
  console.log(`\n${arm}:`);
  for (const [metric, want] of Object.entries(expected.arms[arm])) {
    assert(`${metric} = ${want}`, score[metric] === want, `got ${score[metric]}`);
  }

  const usage = captureUsage(transcript.tokens ?? {}, { gcaProcessingUsd: 0.000124 });
  assert(`${arm}: usage captured without mixing`, usage.agent_total_tokens !== null || transcript.tokens === undefined, JSON.stringify(usage.unavailable));
  assert(`${arm}: GCA cost kept separate from agent tokens`, usage.gca_processing_usd === 0.000124 && usage.agent_total_tokens !== usage.gca_processing_usd, `${usage.gca_processing_usd} vs ${usage.agent_total_tokens}`);

  const packet = buildPacket(transcript, patch.gold);
  assert(`${arm}: packet is blind`, isBlind(packet), Object.keys(packet).join(','));
  assert(`${arm}: packet drops the arm`, packet.arm === undefined, String(packet.arm));
}

console.log('\narm separation:');
const metrics = ['retrieval_recall', 'symbol_recall', 'impact_accuracy', 'missed_dependencies', 'repeated_work', 'unsupported_assumptions', 'oracle_passed'];
let distinguished = 0;
for (const metric of metrics) {
  const differs = JSON.stringify(scored.control[metric]) !== JSON.stringify(scored.treatment[metric]);
  if (differs) distinguished += 1;
  assert(`arms differ on ${metric}`, differs, 'identical values');
}
assert('separation covers at least 6 of 7 metrics', distinguished >= 6, `${distinguished}/7`);

console.log(`\nharness dry run: ${checks - failed}/${checks} checks passed`);
console.log('synthetic transcripts — harness validation only, not a pilot result');
process.exit(failed === 0 ? 0 : 1);
