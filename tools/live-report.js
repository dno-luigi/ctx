/**
 * Aggregate the live decision runs into one record, with repetition stability.
 *
 * Costs come from `usage.cost`, which the endpoint reports itself, and are never
 * estimated from characters. Decision accuracy and conceptual completeness are kept
 * apart: answers are listed as answers, and the frozen grader is run only to show
 * what its evidence-based metrics can and cannot see on this path.
 *
 * Stability is reported on two levels, because they answer different questions:
 *
 *   - **same decision** — did every repetition select the same option, or land on the
 *     same side of the pre-registered abstain threshold? This is what a caller
 *     consumes.
 *   - **byte-identical** — did the normalised answer match exactly, including the
 *     probability? This is what a claim about determinism needs, and it is stricter.
 *
 * A single pass cannot separate a decision from a lucky sample, so `repetitions: 1`
 * is reported as `insufficient`, not as stability 1.0.
 *
 * Usage: node tools/live-report.js [--out runs/live]
 */

import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';

import { gradeFixture } from '../src/grade.js';

const ROOT = new URL('../', import.meta.url);

const options = { out: 'runs/live' };
for (let index = 0; index < process.argv.length; index += 1) {
  const [flag, inline] = String(process.argv[index]).split('=');
  if (flag === '--out') options.out = inline ?? process.argv[++index];
}

const dirs = (await readdir(new URL(`${options.out}/`, ROOT), { withFileTypes: true }))
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();

const runs = [];
for (const dir of dirs) {
  const files = (await readdir(new URL(`${options.out}/${dir}/`, ROOT))).filter((name) => name.endsWith('.json'));
  for (const file of files) {
    const record = JSON.parse(await readFile(new URL(`${options.out}/${dir}/${file}`, ROOT), 'utf8'));
    if (record.schema !== 'gca-live-decision-run/v1') continue;
    const match = file.match(/\.r(\d+)\.json$/);
    runs.push({ ...record, rep: match ? Number(match[1]) : record.repetition?.index ?? 1 });
  }
}

const thresholds = JSON.parse(await readFile(new URL('thresholds.json', ROOT), 'utf8'));

let inventoryRun = null;
try {
  inventoryRun = JSON.parse(await readFile(new URL('runs/inventory/inventory-run.json', ROOT), 'utf8'));
} catch {
  inventoryRun = null;
}

function renderAnswer(answer) {
  if (!answer) return 'missing';
  if (answer.type === 'noul') return `P(yes)=${answer.probability.toFixed(3)}`;
  if (answer.type === 'choice') return `${answer.choice} (${answer.confidence === null ? 'n/a' : Number(answer.confidence).toFixed(3)})`;
  if (answer.type === 'score') return `score=${answer.score} (${answer.confidence === null ? 'n/a' : Number(answer.confidence).toFixed(3)})`;
  return `${answer.spans?.length ?? 0} span(s)`;
}

/** The part of an answer a caller consumes. */
function decisionKey(answer, abstainBelow) {
  if (!answer) return 'missing';
  if (answer.type === 'noul') return `noul:${answer.probability >= abstainBelow ? 'yes' : 'no'}`;
  if (answer.type === 'choice') return `choice:${answer.choice}`;
  if (answer.type === 'score') return `score:${answer.score}`;
  return 'locate';
}

// ------------------------------------------------------------------- grouping

const configs = new Map();
for (const record of runs) {
  const key = `${record.fixture}|${record.model.id}`;
  if (!configs.has(key)) {
    configs.set(key, { fixture: record.fixture, model: record.model.id, pricing: record.model.pricing, records: [] });
  }
  configs.get(key).records.push(record);
}
for (const config of configs.values()) config.records.sort((a, b) => a.rep - b.rep);

const costRows = [];
const stabilityRows = [];
const gradingRows = [];
const failures = [];

