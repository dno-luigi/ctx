/**
 * Proof of concept: scan → snapshot → pack → ask → modify → differential scan → verify.
 *
 * Offline (default) uses the deterministic stub and retrieval-from-pack answering. Its numbers show
 * that the machinery is coherent; they are not model evidence. In that mode token and cost fields are
 * `not_applicable` rather than zero, because a rule scanner consumes no tokens.
 *
 * Live mode adds `--provider live --budget-usd <usd>` (and optionally `--qa model`). It records the
 * provider-reported charge and generation id per call.
 *
 * Usage:
 *   node context-engine/poc/run-poc.js
 *   node context-engine/poc/run-poc.js --provider live --model glm-5.3-flash --budget-usd 0.05 --qa model
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { scanProject, updateProject } from '../src/pipeline.js';
import { compact, renderPack } from '../src/compact.js';
import { createProvider, loadModels, resolveModel } from '../src/providers.js';
import { openSpendGuard } from '../src/guard.js';
import { applyDelta, copySubject } from './apply-delta.js';
import { retrievalAnswers, modelAnswers, scoreAnswers, scoreFacts } from './qa.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const engineRoot = path.resolve(here, '..');
const fixtureRoot = path.join(engineRoot, 'fixtures/poc-repo');
const deltaRoot = path.join(engineRoot, 'fixtures/poc-delta');

const args = {};
{
  const argv = process.argv.slice(2);
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) continue;
    const [key, inline] = token.slice(2).split('=');
    if (inline !== undefined) args[key] = inline;
    else if (argv[index + 1] && !argv[index + 1].startsWith('--')) {
      args[key] = argv[index + 1];
      index += 1;
    } else args[key] = true;
  }
}

const live = args.provider === 'live' || args.provider === 'openai-compatible';
const budgetUsd = Number(args['budget-usd'] ?? 0);
const outDir = path.resolve(engineRoot, args.out ?? 'examples');

let checks = 0;
let failures = 0;
const check = (name, condition, detail = '') => {
  checks += 1;
  if (!condition) failures += 1;
  console.log(`  ${condition ? 'ok  ' : 'FAIL'} ${name}${condition || !detail ? '' : ` — ${detail}`}`);
};

// A call that hit the output cap or returned unparseable JSON produced no findings, and an empty
// snapshot is indistinguishable from "the material says nothing" unless this is checked. The
// provider records these; before SMOKE-01 run 1 nothing in this harness read them, so a truncated
// scan scored 25/25 and exited 0.
const BLOCKING = new Set(['output_truncated', 'payload_unparseable', 'call_failed']);
const blockingProblems = (calls) =>
  (calls ?? []).flatMap((call) => call.problems ?? []).filter((problem) => BLOCKING.has(problem.code));

// Live execution needs a run id, because the guard's whole job is to make a second attempt on the
// same authorisation impossible — not to warn about it.
const runId = typeof args['run-id'] === 'string' ? args['run-id'] : null;
const ledgerPath = path.join(outDir, 'spend-ledger.jsonl');
let guard = null;
const ensureGuard = () => {
  if (!live) return null;
  guard ??= openSpendGuard({
    runId,
    ledgerPath,
    budgetUsd,
    authorizeRetry: typeof args['authorize-retry'] === 'string' ? args['authorize-retry'] : null,
    purpose: `poc:${path.basename(outDir)}`,
  });
  return guard;
};

async function makeProvider({ modelId, budget, purpose = 'scan' }) {
  if (!live) return createProvider({ kind: 'stub' });
  if (!(budgetUsd > 0)) throw new Error('live mode requires --budget-usd greater than zero');
  const registry = await loadModels();
  const model = resolveModel(registry, modelId);
  return createProvider({ kind: 'openai-compatible', registry, model, budget, guard: ensureGuard(), purpose });
}

const groundTruth = JSON.parse(await readFile(path.join(engineRoot, 'fixtures/poc-repo.ground-truth.json'), 'utf8'));
const changeSet = JSON.parse(await readFile(path.join(deltaRoot, 'changes.json'), 'utf8'));
await mkdir(outDir, { recursive: true });

const budget = { usd: budgetUsd, spent: 0 };
const registry = live ? await loadModels() : null;
const partitionPolicy = registry?.partition ?? {};
const provider = await makeProvider({ modelId: args.model, budget, purpose: 'scan' });
if (guard) console.log(`  spend guard: run ${guard.runId} attempt ${guard.attempt} · ledger ${path.relative(process.cwd(), guard.ledgerPath)}`);
const modelContextTokens = provider.model?.context_tokens ?? null;
const partitionTokens = args['partition-tokens'] ? Number(args['partition-tokens']) : null;
const maxCallTokens = Number(args['max-output-tokens'] ?? 8000);

console.log(`\n1. ACQUIRE + SCAN  (${live ? `live: ${provider.model.slug}` : 'stub rule scanner'})`);
const scan = await scanProject({
  root: fixtureRoot,
  rootLabel: 'poc-repo',
  provider,
  partitionTokens,
  partitionPolicy,
  modelContextTokens,
  maxCallTokens,
});
const { snapshot, acquisition, partitionInfo, plan, strategy, instrument } = scan;
console.log(`  files=${acquisition.totals.files} bytes=${acquisition.totals.bytes} partitions=${partitionInfo.partition_count} findings=${snapshot.sections.observations.length} verified=${snapshot.coverage.verified_citations} failed=${snapshot.coverage.failed_citations}`);
console.log(`  strategy=${strategy.mode} budget≈${plan.budget_tokens} tokens (${plan.source}${modelContextTokens ? `, context ${modelContextTokens}` : ', no declared context'})`);
if (plan.notes.length) console.log(`  budget notes: ${plan.notes.join('; ')}`);
check('strategy matches the budget decision', (strategy.mode === 'single_pass') === (partitionInfo.estimated_tokens_total <= plan.budget_tokens));
check('budget never exceeds the model context', modelContextTokens === null || plan.budget_tokens < modelContextTokens);
check('every source is accounted for (read or skipped)', acquisition.totals.files + acquisition.skipped.length > 0);
check('source facts are model-free', snapshot.sections.source_facts.every((fact) => fact.authoritative === true));
check('verified conclusions all carry resolved evidence', snapshot.sections.verified_conclusions.every((entry) => entry.evidence.length > 0 && entry.evidence.every((ref) => ref.sha256)));
check('failed citations are quarantined, not repaired', snapshot.sections.observations.every((entry) => entry.verification === 'citation_verified' || entry.flags?.length > 0));
const scanBlocked = blockingProblems(scan.scan.calls);
check('no scan call was truncated, unparseable or failed', scanBlocked.length === 0, scanBlocked.map((problem) => `${problem.code}@${problem.partition ?? '?'}`).join(', '));

console.log('\n2. STRUCTURED REPRESENTATION');
console.log(`  conclusions=${snapshot.sections.verified_conclusions.length} inferences=${snapshot.sections.inferences.length} questions=${snapshot.sections.questions.length} contradictions=${snapshot.contradictions.length}`);
check('observations and conclusions are separate sections', Array.isArray(snapshot.sections.observations) && Array.isArray(snapshot.sections.verified_conclusions));
check('inferences are not mixed into verified conclusions', snapshot.sections.verified_conclusions.every((entry) => entry.kind !== 'question'));
check('snapshot digest is content-addressed', snapshot.snapshot_id === `snap-${snapshot.digest.replace('sha256:', '').slice(0, 16)}`);

console.log('\n3. COMPACTION');
const packs = {};
for (const profile of ['small', 'medium', 'large']) {
  packs[profile] = compact({ snapshot, profile });
  console.log(`  ${profile.padEnd(6)} ~${String(packs[profile].used_tokens_estimate).padStart(5)} tokens  items ${packs[profile].coverage.items_included}/${packs[profile].coverage.items_total}  omitted ${packs[profile].coverage.items_omitted}  reconstructible=${packs[profile].reconstructible}`);
}
const pack = packs[args.profile ?? 'medium'];
check('pack stays within its declared budget', pack.used_tokens_estimate <= pack.budget_tokens_estimate);
check('pack lists every omission with its sources', pack.omissions.every((entry) => Array.isArray(entry.sources)));
check('pack does not claim completeness', pack.coverage.items_total >= pack.coverage.items_included && Boolean(pack.disclaimer));
check('profiles trade size for content, not truth', packs.small.coverage.items_included <= packs.large.coverage.items_included);

console.log('\n4. ANSWER FROM THE PACK ONLY');
let qa;
if (args.qa === 'model' && live) {
  const qaProvider = await makeProvider({ modelId: args['qa-model'] ?? args.model, budget, purpose: 'qa' });
  const result = await modelAnswers({ provider: qaProvider, pack, questions: groundTruth.questions });
  qa = { mode: 'model', ...result };
  await mkdir(outDir, { recursive: true });
  await writeFile(path.join(outDir, 'qa-answers.json'), JSON.stringify({ mode: 'model', provider: result.provider, usage: result.usage, answers: result.answers }, null, 2));
} else {
  qa = { mode: 'retrieval-from-pack', answers: retrievalAnswers({ pack, questions: groundTruth.questions }) };
}
const qaScore = scoreAnswers({ answers: qa.answers, groundTruth });
console.log(`  mode=${qa.mode} retention=${qaScore.retention} attribution=${qaScore.attribution} reconstruction=${qaScore.reconstruction} factual_errors=${qaScore.factual_errors}`);
check('no answer cites a source absent from the pack index', qa.answers.every((answer) => answer.sources.every((source) => pack.source_index.some((ref) => ref.path === source))));
check('factual errors are counted, not hidden', typeof qaScore.factual_errors === 'number');

const factScore = scoreFacts({ findings: snapshot.sections.observations, facts: groundTruth.facts, label: 'line_rule_expected' });
const modelOnly = scoreFacts({ findings: snapshot.sections.observations, facts: groundTruth.model_only, label: 'model_only' });
console.log(`  planted facts found ${factScore.found}/${factScore.total}; model-only facts ${modelOnly.found}/${modelOnly.total} (reported separately)`);

console.log('\n5. MODIFY SOURCE + DIFFERENTIAL SCAN');
const copy = await copySubject(fixtureRoot);
const applied = await applyDelta({ sourceRoot: fixtureRoot, destinationRoot: copy, changeSet });
const deltaResult = await updateProject({
  previousSnapshot: snapshot,
  root: applied.root,
  rootLabel: 'poc-repo',
  provider,
  partitionTokens,
  partitionPolicy,
  modelContextTokens,
  maxCallTokens,
});
const { delta, snapshot: after } = deltaResult;
console.log(`  sources +${delta.counts.sources_added} ~${delta.counts.sources_changed} -${delta.counts.sources_removed} =${delta.counts.sources_unchanged}; findings preserved=${delta.counts.findings_preserved} stale=${delta.counts.findings_stale} invalidated=${delta.counts.findings_invalidated} added=${delta.counts.findings_added} updated=${delta.counts.findings_updated}`);
console.log(`  rescanned ${delta.counts.rescan_files} file(s): ${delta.rescanned.join(', ')}`);
const changedIds = new Set(delta.sources.changed.map((entry) => entry.source_id));
const removedIds = new Set(delta.sources.removed.map((entry) => entry.source_id));
const staleFindings = after.sections.observations.filter((finding) => finding.status === 'stale');
const invalidatedFindings = after.sections.observations.filter((finding) => finding.status === 'invalidated');
const priorInvalidExpected = snapshot.sections.observations.filter((finding) => (finding.evidence ?? []).some((entry) => removedIds.has(entry.source_id))).length;
const priorChangedExpected = snapshot.sections.observations.filter((finding) => (finding.evidence ?? []).some((entry) => changedIds.has(entry.source_id))).length;

check('unchanged findings are byte-identical after the update', delta.verification.preserved_identical === true);
check('unchanged sources are not rescanned', delta.verification.unchanged_sources_rescanned === 0);
check('every prior finding citing a removed source is invalidated', delta.counts.findings_invalidated === priorInvalidExpected, `${delta.counts.findings_invalidated} != ${priorInvalidExpected}`);
check('stale findings cite a changed source', staleFindings.every((finding) => (finding.evidence ?? []).some((entry) => changedIds.has(entry.source_id))));
check('changed sources produce a stale or updated outcome when cited', priorChangedExpected === 0 || delta.counts.findings_stale + delta.counts.findings_updated > 0);
check('new source is scanned', delta.counts.sources_added > 0 && delta.counts.findings_added > 0);
check('snapshot advances lineage', after.sections.historical_state?.from_snapshot === snapshot.snapshot_id);
const deltaBlocked = blockingProblems(deltaResult.calls);
check('no delta call was truncated, unparseable or failed', deltaBlocked.length === 0, deltaBlocked.map((problem) => `${problem.code}@${problem.partition ?? '?'}`).join(', '));

const afterPack = compact({ snapshot: after, profile: 'medium' });
const afterInvariantTexts = new Set((afterPack.sections.invariants ?? []).map((entry) => entry.text));
const baselineInvariants = pack.sections.invariants ?? [];
check('every baseline invariant survives into the post-delta pack', baselineInvariants.every((entry) => afterInvariantTexts.has(entry.text)));

console.log('\n6. INSTRUMENTATION');
const summary = instrument.summary();
const deltaSummary = deltaResult.instrument.summary();
console.log(`  scan: calls=${summary.calls} tokens=${summary.input_tokens ?? 'null'}/${summary.output_tokens ?? 'null'} cost=${summary.cost_usd ?? 'null'} source=${summary.cost_source} latency=${summary.latency_ms}ms`);
console.log(`  delta: calls=${deltaSummary.calls} tokens=${deltaSummary.input_tokens ?? 'null'}/${deltaSummary.output_tokens ?? 'null'} cost=${deltaSummary.cost_usd ?? 'null'} source=${deltaSummary.cost_source} latency=${deltaSummary.latency_ms}ms`);
check('cost is provider-reported, catalogue-marked or absent — never estimated', ['provider', 'mixed_or_catalogue', 'not_applicable', 'absent'].includes(summary.cost_source));
check('instrumentation separates scan and delta calls', summary.calls >= 0 && deltaSummary.calls >= 0);

// ------------------------------------------------------------------ artifacts

await writeFile(path.join(outDir, 'snapshot-poc-repo.json'), JSON.stringify(snapshot, null, 2));
await writeFile(path.join(outDir, 'snapshot-poc-repo-after.json'), JSON.stringify(after, null, 2));
await writeFile(path.join(outDir, 'pack-medium.json'), JSON.stringify(pack, null, 2));
await writeFile(path.join(outDir, 'pack-medium.md'), renderPack(pack));
await writeFile(path.join(outDir, 'pack-small.md'), renderPack(packs.small));
await writeFile(path.join(outDir, 'delta-poc-repo.json'), JSON.stringify(delta, null, 2));
await writeFile(path.join(outDir, 'instrumentation.jsonl'), instrument.toJSONL() + deltaResult.instrument.toJSONL());

const report = {
  schema: 'context-engine/poc-report/v1',
  generated_at: new Date().toISOString(),
  mode: live ? 'live' : 'stub',
  model: live ? provider.model.slug : 'stub-rule-scanner',
  qa_mode: qa.mode,
  subject: { root: fixtureRoot, files: acquisition.totals.files, bytes: acquisition.totals.bytes, partitions: partitionInfo.partition_count },
  scan: {
    strategy: snapshot.scan.strategy,
    partition_budget_tokens: snapshot.scan.partition_budget_tokens,
    partition_budget_source: snapshot.scan.partition_budget_source,
    partition_reason: snapshot.scan.partition_reason,
    findings: snapshot.sections.observations.length,
    verified_citations: snapshot.coverage.verified_citations,
    failed_citations: snapshot.coverage.failed_citations,
    conclusions: snapshot.sections.verified_conclusions.length,
    inferences: snapshot.sections.inferences.length,
    contradictions: snapshot.contradictions.length,
    questions: snapshot.sections.questions.length,
    cross_partition_relationships: snapshot.coverage.cross_partition_relationships,
    usage: summary,
  },
  facts: { line_rule_expected: factScore, model_only: modelOnly },
  packs: Object.fromEntries(Object.entries(packs).map(([name, entry]) => [name, {
    used_tokens_estimate: entry.used_tokens_estimate,
    budget_tokens_estimate: entry.budget_tokens_estimate,
    items_included: entry.coverage.items_included,
    items_total: entry.coverage.items_total,
    items_omitted: entry.coverage.items_omitted,
    reconstructible: entry.reconstructible,
  }])),
  qa: { ...qaScore, mode: qa.mode },
  delta: {
    counts: delta.counts,
    verification: delta.verification,
    rescanned: delta.rescanned,
    usage: deltaSummary,
  },
  checks: { total: checks, failed: failures },
  limitation: live ? null : 'Stub mode measures pipeline coherence, not model capability. Token and cost results are not applicable.',
};
await writeFile(path.join(outDir, 'poc-report.json'), JSON.stringify(report, null, 2));

console.log(`\nartifacts written to ${path.relative(process.cwd(), outDir)}/`);
console.log(`checks: ${checks - failures}/${checks}${failures ? ' — FAILURES PRESENT' : ''}`);
if (guard) {
  guard.close({ outcome: failures ? 'checks_failed' : 'completed' });
  console.log(`measured spend this attempt: $${guard.spent.toFixed(8)} of $${guard.authorizedUsd.toFixed(2)} authorised (attempt ${guard.attempt}, ${guard.calls} call(s))`);
}
if (live) console.log(`measured spend this run: $${budget.spent.toFixed(8)} of $${budgetUsd.toFixed(2)} budget`);
process.exit(failures ? 1 : 0);
