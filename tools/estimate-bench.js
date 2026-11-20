#!/usr/bin/env node
/**
 * DECISIONS-BENCH-02 pre-flight estimator.
 *
 * Read-only with respect to every existing artifact: it acquires the fixture, reads the stored
 * snapshot and pack, and writes one new estimate file under runs/decisions-bench-02/estimates/.
 * It makes no network call, holds no key, and spends nothing.
 *
 * What it does NOT do: it does not measure accuracy, and it does not know the bank. Question counts
 * are *declared* in PLAN below; when the banks exist the estimator must be re-run so the number is
 * generated from real question counts rather than from an assumption. Every declared input is listed
 * in `declared_not_measured` in the output, so an estimate can never be mistaken for a measurement.
 *
 * Estimate vs actual is a hard boundary:
 *   - this file produces `preflight_estimate` figures only;
 *   - actual charges are provider-reported rows in the run's spend ledger;
 *   - the output carries `actual_usd: null` and a ledger path, and nothing in this file ever fills it.
 *
 * Billing rules modelled (documented 2026-11-20):
 *   Perplexity  state billed once per group; groups split only when state + question exceeds 256K.
 *               $0.02/M input (v1.3) and $0.01/M (flash v1.3), output free.
 *   ScaleDown   one internal call per question, usage summed; $0.04/M input, output free.
 *               No `locate`, so it is asked fewer questions and is charged for fewer.
 *
 * Usage:
 *   node tools/estimate-bench.js
 *   node tools/estimate-bench.js --compare-to 1.03
 *   node tools/estimate-bench.js --json
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { acquire } from '../context-engine/src/source.js';
import { buildState } from '../adapters/decision/interface.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..');

// ------------------------------------------------------------------ declared plan
// Everything here is an assumption until the banks and the ladder corpus exist. It is printed with
// every estimate and repeated in `declared_not_measured`.
const PLAN = {
  series: 'DECISIONS-BENCH-02',
  divisor: 3.5, // calibrated pessimistic chars/token (measured 3.47 scan, 3.82 QA)
  tasks: 12,
  repeats: 5,
  conditions: ['A', 'B1', 'B2', 'C'],
  models: [
    { id: 'pplx-decider-v1.3', vendor: 'perplexity', price_in_per_mtok: 0.02, asks_locate: true },
    { id: 'pplx-decider-flash-v1.3', vendor: 'perplexity', price_in_per_mtok: 0.01, asks_locate: true },
    { id: 'scaledown/classify-1', vendor: 'scaledown', price_in_per_mtok: 0.04, asks_locate: false },
  ],
  bank: {
    core_questions: 4, // choice/noul/score: answerable by every model (evidence instrument I2)
    locate_questions: 2, // Perplexity v1.3 only (instrument I1)
  },
  perplexity: { input_ceiling_tokens: 262144, question_overhead_tokens: 120 },
  escalation: { rate: 0.2, input_tokens: 1500, output_tokens: 300, price_in_per_mtok: 0.0399, price_out_per_mtok: 0.0784 },
  execution: {
    tasks: 8,
    arms: 6, // none, pack, snapshot, decision-routed E1, decision-select E2, generative-only
    repeats: 3,
    turns: 8,
    input_tokens_per_turn: 7000,
    output_tokens_per_turn: 400,
    price_in_per_mtok: 0.0399,
    price_out_per_mtok: 0.0784,
  },
  ladder: {
    targets: [8000, 32000, 128000, 250000],
    repeats: 5,
    models: ['pplx-decider-v1.3', 'pplx-decider-flash-v1.3', 'scaledown/classify-1'],
  },
  calibration: { items_per_stratum: 45, strata: 10, tokens_per_item: 1200 }, // 5 families x 2 difficulty
  stage0_usd: 0.02,
  exposure: {
    token_divisor: 3.47, // measured lower bound; more tokens than 3.5
    questions_multiplier: 1.33, // a bank with 8 core questions instead of 6 asked
    charge_uplift: 2.0, // live GLM charges ran 1.7–2x the catalogue product; applied to all catalogue lines
    perplexity_groups_worst_case: true, // every question in its own group
    escalation_rate: 0.35,
    execution_turns: 12,
  },
  declared_not_measured: [
    'question counts per task (bank does not exist yet)',
    'ladder corpus sizes (targets, not built; assume the corpus hits each target within +-5%)',
    'accuracy, and therefore cost per verified correct decision',
    'escalation rate (20% assumed; measured only in the hybrid stage)',
    'executor turn count and per-turn tokens (8 turns x 7k assumed)',
    'whether Perplexity or ScaleDown report charges above their published rates',
  ],
};

// ------------------------------------------------------------------ helpers

const sha256 = (text) => `sha256:${createHash('sha256').update(text).digest('hex')}`;
const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));
const tokensOf = (chars, divisor = PLAN.divisor) => Math.ceil(chars / divisor);
const usd = (value) => Number(value.toFixed(6));

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const value = (name) => {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? Number(args[index + 1]) : null;
};

// ------------------------------------------------------------------ condition states

const fixtureRoot = path.join(ROOT, 'context-engine/fixtures/poc-repo');
const runDir = path.join(ROOT, 'context-engine/examples/live-approved');
const snapshotPath = path.join(runDir, 'snapshot-poc-repo.json');
const packPath = path.join(runDir, 'pack-medium-contradictions.md');

for (const [label, file] of [['snapshot', snapshotPath], ['pack', packPath]]) {
  if (!existsSync(file)) {
    console.error(`missing ${label}: ${path.relative(ROOT, file)}`);
    process.exit(2);
  }
}

const snapshot = readJson(snapshotPath);
const packText = readFileSync(packPath, 'utf8');
const acquisition = await acquire({ root: fixtureRoot, rootLabel: 'poc-repo' });

if (acquisition.digest !== snapshot.subject.source_digest) {
  console.error('refusing to estimate: the fixture no longer matches the snapshot subject digest');
  console.error(`  fixture now: ${acquisition.digest}`);
  console.error(`  snapshot:    ${snapshot.subject.source_digest}`);
  process.exit(2);
}

const sourceState = buildState({
  sources: acquisition.sources.map((source) => ({
    id: source.source_id,
    kind: source.kind,
    label: source.source_id,
    content: { text: source.text },
  })),
});

/** Snapshot → marker-bounded sources. `withEvidence` is the B1/B2 split. */
function snapshotState({ withEvidence }) {
  const parts = [];
  for (const [section, items] of Object.entries(snapshot.sections ?? {})) {
    if (!Array.isArray(items)) continue;
    for (const item of items) {
      const evidence = withEvidence
        ? (item.evidence ?? [])
            .map((ref) => `${ref.source_id}${ref.line ? `:${ref.line}` : ''} "${ref.quote ?? ''}"`)
            .join('\n')
        : '';
      parts.push({
        id: section,
        kind: 'section',
        label: section,
        content: { text: String(item.text ?? '') + (evidence ? `\nEVIDENCE\n${evidence}` : '') },
      });
    }
  }
  parts.push({ id: 'architecture', kind: 'section', label: 'architecture', content: { text: JSON.stringify(snapshot.architecture ?? {}) } });
  for (const contradiction of snapshot.contradictions ?? []) {
    const evidence = (contradiction.evidence ?? []).map((ref) => `${ref.source_id}: ${ref.quote}`).join('\n');
    parts.push({
      id: 'contradictions',
      kind: 'section',
      label: 'contradiction',
      content: { text: `${contradiction.text}\n${evidence}` },
    });
  }
  return buildState({ sources: parts });
}

