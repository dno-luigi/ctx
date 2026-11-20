/**
 * The snapshot-as-state cost test.
 *
 * The hypothesis: if one good snapshot exists, later questions can be asked of the
 * snapshot instead of the source, and cost collapses. This measures that, and it has
 * to be measured carefully, because the obvious version is circular: asking a
 * snapshot the same questions it was built from proves only that the snapshot
 * contains its own cards.
 *
 * So two banks are used, neither of which the snapshot was built from:
 *
 *   - **held-out** questions about source content the pass-1 bank never asked
 *     (rebalance lag, queue-depth interval, backfill overrun, offset ordering,
 *     unrecoverable failure, coordinator state, cold-shard scheduling). This is the
 *     substitution test: can the snapshot stand in for the source?
 *   - **delta** questions about an amendment that conflicts with the prior state.
 *     This is the RDA-shaped test: can a downstream engine detect a change using the
 *     snapshot as the prior state?
 *
 * The reference answer is the same engine's answer against the full source, so
 * fidelity is measured without inventing an answer key. Where the engine is wrong
 * against the source, both states can be wrong together — that is a limit of the
 * test, stated in the record, not a reason to prefer one state.
 *
 * Cost is provider-reported for both states, so the ratio is measured, not modelled.
 *
 * Usage:
 *   node tools/snapshot-state-test.js --fixture F2a --snapshot-from perplexity/pplx-decider-flash-v1.2 --dry
 *   node tools/snapshot-state-test.js --fixture F2a --snapshot-from perplexity/pplx-decider-flash-v1.2
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';

import { buildState, send } from '../adapters/decision/interface.js';
import { normaliseResponse } from '../adapters/decision/normalize.js';
import { createPerplexity } from '../adapters/decision/perplexity.js';
import { createScaleDown } from '../adapters/decision/scaledown.js';
import { validateBank } from '../adapters/decision/validate.js';

const ROOT = new URL('../', import.meta.url);
const ENDPOINT = 'https://openrouter.ai/api/alpha/decisions';

/**
 * The amendment is per-fixture: `banks/<fixture>.delta-document.json`. It is synthetic
 * and declared as such in each file, so a delta result is never mistaken for a
 * measurement on organic change.
 */

function parseArgs(argv) {
  const options = { out: 'runs/live/state-test', dry: false, maxUsd: 0.05, models: null };
  for (let index = 0; index < argv.length; index += 1) {
    const [flag, inline] = argv[index].split('=');
    if (flag === '--fixture') options.fixture = inline ?? argv[++index];
    else if (flag === '--snapshot-from') options.snapshotFrom = inline ?? argv[++index];
    else if (flag === '--models') options.models = (inline ?? argv[++index]).split(',');
    else if (flag === '--out') options.out = inline ?? argv[++index];
    else if (flag === '--max-usd') options.maxUsd = Number(inline ?? argv[++index]);
    else if (flag === '--dry') options.dry = true;
  }
  return options;
}

const options = parseArgs(process.argv.slice(2));
if (!options.fixture || !options.snapshotFrom) {
  console.error('usage: node tools/snapshot-state-test.js --fixture <id> --snapshot-from <model-slug> [--models a,b] [--dry]');
  process.exit(2);
}

const deciders = JSON.parse(await readFile(new URL('deciders.json', ROOT), 'utf8'));
const descriptorOf = (slug) => deciders.models.find((model) => model.id === slug || model.request_model === slug);
const slugOf = (id) => id.replace(/[/:]/g, '_');
const adapterFor = (entry) => (entry.vendor === 'ScaleDown' ? createScaleDown(entry) : createPerplexity(entry));

const available = deciders.models.filter((model) => model.available !== false).map((model) => model.id);
const modelIds = options.models ?? available;

const snapshotSource = descriptorOf(options.snapshotFrom);
if (!snapshotSource) {
  console.error(`unknown --snapshot-from model ${options.snapshotFrom}`);
  process.exit(2);
}
const snapshotRecord = JSON.parse(
  await readFile(new URL(`runs/live/${slugOf(snapshotSource.id)}/${options.fixture}.r1.json`, ROOT), 'utf8')
);
if (!snapshotRecord.http.ok) {
  console.error('the pass-1 record used as the snapshot is not a successful run');
  process.exit(1);
}