for (const config of [...configs.values()].sort((a, b) => `${a.fixture}${a.model}`.localeCompare(`${b.fixture}${b.model}`))) {
  const ok = config.records.filter((record) => record.http.ok);
  const bad = config.records.filter((record) => !record.http.ok);
  for (const record of bad) {
    failures.push({ fixture: config.fixture, model: config.model, repetition: record.rep, http: record.http.status, body: JSON.stringify(record.response_body).slice(0, 300) });
  }
  if (ok.length === 0) continue;

  const costs = ok.map((record) => record.normalised.usage.cost_usd);
  const inputTokens = ok.map((record) => record.normalised.usage.input_tokens);
  const stateChars = ok[0].request.body.state?.text?.length ?? String(ok[0].request.body.state ?? '').length;
  const total = costs.reduce((sum, value) => sum + value, 0);

  costRows.push({
    fixture: config.fixture,
    model: config.model,
    repetitions: ok.length,
    state_chars: stateChars,
    state_tokens_est: Math.ceil(stateChars / 4),
    questions: Object.keys(ok[0].request.body.questions).length,
    input_tokens_per_call: inputTokens[0],
    input_tokens_identical: new Set(inputTokens).size === 1,
    cost_usd_total: Number(total.toFixed(8)),
    cost_usd_mean: Number((total / ok.length).toFixed(8)),
    cost_usd_min: Math.min(...costs),
    cost_usd_max: Math.max(...costs),
    effective_usd_per_mtok: inputTokens[0] ? Number(((total / ok.length / inputTokens[0]) * 1e6).toFixed(6)) : null,
    list_price_usd_per_mtok: config.pricing.input_per_mtok,
    question_multiplier: ok[0].normalised.question_multiplier,
    under_interactive_ceiling: Math.max(...costs) <= thresholds.interactive_cost_per_pass_max_usd,
    latency_ms: ok.map((record) => record.latency_ms),
  });

  // ---------------------------------------------------------------- stability

  const abstainBelow = ok[0].bank?.abstain_below ?? 0.5;
  const names = [...new Set(ok.flatMap((record) => Object.keys(record.normalised.answers)))];
  const perQuestion = names.map((name) => {
    const answers = ok.map((record) => record.normalised.answers[name] ?? null);
    const keys = new Set(answers.map((answer) => decisionKey(answer, abstainBelow)));
    const serialised = new Set(answers.map((answer) => JSON.stringify(answer)));
    const probabilities = answers.filter((answer) => answer?.type === 'noul').map((answer) => answer.probability);
    return {
      name,
      type: answers.find(Boolean)?.type ?? 'missing',
      values: answers.map((answer) => renderAnswer(answer)),
      distinct: keys.size,
      same_decision: keys.size === 1,
      byte_identical: serialised.size === 1,
      probability_min: probabilities.length ? Math.min(...probabilities) : null,
      probability_max: probabilities.length ? Math.max(...probabilities) : null,
      probability_range: probabilities.length ? Number((Math.max(...probabilities) - Math.min(...probabilities)).toFixed(6)) : null,
    };
  });
  const sameDecision = perQuestion.filter((question) => question.same_decision).length;
  const byteIdentical = perQuestion.filter((question) => question.byte_identical).length;

  stabilityRows.push({
    fixture: config.fixture,
    model: config.model,
    repetitions: ok.length,
    sufficient: ok.length > 1,
    questions: perQuestion.length,
    same_decision: sameDecision,
    same_decision_ratio: perQuestion.length ? Number((sameDecision / perQuestion.length).toFixed(3)) : null,
    byte_identical: byteIdentical,
    byte_identical_ratio: perQuestion.length ? Number((byteIdentical / perQuestion.length).toFixed(3)) : null,
    abstain_threshold: abstainBelow,
    per_question: perQuestion,
  });

  // ------------------------------------------------------------------ grading

  const groundTruth = JSON.parse(await readFile(new URL(`fixtures/${config.fixture}/ground_truth.json`, ROOT), 'utf8'));
  const input = JSON.parse(await readFile(new URL(`fixtures/${config.fixture}/input.json`, ROOT), 'utf8'));
  const grade = gradeFixture({
    fixture: config.fixture,
    groundTruth,
    input,
    snapshots: ok.map((record) => record.snapshot),
    invalidSnapshots: ok.filter((record) => !record.validation.ok).length,
    repetitions: ok.length,
  });

  gradingRows.push({
    fixture: config.fixture,
    model: config.model,
    repetitions: ok.length,
    citation_integrity: grade.citation_integrity,
    required_coverage_mean: grade.coverage.mean,
    missing_required: grade.coverage.missing,
    forbidden_hits: grade.forbidden_hits,
    abstention_pass_rate: grade.abstention.pass_rate,
    consistency: {
      jaccard_mean: grade.consistency.jaccard_mean,
      claim_stability: grade.consistency.claim_stability,
      unstable_claims: grade.consistency.unstable_claims,
    },
    cost_per_pass_usd: grade.cost.per_pass_usd,
    attributable_to_model: false,
    grade_note:
      'coverage and citation integrity are evidence-based and this path has no evidence: every engine rejects locate and box, so every card is `inferred` with no refs. These zeros are a capability gap, not a decision error.',
  });
}