const states = {
  A: { label: 'full source', text: sourceState.text, note: 'all sources, marker-flattened' },
  B1: { label: 'snapshot, sections only', text: snapshotState({ withEvidence: false }).text, note: 'structure without quoted evidence' },
  B2: { label: 'snapshot + evidence', text: snapshotState({ withEvidence: true }).text, note: 'structure with quotes' },
  C: { label: 'context pack', text: buildState({ sources: [{ id: 'pack', kind: 'pack', label: 'pack', content: { text: packText } }] }).text, note: 'rendered medium pack' },
};

for (const state of Object.values(states)) {
  state.chars = state.text.length;
  state.tokens = tokensOf(state.chars);
}

// ------------------------------------------------------------------ billing

function perplexityCost({ stateTokens, questions, price, worstCase = false }) {
  const { input_ceiling_tokens: ceiling, question_overhead_tokens: overhead } = PLAN.perplexity;
  if (stateTokens >= ceiling) return { ok: false, reason: `state ${stateTokens} >= ceiling ${ceiling}` };
  const capacity = Math.max(1, Math.floor((ceiling - stateTokens) / overhead));
  const groups = worstCase ? questions : Math.max(1, Math.ceil(questions / capacity));
  return { ok: true, groups, cost: (groups * stateTokens * price) / 1e6 };
}