const input = JSON.parse(await readFile(new URL(`fixtures/${options.fixture}/input.json`, ROOT), 'utf8'));
const heldout = JSON.parse(await readFile(new URL(`banks/${options.fixture}.heldout.json`, ROOT), 'utf8'));
const delta = JSON.parse(await readFile(new URL(`banks/${options.fixture}.delta.json`, ROOT), 'utf8'));
const deltaDoc = JSON.parse(await readFile(new URL(`banks/${options.fixture}.delta-document.json`, ROOT), 'utf8'));
const DELTA_SOURCE = deltaDoc.source;

/**
 * A faithful text rendering of the stored snapshot: the cards exactly as assembled,
 * with their confidences, plus gaps, checks and abstentions. Nothing is added that
 * the snapshot does not contain, and the absence of citations is stated rather than
 * silently omitted.
 */
function renderSnapshotText(snapshot, task) {
  const lines = [
    '# Snapshot (harness-assembled from the source; no citations are available on this path)',
    task ? `Question it was built for: ${task}` : null,
    '',
    '## Cards',
  ].filter((line) => line !== null);
  for (const card of snapshot.observations) {
    lines.push(`- [${card.kind}] ${card.claim} (extraction confidence ${card.confidence.extraction}, interpretation ${card.confidence.interpretation})`);
  }
  if (snapshot.gaps?.length) {
    lines.push('', '## Gaps');
    for (const gap of snapshot.gaps) lines.push(`- ${gap.missing}`);
  }
  if (snapshot.abstentions?.length) {
    lines.push('', '## Not settled');
    for (const abstention of snapshot.abstentions) lines.push(`- ${abstention.topic}: ${abstention.reason}`);
  }
  if (snapshot.checks?.length) {
    lines.push('', '## What would settle open items');
    for (const check of snapshot.checks) lines.push(`- ${check.question}`);
  }
  lines.push('');
  return lines.join('\n');
}

const snapshotText = renderSnapshotText(snapshotRecord.snapshot, snapshotRecord.bank?.fixture ?? null);
const snapshotInput = {
  schema: input.schema,
  run: input.run,
  task: input.task,
  sources: [
    {
      id: 'snap',
      kind: 'snapshot',
      label: 'assembled snapshot',
      media_type: 'text/plain',
      status: 'ready',
      content: { text: snapshotText, data_url: null },
      origin: { supplied_by: 'operator', method: 'harness-rendered', captured_at: new Date().toISOString() },
      observation: 'derived',
    },
  ],
  budgets: input.budgets,
};

const variants = {
  source: { label: 'full source', state: buildState(input), bank: heldout, input },
  snapshot: { label: 'snapshot as state', state: buildState(snapshotInput), bank: heldout, input: snapshotInput },
  source_plus_delta: { label: 'full source + change notice', state: buildState({ ...input, sources: [...input.sources, DELTA_SOURCE] }), bank: delta, input: { ...input, sources: [...input.sources, DELTA_SOURCE] } },
  snapshot_plus_delta: {
    label: 'snapshot + change notice',
    state: buildState({ ...snapshotInput, sources: [...snapshotInput.sources, DELTA_SOURCE] }),
    bank: delta,
    input: { ...snapshotInput, sources: [...snapshotInput.sources, DELTA_SOURCE] },
  },
};

console.log(`snapshot-as-state  ${options.fixture}  (snapshot from ${snapshotSource.id} pass 1)`);
console.log(`  snapshot text: ${snapshotText.length} chars, ${snapshotRecord.snapshot.observations.length} card(s)`);
for (const [key, variant] of Object.entries(variants)) {
  console.log(`  ${key.padEnd(20)} state ${String(variant.state.text.length).padStart(7)} chars, ${variant.bank.questions.length} question(s)`);
}