// ------------------------------------------------------------------ aggregates

function aggregate(rows, modelKey = 'model') {
  const byModel = {};
  for (const row of rows) {
    const bucket = (byModel[row[modelKey]] ??= { model: row[modelKey], configs: 0, repetitions: 0 });
    bucket.configs += 1;
    bucket.repetitions += row.repetitions;
    for (const [field, value] of Object.entries(row)) {
      if (typeof value !== 'number') continue;
      if (['state_chars', 'state_tokens_est', 'questions', 'repetitions', 'configs', 'latency_ms'].includes(field)) continue;
      bucket[field] = bucket[field] === undefined ? [value] : [...bucket[field], value];
    }
  }
  for (const bucket of Object.values(byModel)) {
    for (const [field, value] of Object.entries(bucket)) {
      if (!Array.isArray(value)) continue;
      bucket[field] = { mean: Number((value.reduce((sum, x) => sum + x, 0) / value.length).toFixed(8)), min: Math.min(...value), max: Math.max(...value) };
    }
  }
  return Object.values(byModel);
}

const costByModel = aggregate(costRows);
const stabilityByModel = aggregate(stabilityRows);

const summary = {
  schema: 'gca-live-summary/v2',
  generated_at: new Date().toISOString(),
  cohort: 'decision models only; no chat model was called at any point',
  contract_verified_live: {
    endpoint: 'https://openrouter.ai/api/alpha/decisions',
    body: ['model', 'state', 'questions'],
    criteria_wire: { choice: 'record of option -> plain string (an array is HTTP 400)', score: 'array of plain strings', noul: 'absent, or {true,false} strings', box: 'rejected by every vendor tested' },
    question_discriminator: ['noul', 'choice', 'score', 'box'],
    text_evidence: 'unavailable: locate is not a discriminator value and box is refused by ScaleDown and Perplexity, so no engine can return a text span',
    usage: 'the endpoint reports usage.cost itself; it matched the catalogue product exactly on every run',
    state_form: { scaledown: 'object with text', perplexity: 'bare string' },
  },
  thresholds_in_force: {
    version: thresholds.version,
    interactive_cost_per_pass_max_usd: thresholds.interactive_cost_per_pass_max_usd,
    abstain_below: 0.5,
  },
  repetitions_policy: {
    unit: 'repetition = one separate call with an identical body; no caching, no retry on non-2xx',
    stability_definitions: {
      same_decision: 'every repetition chose the same option, or landed on the same side of abstain_below',
      byte_identical: 'every repetition produced an identical normalised answer, including the probability',
      insufficient: 'repetitions = 1; stability is reported as insufficient rather than 1.0',
    },
  },
  costs: costRows,
  cost_by_model: costByModel,
  stability: stabilityRows,
  stability_by_model: stabilityByModel,
  grading: gradingRows,
  http_failures: failures,
  inventory: inventoryRun
    ? {
        source: 'runs/inventory/inventory-run.json',
        fixtures: inventoryRun.fixtures_run,
        totals: inventoryRun.totals,
        by_kind: inventoryRun.by_kind,
        rule_share: inventoryRun.rule_share,
        precision: inventoryRun.precision,
      }
    : null,
  limits: [
    'Three fixtures and one question bank per fixture: this is a cost, contract and stability result, not a cohort comparison.',
    'Banks were authored from the task question and the sources, before the answer key was read; the answer-key comparison is post hoc.',
    'No evidence spans exist on this path, so nothing here measures conceptual completeness or citation integrity.',
    'Repetition variance at n>1 is a sample, not a distribution: it bounds nothing statistically and no confidence interval is claimed.',
    'The inventory is a reference instrument with unmeasured precision; its item counts are volume, not quality.',
  ],
};

