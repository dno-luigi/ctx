/**
 * Token calibration.
 *
 * Every budget decision in this engine is made with `ceil(chars / 4)`. That is a guess about someone
 * else's tokenizer, and until it is compared with provider-reported usage it is only a guess with a
 * decimal point. This tool measures it: it rebuilds the exact prompts a stored live run sent, counts
 * their characters, and compares the estimate with the input tokens the provider actually billed.
 *
 * No model is called and nothing is spent. The limitation is stated in the output: the prompt is
 * rebuilt from the current code and the stored artifacts, not read back from a recorded request. If
 * the prompt-building code has changed since the run, the rebuilt character count is not the sent one
 * and the comparison is invalid — so the tool re-derives the acquisition digest and refuses to
 * calibrate against a subject that no longer matches the snapshot.
 *
 * Usage:
 *   node context-engine/poc/calibrate.js --run examples/live-approved
 */

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { acquire } from '../src/source.js';
import { partitionSources, extractReferences, estimateTokens } from '../src/partition.js';
import { resolvePartitionBudget } from '../src/budget.js';
import { buildScanPrompt } from '../src/scan.js';
import { loadModels, resolveModel } from '../src/providers.js';
import { buildQaPrompt } from './qa.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const engineRoot = path.resolve(here, '..');

const args = {};
const argv = process.argv.slice(2);
for (let index = 0; index < argv.length; index += 1) {
  if (!argv[index].startsWith('--')) continue;
  const [key, inline] = argv[index].slice(2).split('=');
  if (inline !== undefined) args[key] = inline;
  else if (argv[index + 1] && !argv[index + 1].startsWith('--')) args[key] = argv[++index];
  else args[key] = true;
}

const runDir = path.resolve(engineRoot, args.run ?? 'examples/live-approved');
const fixtureRoot = path.join(engineRoot, 'fixtures/poc-repo');
const reference = args.model ?? 'glm-flash-latest';

const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));
const snapshot = readJson(path.join(runDir, 'snapshot-poc-repo.json'));
const qaRecheckFile = path.join(runDir, 'qa-recheck.json');
const qaRecheck = readJson(qaRecheckFile);
const instrumentRows = readFileSync(path.join(runDir, 'instrumentation.jsonl'), 'utf8')
  .split('\n')
  .filter((line) => line.trim())
  .map((line) => JSON.parse(line));

const registry = await loadModels();
const model = resolveModel(registry, reference);
const plan = resolvePartitionBudget({ policy: registry.partition ?? {}, model, requestedTokens: null });

const acquisition = await acquire({ root: fixtureRoot, rootLabel: 'poc-repo' });
if (acquisition.digest !== snapshot.subject.source_digest) {
  console.error('refusing to calibrate: the fixture no longer matches the snapshot subject digest');
  console.error(`  fixture now: ${acquisition.digest}`);
  console.error(`  snapshot:    ${snapshot.subject.source_digest}`);
  process.exit(2);
}

const partitionInfo = partitionSources(acquisition.sources, { maxTokens: plan.budget_tokens });
const sourcesById = new Map(acquisition.sources.map((source) => [source.source_id, source]));
const allReferences = extractReferences(acquisition.sources);

const rows = [];

// --- scan prompt (one partition in this subject)
const scanRow = instrumentRows[0];
if (!scanRow || typeof scanRow.input_tokens !== 'number') {
  rows.push({ prompt: 'scan', skipped: 'no provider-reported input tokens in instrumentation' });
} else {
  const partition = partitionInfo.partitions[0];
  const references = allReferences.filter((edge) => partition.source_ids.includes(edge.from) || partition.source_ids.includes(edge.to));
  const prompt = buildScanPrompt({
    subject: { root: 'poc-repo', files: acquisition.totals.files, bytes: acquisition.totals.bytes, partition_count: partitionInfo.partitions.length },
    partition,
    sourcesById,
    references,
  });
  rows.push(measure({ prompt: 'scan', system: prompt.system, user: prompt.user, reported: scanRow.input_tokens, call: 'scan' }));
}