function scaledownCost({ stateTokens, questions, price, worstCase = false }) {
  // One internal call per question either way; `worstCase` changes nothing here, and saying so
  // explicitly is better than a silent identity.
  return { ok: true, questions, cost: (questions * stateTokens * price) / 1e6 };
}

function requestCost(model, stateTokens, { worstCase = false } = {}) {
  // ScaleDown is asked only the core questions: it cannot serve `locate`. That is a capability
  // difference, and it is reflected in its price rather than hidden.
  const questions = PLAN.bank.core_questions + (model.asks_locate ? PLAN.bank.locate_questions : 0);
  const scaled = worstCase ? Math.ceil(questions * PLAN.exposure.questions_multiplier) : questions;
  if (model.vendor === 'perplexity') {
    return { questions: scaled, ...perplexityCost({ stateTokens, questions: scaled, price: model.price_in_per_mtok, worstCase: worstCase && PLAN.exposure.perplexity_groups_worst_case }) };
  }
  return { questions: scaled, ...scaledownCost({ stateTokens, questions: scaled, price: model.price_in_per_mtok }) };
}

// ------------------------------------------------------------------ stages

const modelById = Object.fromEntries(PLAN.models.map((model) => [model.id, model]));

function matrixStage({ worstCase = false, divisor } = {}) {
  const perCondition = [];
  let total = 0;
  for (const key of PLAN.conditions) {
    const state = states[key];
    const stateTokens = divisor ? tokensOf(state.chars, divisor) : state.tokens;
    const rows = PLAN.models.map((model) => {
      const request = requestCost(model, stateTokens, { worstCase });
      const cells = PLAN.tasks * PLAN.repeats;
      return { model: model.id, questions: request.questions, groups: request.groups ?? null, per_request_usd: usd(request.cost), condition_usd: usd(request.cost * cells) };
    });
    const conditionTotal = rows.reduce((sum, row) => sum + row.condition_usd, 0);
    total += conditionTotal;
    perCondition.push({ condition: key, state_tokens: stateTokens, rows, condition_usd: usd(conditionTotal) });
  }
  return { perCondition, total_usd: usd(total) };
}

function ladderStage({ worstCase = false, divisor } = {}) {
  const models = PLAN.ladder.models.map((id) => modelById[id]);
  const rungs = PLAN.ladder.targets.map((target) => {
    const stateTokens = divisor ? tokensOf(target * PLAN.divisor, divisor) : target;
    const rows = models.map((model) => {
      const request = requestCost(model, stateTokens, { worstCase });
      const requests = PLAN.ladder.repeats;
      return { model: model.id, groups: request.groups ?? null, per_request_usd: usd(request.cost), rung_usd: usd(request.cost * requests) };
    });
    return { target_tokens: target, state_tokens: stateTokens, rows, rung_usd: usd(rows.reduce((sum, row) => sum + row.rung_usd, 0)) };
  });
  return { rungs, total_usd: usd(rungs.reduce((sum, rung) => sum + rung.rung_usd, 0)) };
}