await mkdir(new URL(`${options.out}/`, ROOT), { recursive: true });
await writeFile(new URL(`${options.out}/summary.json`, ROOT), `${JSON.stringify(summary, null, 2)}\n`);

// -------------------------------------------------------------------- console

console.log('cost per assessment (provider-reported, mean of repetitions)');
console.log('  fixture  model                                reps   in_tok   mean $/call   min          max          $/Mtok  ≤$0.002');
for (const row of costRows) {
  console.log(
    `  ${row.fixture.padEnd(7)}  ${row.model.padEnd(36)} ${String(row.repetitions).padStart(4)}  ${String(row.input_tokens_per_call).padStart(6)}   ${String(row.cost_usd_mean).padStart(11)}   ${String(row.cost_usd_min).padStart(10)}   ${String(row.cost_usd_max).padStart(10)}   ${String(row.effective_usd_per_mtok).padStart(5)}  ${String(row.under_interactive_ceiling).padStart(6)}`
  );
}

console.log('\nanswer stability');
console.log('  fixture  model                                reps  same-decision  byte-identical');
for (const row of stabilityRows) {
  const note = row.sufficient ? '' : '  (insufficient: 1 rep)';
  console.log(
    `  ${row.fixture.padEnd(7)}  ${row.model.padEnd(36)} ${String(row.repetitions).padStart(4)}  ${`${row.same_decision}/${row.questions}`.padStart(13)}  ${`${row.byte_identical}/${row.questions}`.padStart(14)}${note}`
  );
}

console.log('\nunstable questions');
const unstable = stabilityRows.flatMap((row) => row.per_question.filter((question) => !question.same_decision).map((question) => ({ row, question })));
if (unstable.length === 0) {
  console.log('  none — every question produced the same decision in every repetition');
} else {
  for (const { row, question } of unstable) {
    console.log(`  ${row.fixture} · ${row.model} · ${question.name}: ${question.values.join(' | ')}`);
  }
}

console.log('\nprobability drift on stable decisions (noul questions)');
for (const row of stabilityRows) {
  for (const question of row.per_question.filter((entry) => entry.type === 'noul' && entry.probability_range !== null)) {
    if (question.probability_range > 0) {
      console.log(`  ${row.fixture} · ${row.model.split('/')[1]} · ${question.name}: ${question.probability_min} … ${question.probability_max} (range ${question.probability_range})`);
    }
  }
}

console.log('\nrepetition-aware frozen consistency (not attributable)');
for (const row of gradingRows) {
  console.log(
    `  ${row.fixture.padEnd(4)} ${row.model.padEnd(36)} jaccard ${row.consistency.jaccard_mean}  claim_stability ${row.consistency.claim_stability}  unstable ${row.consistency.unstable_claims.length}  coverage ${row.required_coverage_mean}`
  );
}

if (failures.length) {
  console.log('\nhttp failures');
  for (const failure of failures) console.log(`  ${failure.fixture} ${failure.model} rep ${failure.repetition} HTTP ${failure.http} — ${failure.body}`);
}

console.log(`\nwrote ${options.out}/summary.json`);