const planned = Object.entries(variants).flatMap(([key, variant]) =>
  modelIds.map((modelId) => ({ key, variant, descriptor: descriptorOf(modelId) }))
);
// Measured on this cohort: the endpoint tokenises at ~5 chars/token, so the chars/4
// estimate is already conservative; 2x covers tokenizer variation. Perplexity charges
// the state once per group, ScaleDown once per question.
const TOKENIZER_GUARD = 2;
const worstCase = planned.reduce((total, entry) => {
  const est = Math.ceil(entry.variant.state.text.length / 4);
  const charges = entry.descriptor.vendor === 'ScaleDown' ? entry.variant.bank.questions.length : 1;
  return total + (est * TOKENIZER_GUARD * charges * entry.descriptor.pricing.input_per_mtok) / 1e6;
}, 0);
console.log(`  worst case for ${planned.length} call(s): $${worstCase.toFixed(6)} (ceiling $${options.maxUsd})`);

if (options.dry) {
  console.log('  dry run — nothing sent');
  process.exit(0);
}
if (worstCase > options.maxUsd) {
  console.error('  refused: worst case exceeds the ceiling');
  process.exit(3);
}

const apiKey = process.env.OPENROUTER_API_KEY;
if (!apiKey) {
  console.error('  OPENROUTER_API_KEY is not set in this environment');
  process.exit(4);
}

const results = [];
for (const { key, variant, descriptor } of planned) {
  const adapter = adapterFor(descriptor);
  const validated = validateBank(variant.bank, { adapter, input: variant.input });
  if (!validated.ok) {
    console.error(`  ${descriptor.id} ${key}: bank refused — ${validated.errors.join('; ')}`);
    continue;
  }
  const request = adapter.buildRequest({ state: variant.state, questions: variant.bank.questions });
  request.endpoint = descriptor.endpoint ?? ENDPOINT;

  const startedAt = Date.now();
  const response = await send(
    {
      endpoint: request.endpoint,
      headers: {
        ...request.headers,
        authorization: `Bearer ${apiKey}`,
        'HTTP-Referer': 'https://github.com/Ai-Nspired/gca-experiment',
        'X-Title': 'gca snapshot-as-state test',
      },
      body: request.body,
    },
    fetch
  );
  const latencyMs = Date.now() - startedAt;
  const normalised = response.ok ? normaliseResponse({ adapter, body: response.body, bank: variant.bank, state: variant.state }) : null;

  results.push({
    variant: key,
    variant_label: variant.label,
    model: descriptor.id,
    state_chars: variant.state.text.length,
    questions: variant.bank.questions.length,
    http: { status: response.status, ok: response.ok },
    latency_ms: latencyMs,
    usage: normalised?.usage ?? null,
    answers: normalised?.answers ?? null,
    problems: normalised?.problems ?? [],
    response_body: response.ok ? undefined : response.body,
  });

  console.log(
    `  ${descriptor.id.padEnd(36)} ${key.padEnd(20)} HTTP ${response.status}  ${String(normalised?.usage?.input_tokens ?? '-').padStart(6)} tok  $${normalised?.usage?.cost_usd ?? '-'}  ${latencyMs} ms`
  );
}

// ----------------------------------------------------------------- comparison

const byModel = {};
for (const result of results) {
  if (!result.http.ok) continue;
  (byModel[result.model] ??= {})[result.variant] = result;
}