function calibrationStage({ worstCase = false, divisor } = {}) {
  const items = PLAN.calibration.items_per_stratum * PLAN.calibration.strata;
  const tokenFactor = divisor ? PLAN.divisor / divisor : 1;
  const perItem = PLAN.calibration.tokens_per_item * tokenFactor;
  const rows = PLAN.models.map((model) => {
    const cost = (items * perItem * model.price_in_per_mtok) / 1e6;
    return { model: model.id, items, per_item_tokens: Math.ceil(perItem), usd: usd(cost) };
  });
  return { items, rows, total_usd: usd(rows.reduce((sum, row) => sum + row.usd, 0)) };
}

function escalationStage({ worstCase = false } = {}) {
  // A decision can escalate per model, so the cell count includes the model dimension. Counting only
  // task x repeat x condition understates the stage by a factor of the cohort size.
  const cells = PLAN.tasks * PLAN.repeats * PLAN.conditions.length * PLAN.models.length;
  const rate = worstCase ? PLAN.exposure.escalation_rate : PLAN.escalation.rate;
  const calls = Math.ceil(cells * rate);
  const cost = (calls * (PLAN.escalation.input_tokens * PLAN.escalation.price_in_per_mtok + PLAN.escalation.output_tokens * PLAN.escalation.price_out_per_mtok)) / 1e6;
  return { cells, rate, calls, total_usd: usd(cost) };
}

function executionStage({ worstCase = false } = {}) {
  const turns = worstCase ? PLAN.exposure.execution_turns : PLAN.execution.turns;
  const runs = PLAN.execution.tasks * PLAN.execution.arms * PLAN.execution.repeats;
  const perRun =
    (turns * PLAN.execution.input_tokens_per_turn * PLAN.execution.price_in_per_mtok +
      turns * PLAN.execution.output_tokens_per_turn * PLAN.execution.price_out_per_mtok) /
    1e6;
  return { runs, turns, per_run_usd: usd(perRun), total_usd: usd(perRun * runs) };
}

function scenario({ worstCase = false } = {}) {
  const divisor = worstCase ? PLAN.exposure.token_divisor : PLAN.divisor;
  const matrix = matrixStage({ worstCase, divisor });
  const ladder = ladderStage({ worstCase, divisor });
  const calibration = calibrationStage({ worstCase, divisor });
  const escalation = escalationStage({ worstCase });
  const execution = executionStage({ worstCase });
  const stages = [
    { stage: '0 probes', usd: PLAN.stage0_usd },
    { stage: '1 decision matrix', usd: matrix.total_usd },
    { stage: '2 calibration', usd: calibration.total_usd },
    { stage: '3 scale ladder', usd: ladder.total_usd },
    { stage: '4 escalation', usd: escalation.total_usd },
    { stage: 'E execution sub-study', usd: execution.total_usd },
  ];
  const subtotal = stages.reduce((sum, entry) => sum + entry.usd, 0);
  const uplift = worstCase ? PLAN.exposure.charge_uplift : 1;
  const total = subtotal * uplift;
  return { divisor, matrix, ladder, calibration, escalation, execution, stages, subtotal_usd: usd(subtotal), charge_uplift: uplift, total_usd: usd(total) };
}

const nominal = scenario({});
const exposure = scenario({ worstCase: true });

// ------------------------------------------------------------------ output

const result = {
  schema: 'context-engine/bench-estimate/v1',
  series: PLAN.series,
  at: new Date().toISOString(),
  kind: 'preflight_estimate',
  cost_source: 'preflight_estimate',
  actual_usd: null,
  reconciliation: {
    note: 'This file is an estimate. Actual charges are recorded at run time by the spend guard in the ledger; nothing here may be substituted for them, and no actual figure may overwrite an estimate.',
    ledger_path: 'runs/decisions-bench-02/spend-ledger.jsonl',
  },
  inputs: {
    fixture_root: path.relative(ROOT, fixtureRoot),
    acquisition_digest: acquisition.digest,
    snapshot_id: snapshot.snapshot_id,
    snapshot_sha256: sha256(JSON.stringify(snapshot)),
    pack_sha256: sha256(packText),
    files: acquisition.totals.files,
    bytes: acquisition.totals.bytes,
  },
  plan: PLAN,
  states: Object.fromEntries(
    Object.entries(states).map(([key, state]) => [key, { label: state.label, note: state.note, chars: state.chars, tokens: state.tokens }])
  ),
  nominal,
  maximum_exposure: exposure,
  declared_not_measured: PLAN.declared_not_measured,
};