// --- QA prompt (built from the stored contradiction-bearing pack)
const qaPackPath = path.join(runDir, qaRecheck.pack?.file ?? 'pack-medium-contradictions.json');
const qaPack = readJson(qaPackPath);
const groundTruth = readJson(path.join(engineRoot, 'fixtures/poc-repo.ground-truth.json'));
if (typeof qaRecheck.usage?.input_tokens === 'number') {
  const prompt = buildQaPrompt({ pack: qaPack, questions: groundTruth.questions });
  rows.push(measure({ prompt: 'qa', system: prompt.system, user: prompt.user, reported: qaRecheck.usage.input_tokens, call: 'qa' }));
} else {
  rows.push({ prompt: 'qa', skipped: 'no provider-reported input tokens in qa-recheck.json' });
}

function measure({ prompt, system, user, reported, call }) {
  const chars = system.length + user.length;
  const estimated = estimateTokens(system + user);
  const charsPerToken = chars / reported;
  const ratio = estimated / reported;
  return {
    prompt,
    call,
    chars,
    chars_in_system: system.length,
    chars_in_user: user.length,
    estimated_tokens: estimated,
    reported_input_tokens: reported,
    chars_per_token: Number(charsPerToken.toFixed(3)),
    estimate_over_reported: Number(ratio.toFixed(3)),
    estimate_error_pct: Number((((estimated - reported) / reported) * 100).toFixed(1)),
    direction: ratio > 1.05 ? 'conservative' : ratio < 0.95 ? 'optimistic' : 'calibrated',
  };
}

const measured = rows.filter((row) => !row.skipped);
const meanCharsPerToken = measured.length
  ? Number((measured.reduce((sum, row) => sum + row.chars_per_token, 0) / measured.length).toFixed(3))
  : null;
const worstOptimism = measured.length ? Math.min(...measured.map((row) => row.estimate_over_reported)) : null;

const verdict = worstOptimism === null
  ? 'unmeasured'
  : worstOptimism < 0.95
    ? 'optimistic: ceil(chars/4) understates tokens, so a pack can look smaller than it bills'
    : worstOptimism > 1.05
      ? 'conservative: ceil(chars/4) overstates tokens, so budgets are safe but leave usable room unused'
      : 'calibrated within 5% on every measured prompt';

const result = {
  schema: 'context-engine/token-calibration/v1',
  at: new Date().toISOString(),
  run: path.relative(engineRoot, runDir),
  snapshot_id: snapshot.snapshot_id,
  subject_digest_matches: true,
  model: { requested: model.slug, resolved_recorded: scanRow?.resolved_model ?? null },
  estimator: { method: 'ceil(chars/4)', divisor: 4 },
  prompts: rows,
  summary: {
    prompts_measured: measured.length,
    mean_chars_per_token: meanCharsPerToken,
    recommended_divisor: meanCharsPerToken,
    worst_estimate_over_reported: worstOptimism,
    verdict,
  },
  limitation: 'Prompts are rebuilt from the current prompt code and the stored artifacts, not read back from a recorded request. If that code changed after the run, the character count is not the sent one; the subject digest is re-derived and checked to catch a changed fixture, but not a changed prompt.',
};

writeFileSync(path.join(runDir, 'token-calibration.json'), JSON.stringify(result, null, 2));

console.log(`token calibration · ${result.run} · estimator ceil(chars/4)`);
for (const row of rows) {
  if (row.skipped) {
    console.log(`  ${row.prompt}: skipped — ${row.skipped}`);
    continue;
  }
  console.log(
    `  ${row.prompt.padEnd(5)} chars ${String(row.chars).padStart(6)} · estimated ${String(row.estimated_tokens).padStart(5)} · reported ${String(row.reported_input_tokens).padStart(5)} · ${row.chars_per_token} chars/token · ${row.estimate_error_pct >= 0 ? '+' : ''}${row.estimate_error_pct}% (${row.direction})`
  );
}
console.log(`  verdict: ${verdict}`);
console.log(`  recommended divisor: ${meanCharsPerToken ?? 'n/a'} (current: 4)`);
console.log(`wrote ${path.relative(process.cwd(), path.join(runDir, 'token-calibration.json'))}`);
