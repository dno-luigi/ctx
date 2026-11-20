/**
 * Q3: can RDA propagate a change without silently losing unaffected information or
 * introducing unsupported conclusions?
 *
 * Method. Two arms receive the same amendment appended to their state:
 *
 *   A. **full source + amendment** — the reference, what the engine says when it has
 *      everything;
 *   B. **snapshot + amendment** — the propagation path, where the snapshot is the
 *      prior state.
 *
 * Each arm is asked the *original* bank (which facts survive?) and the *delta* bank
 * (what changed?). The comparison is within one engine, so no answer key is needed
 * and no cross-model difference can be mistaken for a propagation error.
 *
 * Four outcomes per original-bank question, defined against arm A:
 *
 *   - **preserved** — arm A still gives the pre-change answer, and arm B agrees.
 *   - **changed correctly** — the amendment moves arm A's answer, and arm B moves the
 *     same way.
 *   - **silent loss** — arm A keeps the pre-change answer, arm B does not. The
 *     snapshot dropped something the amendment never touched.
 *   - **stale** — the amendment moves arm A's answer, arm B keeps the old one. The
 *     snapshot failed to propagate a change it was given.
 *
 * A fifth outcome, **divergent**, covers arm B asserting something arm A does not in
 * either direction without matching one of the four above; it is listed, never
 * silently merged into "preserved".
 *
 * Usage:
 *   node tools/rda-propagation.js --fixture F3 --model perplexity/pplx-decider-flash-v1.2
 *   node tools/rda-propagation.js --fixtures F3,F9 --models perplexity/pplx-decider-flash-v1.2,scaledown/classify-1
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';

import { buildState, send } from '../adapters/decision/interface.js';
import { normaliseResponse } from '../adapters/decision/normalize.js';
import { createPerplexity } from '../adapters/decision/perplexity.js';
import { createScaleDown } from '../adapters/decision/scaledown.js';
import { validateBank } from '../adapters/decision/validate.js';

const ROOT = new URL('../', import.meta.url);
const ENDPOINT = 'https://openrouter.ai/api/alpha/decisions';

function parseArgs(argv) {
  const options = { out: 'runs/live/rda', dry: false, maxUsd: 0.05, records: 'runs/live' };
  for (let index = 0; index < argv.length; index += 1) {
    const [flag, inline] = argv[index].split('=');
    if (flag === '--fixture') options.fixtures = [(inline ?? argv[++index])];
    else if (flag === '--fixtures') options.fixtures = (inline ?? argv[++index]).split(',');
    else if (flag === '--model') options.models = [(inline ?? argv[++index])];
    else if (flag === '--models') options.models = (inline ?? argv[++index]).split(',');
    else if (flag === '--out') options.out = inline ?? argv[++index];
    else if (flag === '--records') options.records = inline ?? argv[++index];
    else if (flag === '--max-usd') options.maxUsd = Number(inline ?? argv[++index]);
    else if (flag === '--dry') options.dry = true;
  }
  options.models ??= ['perplexity/pplx-decider-flash-v1.2'];
  return options;
}

const options = parseArgs(process.argv.slice(2));
if (!options.fixtures) {
  console.error('usage: node tools/rda-propagation.js --fixtures F3,F9 --models a,b [--dry]');
  process.exit(2);
}

const deciders = JSON.parse(await readFile(new URL('deciders.json', ROOT), 'utf8'));
const descriptorOf = (slug) => deciders.models.find((model) => model.id === slug || model.request_model === slug);
const slugOf = (id) => id.replace(/[/:]/g, '_');
const adapterFor = (entry) => (entry.vendor === 'ScaleDown' ? createScaleDown(entry) : createPerplexity(entry));

function answerKey(answer, threshold) {
  if (!answer) return 'missing';
  if (answer.type === 'noul') return `noul:${answer.probability >= threshold ? 'yes' : 'no'}`;
  if (answer.type === 'choice') return `choice:${answer.choice}`;
  if (answer.type === 'score') return `score:${answer.score}`;
  return 'locate';
}

function renderAnswer(answer) {
  if (!answer) return 'missing';
  if (answer.type === 'noul') return `P=${answer.probability.toFixed(3)}`;
  if (answer.type === 'choice') return answer.choice;
  if (answer.type === 'score') return `score ${answer.score}`;
  return `${answer.spans?.length ?? 0} span(s)`;
}

function renderSnapshotText(snapshot) {
  const lines = ['# Snapshot (harness-assembled from the source; no citations are available on this path)', '', '## Cards'];
  for (const card of snapshot.observations) lines.push(`- [${card.kind}] ${card.claim}`);
  if (snapshot.abstentions?.length) {
    lines.push('', '## Not settled');
    for (const abstention of snapshot.abstentions) lines.push(`- ${abstention.topic}: ${abstention.reason}`);
  }
  lines.push('');
  return lines.join('\n');
}

const runs = [];
const planned = [];

for (const fixture of options.fixtures) {
  const input = JSON.parse(await readFile(new URL(`fixtures/${fixture}/input.json`, ROOT), 'utf8'));
  const deltaBank = JSON.parse(await readFile(new URL(`banks/${fixture}.delta.json`, ROOT), 'utf8'));
  const deltaDoc = JSON.parse(await readFile(new URL(`banks/${fixture}.delta-document.json`, ROOT), 'utf8'));
  const delta = deltaDoc.source;

  for (const modelId of options.models) {
    const descriptor = descriptorOf(modelId);
    const pass1 = JSON.parse(await readFile(new URL(`${options.records}/${slugOf(descriptor.id)}/${fixture}.r1.json`, ROOT), 'utf8'));
    if (!pass1.http.ok) {
      console.warn(`  skip  ${fixture} ${descriptor.id} — pass 1 was not successful`);
      continue;
    }
    const originalBank = pass1.bank;
    const snapshotText = renderSnapshotText(pass1.snapshot);
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

    const arms = {
      source_delta: { label: 'full source + amendment', input: { ...input, sources: [...input.sources, delta] } },
      snapshot_delta: { label: 'snapshot + amendment', input: { ...snapshotInput, sources: [...snapshotInput.sources, delta] } },
    };
    const banks = { original: originalBank, delta: deltaBank };

    runs.push({ fixture, descriptor, pass1, arms, banks, snapshotText });
    for (const [armKey, arm] of Object.entries(arms)) {
      for (const [bankKey, bank] of Object.entries(banks)) {
        planned.push({ fixture, descriptor, armKey, arm, bankKey, bank, state: buildState(arm.input), input: arm.input });
      }
    }
  }
}

const worstCase = planned.reduce((total, entry) => {
  const est = Math.ceil(entry.state.text.length / 4);
  const charges = entry.descriptor.vendor === 'ScaleDown' ? entry.bank.questions.length : 1;
  return total + (est * 2 * charges * entry.descriptor.pricing.input_per_mtok) / 1e6;
}, 0);

console.log(`rda propagation  ${options.fixtures.join(', ')}  × ${options.models.length} model(s)`);
for (const run of runs) console.log(`  ${run.fixture} · ${run.descriptor.id}: snapshot ${run.snapshotText.length} chars, ${run.pass1.snapshot.observations.length} card(s)`);
console.log(`  ${planned.length} call(s), worst case $${worstCase.toFixed(6)} (ceiling $${options.maxUsd})`);

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
for (const entry of planned) {
  const adapter = adapterFor(entry.descriptor);
  const validated = validateBank(entry.bank, { adapter, input: entry.input });
  if (!validated.ok) {
    console.error(`  ${entry.fixture} ${entry.descriptor.id} ${entry.armKey}/${entry.bankKey}: bank refused — ${validated.errors.join('; ')}`);
    continue;
  }
  const request = adapter.buildRequest({ state: entry.state, questions: entry.bank.questions });
  request.endpoint = entry.descriptor.endpoint ?? ENDPOINT;

  const startedAt = Date.now();
  const response = await send(
    {
      endpoint: request.endpoint,
      headers: {
        ...request.headers,
        authorization: `Bearer ${apiKey}`,
        'HTTP-Referer': 'https://github.com/Ai-Nspired/gca-experiment',
        'X-Title': 'gca rda propagation',
      },
      body: request.body,
    },
    fetch
  );
  const latencyMs = Date.now() - startedAt;
  const normalised = response.ok ? normaliseResponse({ adapter, body: response.body, bank: entry.bank, state: entry.state }) : null;
  results.push({
    fixture: entry.fixture,
    model: entry.descriptor.id,
    arm: entry.armKey,
    bank: entry.bankKey,
    state_chars: entry.state.text.length,
    http: { status: response.status, ok: response.ok },
    latency_ms: latencyMs,
    usage: normalised?.usage ?? null,
    answers: normalised?.answers ?? null,
    problems: normalised?.problems ?? [],
    response_body: response.ok ? undefined : response.body,
  });
  console.log(
    `  ${entry.fixture.padEnd(4)} ${entry.descriptor.id.padEnd(36)} ${entry.armKey.padEnd(15)} ${entry.bankKey.padEnd(9)} HTTP ${response.status} ${String(normalised?.usage?.input_tokens ?? '-').padStart(6)} tok $${normalised?.usage?.cost_usd ?? '-'}`
  );
}

// -------------------------------------------------------------- propagation

const analyses = [];
for (const run of runs) {
  const { fixture, descriptor, pass1, banks } = run;
  const threshold = banks.original.abstain_below ?? 0.5;
  const pick = (armKey, bankKey) => results.find((entry) => entry.fixture === fixture && entry.model === descriptor.id && entry.arm === armKey && entry.bank === bankKey && entry.http.ok);
  const sourceOriginal = pick('source_delta', 'original');
  const snapOriginal = pick('snapshot_delta', 'original');
  const sourceDelta = pick('source_delta', 'delta');
  const snapDelta = pick('snapshot_delta', 'delta');
  if (!sourceOriginal || !snapOriginal || !sourceDelta || !snapDelta) {
    analyses.push({ fixture, model: descriptor.id, skipped: 'a required arm failed' });
    continue;
  }

  const perQuestion = banks.original.questions.map((question) => {
    const pre = pass1.normalised.answers[question.name] ?? null;
    const source = sourceOriginal.answers[question.name] ?? null;
    const snap = snapOriginal.answers[question.name] ?? null;
    const preKey = answerKey(pre, threshold);
    const sourceKey = answerKey(source, threshold);
    const snapKey = answerKey(snap, threshold);
    const movedByAmendment = sourceKey !== preKey;
    let outcome;
    if (snapKey === sourceKey) outcome = movedByAmendment ? 'changed correctly' : 'preserved';
    else if (!movedByAmendment) outcome = 'silent loss';
    else if (snapKey === preKey) outcome = 'stale';
    else outcome = 'divergent';
    return {
      name: question.name,
      question: question.claim,
      pre: renderAnswer(pre),
      source_after: renderAnswer(source),
      snapshot_after: renderAnswer(snap),
      moved_by_amendment: movedByAmendment,
      outcome,
      pre_key: preKey,
      source_key: sourceKey,
      snapshot_key: snapKey,
    };
  });

  const perDelta = banks.delta.questions.map((question) => {
    const source = sourceDelta.answers[question.name] ?? null;
    const snap = snapDelta.answers[question.name] ?? null;
    return {
      name: question.name,
      source: renderAnswer(source),
      snapshot: renderAnswer(snap),
      match: answerKey(source, threshold) === answerKey(snap, threshold),
      source_key: answerKey(source, threshold),
      snapshot_key: answerKey(snap, threshold),
    };
  });

  const counts = perQuestion.reduce((tally, entry) => ({ ...tally, [entry.outcome]: (tally[entry.outcome] ?? 0) + 1 }), {});
  analyses.push({
    fixture,
    model: descriptor.id,
    cards: pass1.snapshot.observations.length,
    snapshot_chars: run.snapshotText.length,
    source_chars: run.arms.source_delta.input.sources.reduce((total, source) => total + (source.content?.text?.length ?? 0), 0),
    original_bank: {
      questions: perQuestion.length,
      preserved: counts.preserved ?? 0,
      changed_correctly: counts['changed correctly'] ?? 0,
      silent_loss: counts['silent loss'] ?? 0,
      stale: counts.stale ?? 0,
      divergent: counts.divergent ?? 0,
      per_question: perQuestion,
    },
    delta_bank: {
      questions: perDelta.length,
      agreement: perDelta.filter((entry) => entry.match).length,
      per_question: perDelta,
    },
    cost: {
      source_arm_usd: Number(((sourceOriginal.usage?.cost_usd ?? 0) + (sourceDelta.usage?.cost_usd ?? 0)).toFixed(8)),
      snapshot_arm_usd: Number(((snapOriginal.usage?.cost_usd ?? 0) + (snapDelta.usage?.cost_usd ?? 0)).toFixed(8)),
    },
    verdict:
      counts['silent loss'] || counts.stale
        ? `propagation loses ${counts['silent loss'] ?? 0} unaffected and ${counts.stale ?? 0} changed fact(s)`
        : 'propagation preserved every unaffected fact and applied every change',
  });
}

const summary = {
  schema: 'gca-rda-propagation/v1',
  generated_at: new Date().toISOString(),
  question: 'can RDA propagate a change without silently losing unaffected information or introducing unsupported conclusions?',
  design: {
    arms: ['full source + amendment (reference)', 'snapshot + amendment (propagation)'],
    banks: ['original bank (did facts survive?)', 'delta bank (did the change land?)'],
    reference: 'arm A, same engine: unaffected is defined by the engine with the full state, not by the harness',
    amendment: 'synthetic, declared in banks/<fixture>.delta-document.json',
  },
  analyses,
  results,
  limits: [
    'Two fixtures, small sources: this measures mechanism, not robustness across document types.',
    'The snapshot carries no citations, so the snapshot arm cannot show why a fact survived or did not.',
    'Amendments are synthetic; organic change may be harder (distributed, implicit, or spread across documents).',
  ],
};

await mkdir(new URL(`${options.out}/`, ROOT), { recursive: true });
await writeFile(new URL(`${options.out}/propagation.json`, ROOT), `${JSON.stringify(summary, null, 2)}\n`);

console.log('\npropagation');
for (const analysis of analyses) {
  if (analysis.skipped) {
    console.log(`  ${analysis.fixture} ${analysis.model}: skipped (${analysis.skipped})`);
    continue;
  }
  const bank = analysis.original_bank;
  console.log(
    `  ${analysis.fixture.padEnd(4)} ${analysis.model.padEnd(36)} preserved ${bank.preserved}/${bank.questions}  changed ${bank.changed_correctly}  silent-loss ${bank.silent_loss}  stale ${bank.stale}  divergent ${bank.divergent}  delta-agreement ${analysis.delta_bank.agreement}/${analysis.delta_bank.questions}`
  );
  for (const entry of bank.per_question.filter((question) => question.outcome !== 'preserved')) {
    console.log(`       ${entry.outcome.padEnd(18)} ${entry.name.padEnd(24)} pre ${entry.pre.padEnd(24)} source-after ${entry.source_after.padEnd(24)} snapshot-after ${entry.snapshot_after}`);
  }
  console.log(`       cost: source arm $${analysis.cost.source_arm_usd}  snapshot arm $${analysis.cost.snapshot_arm_usd}`);
}

console.log(`\nwrote ${options.out}/propagation.json`);
process.exit(results.every((result) => result.http.ok) ? 0 : 1);