const outDir = path.join(ROOT, 'runs/decisions-bench-02/estimates');
mkdirSync(outDir, { recursive: true });
const stamp = result.at.replace(/[:.]/g, '-');
const outFile = path.join(outDir, `preflight-${stamp}.json`);
writeFileSync(outFile, JSON.stringify(result, null, 2));

if (flag('--json')) {
  console.log(JSON.stringify(result, null, 2));
} else {
  console.log(`DECISIONS-BENCH-02 preflight estimate · ${PLAN.series}`);
  console.log(`  inputs: ${acquisition.totals.files} files · ${acquisition.totals.bytes} bytes · snapshot ${snapshot.snapshot_id}`);
  console.log(`  estimator: ceil(chars / ${PLAN.divisor}) · declared question counts, not a bank\n`);

  console.log('STATES');
  for (const [key, state] of Object.entries(states)) {
    console.log(`  ${key.padEnd(3)} ${state.label.padEnd(24)} ${String(state.chars).padStart(7)} chars ${String(state.tokens).padStart(7)} tokens`);
  }

  console.log('\nPER REQUEST (nominal)');
  for (const entry of nominal.matrix.perCondition) {
    const cells = entry.rows
      .map((row) => `${row.model.split('/').pop()}=$${row.per_request_usd.toFixed(6)}${row.groups ? ` (${row.groups}g)` : ''} q${row.questions}`)
      .join(' · ');
    console.log(`  ${entry.condition.padEnd(3)} ${cells}`);
  }

  console.log('\nSTAGES (nominal)');
  for (const entry of nominal.stages) console.log(`  ${entry.stage.padEnd(24)} $${entry.usd.toFixed(4)}`);
  console.log(`  ${'TOTAL'.padEnd(24)} $${nominal.total_usd.toFixed(4)}`);

  console.log('\nMAXIMUM EXPOSURE (all pessimistic drivers applied together)');
  for (const entry of exposure.stages) console.log(`  ${entry.stage.padEnd(24)} $${entry.usd.toFixed(4)}`);
  console.log(`  ${'SUBTOTAL'.padEnd(24)} $${exposure.subtotal_usd.toFixed(4)}`);
  console.log(`  ${'x charge uplift'.padEnd(24)} x${exposure.charge_uplift}`);
  console.log(`  ${'TOTAL'.padEnd(24)} $${exposure.total_usd.toFixed(4)}`);
  console.log(`  drivers: divisor ${PLAN.exposure.token_divisor} · questions x${PLAN.exposure.questions_multiplier} · groups worst case · escalation ${PLAN.exposure.escalation_rate} · turns ${PLAN.exposure.execution_turns} · charges x${PLAN.exposure.charge_uplift}`);

  const baseline = value('--compare-to');
  if (baseline !== null) {
    const delta = nominal.total_usd - baseline;
    console.log(`\nCOMPARISON to the reviewed $${baseline.toFixed(2)} estimate`);
    console.log(`  nominal $${nominal.total_usd.toFixed(4)} vs $${baseline.toFixed(2)} → ${delta >= 0 ? '+' : ''}$${delta.toFixed(4)} (${((delta / baseline) * 100).toFixed(1)}%)`);
    console.log(`  maximum exposure $${exposure.total_usd.toFixed(4)} vs $${baseline.toFixed(2)} → ${((exposure.total_usd / baseline) * 100 - 100).toFixed(0)}% above`);
  }

  console.log(`\nwrote ${path.relative(ROOT, outFile)}`);
}