const comparison = [];
for (const [model, entry] of Object.entries(byModel)) {
  const pairs = [
    { question_set: 'heldout', full: entry.source, snap: entry.snapshot },
    { question_set: 'delta', full: entry.source_plus_delta, snap: entry.snapshot_plus_delta },
  ].filter((pair) => pair.full && pair.snap);

  for (const pair of pairs) {
    const names = [...new Set([...Object.keys(pair.full.answers ?? {}), ...Object.keys(pair.snap.answers ?? {})])];
    const perQuestion = names.map((name) => {
      const full = pair.full.answers?.[name] ?? null;
      const snap = pair.snap.answers?.[name] ?? null;
      const render = (answer) =>
        !answer
          ? 'missing'
          : answer.type === 'noul'
          ? `P=${answer.probability.toFixed(3)}`
          : answer.type === 'choice'
          ? answer.choice
          : answer.type === 'score'
          ? `score ${answer.score}`
          : `${answer.spans.length} span(s)`;
      const key = (answer) =>
        !answer ? 'missing' : answer.type === 'noul' ? `noul:${answer.probability >= 0.5 ? 'yes' : 'no'}` : answer.type === 'choice' ? `choice:${answer.choice}` : 'other';
      return {
        name,
        full: render(full),
        snap: render(snap),
        match: key(full) === key(snap),
        full_probability: full?.type === 'noul' ? full.probability : null,
        snap_probability: snap?.type === 'noul' ? snap.probability : null,
        delta: full?.type === 'noul' && snap?.type === 'noul' ? Number(Math.abs(full.probability - snap.probability).toFixed(3)) : null,
      };
    });
    const fullCost = pair.full.usage?.cost_usd ?? 0;
    const snapCost = pair.snap.usage?.cost_usd ?? 0;
    comparison.push({
      model,
      question_set: pair.question_set,
      questions: perQuestion.length,
      matching: perQuestion.filter((question) => question.match).length,
      per_question: perQuestion,
      cost: {
        full_usd: fullCost,
        snapshot_usd: snapCost,
        ratio: snapCost > 0 ? Number((fullCost / snapCost).toFixed(2)) : null,
        saved_fraction: fullCost > 0 ? Number(((fullCost - snapCost) / fullCost).toFixed(4)) : null,
      },
      tokens: {
        full: pair.full.usage?.input_tokens ?? null,
        snapshot: pair.snap.usage?.input_tokens ?? null,
      },
    });
  }
}

const summary = {
  schema: 'gca-snapshot-as-state/v1',
  generated_at: new Date().toISOString(),
  fixture: options.fixture,
  snapshot_from: snapshotSource.id,
  snapshot: {
    cards: snapshotRecord.snapshot.observations.length,
    chars: snapshotText.length,
    citations_available: false,
    rendered_text: snapshotText,
  },
  design: {
    heldout_bank: `banks/${options.fixture}.heldout.json — content the pass-1 bank never asked`,
    delta_bank: `banks/${options.fixture}.delta.json — amendment that conflicts with the prior state`,
    reference: 'the same engine\'s answer against the full source, so fidelity needs no invented answer key',
    circularity_control: 'the snapshot was built from the pass-1 bank; neither test bank overlaps it',
  },
  results,
  comparison,
  limits: [
    'Fidelity is agreement with this engine\'s full-source answer, not with the source. An engine that is wrong on the source is wrong identically in both states.',
    'One fixture. F2a repeats eight paragraphs, which helps long-context reading and does not represent varied prose.',
    'The delta document is synthetic and written for this test, so the delta result is a demonstration of mechanism, not a measurement on organic change.',
    'No engine in this cohort can cite, so the snapshot carries no evidence and the test cannot say whether a cited snapshot would fare differently.',
  ],
};

// One file per fixture: a shared summary.json was silently overwritten when this tool
// was first reused across fixtures, which is exactly the kind of record loss the
// harness is supposed to prevent.
await mkdir(new URL(`${options.out}/`, ROOT), { recursive: true });
await writeFile(new URL(`${options.out}/${options.fixture}.json`, ROOT), `${JSON.stringify(summary, null, 2)}\n`);

// -------------------------------------------------------------------- console

for (const entry of comparison) {
  console.log(`\n${entry.model} · ${entry.question_set}: ${entry.matching}/${entry.questions} match full-source answer`);
  for (const question of entry.per_question) {
    const mark = question.match ? '  ' : '≠ ';
    console.log(`  ${mark}${question.name.padEnd(20)} full ${question.full.padEnd(26)} snapshot ${question.snap}`);
  }
  console.log(`     cost: full $${entry.cost.full_usd} → snapshot $${entry.cost.snapshot_usd}  ${entry.cost.ratio}x cheaper  (${(entry.cost.saved_fraction * 100).toFixed(1)}% saved)`);
}

console.log(`\nwrote ${options.out}/${options.fixture}.json`);
process.exit(results.every((result) => result.http.ok) ? 0 : 1);
