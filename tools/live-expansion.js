/**
 * The double-pass sample: pass 1 decisions → harness-derived proposals → one
 * additional pass that adjudicates each proposal.
 *
 * This runs the expansion path against live engines, reusing the recorded pass-1
 * responses (no second charge for pass 1). It adds one thing the unit tests cannot
 * show: what a real second pass asks, what it costs, and whether the engines agree
 * on the same proposal bank.
 *
 * Two limits are stated in every record rather than discovered later:
 *
 *   - `evaluateSecondPass`'s 0.6/0.4 bands are **provisional and unauthorised**. A
 *     decision-path threshold needs its own pre-registration (R5), so every verdict
 *     here is labelled with the band it used and `authorised: false`.
 *   - `incremental_completeness` stays null. Measuring completeness needs a
 *     model-independent denominator; the inventory is not yet one (LIVE-RUN-01 §7).
 *
 * The proposal bank is engine-independent by construction — the harness names each
 * candidate and only the verdict comes from the model — so one engine's pass-1
 * snapshot can seed the same second pass on another engine. That is the sense in
 * which one good snapshot makes later work cheaper, and this tool measures it by
 * sending an identical bank to every engine.
 *
 * Usage:
 *   node tools/live-expansion.js --fixture F3 --model scaledown/classify-1 --dry
 *   node tools/live-expansion.js --fixture F3 --model scaledown/classify-1
 *   node tools/live-expansion.js --fixture F3 --model scaledown/classify-1 --bank-from perplexity/pplx-decider-flash-v1.2
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';

import { buildState, send } from '../adapters/decision/interface.js';
import { normaliseResponse } from '../adapters/decision/normalize.js';
import { createPerplexity } from '../adapters/decision/perplexity.js';
import { createScaleDown } from '../adapters/decision/scaledown.js';
import { validateBank } from '../adapters/decision/validate.js';
import { deriveProposals, evaluateSecondPass, expansionReport, planSecondPass } from '../snapshot/expand.js';

const ROOT = new URL('../', import.meta.url);
const ENDPOINT = 'https://openrouter.ai/api/alpha/decisions';

function parseArgs(argv) {
  const options = { out: 'runs/live/expansion', dry: false, rep: 1, maxUsd: 0.1, bankFrom: null };
  for (let index = 0; index < argv.length; index += 1) {
    const [flag, inline] = argv[index].split('=');
    if (flag === '--fixture') options.fixture = inline ?? argv[++index];
    else if (flag === '--model') options.model = inline ?? argv[++index];
    else if (flag === '--rep') options.rep = Number(inline ?? argv[++index]);
    else if (flag === '--bank-from') options.bankFrom = inline ?? argv[++index];
    else if (flag === '--out') options.out = inline ?? argv[++index];
    else if (flag === '--max-usd') options.maxUsd = Number(inline ?? argv[++index]);
    else if (flag === '--dry') options.dry = true;
  }
  return options;
}

const options = parseArgs(process.argv.slice(2));
if (!options.fixture || !options.model) {
  console.error('usage: node tools/live-expansion.js --fixture <id> --model <slug> [--bank-from <slug>] [--rep n] [--dry]');
  process.exit(2);
}

const deciders = JSON.parse(await readFile(new URL('deciders.json', ROOT), 'utf8'));
const descriptorOf = (slug) => deciders.models.find((model) => model.id === slug || model.request_model === slug);
const descriptor = descriptorOf(options.model);
if (!descriptor) {
  console.error(`unknown model ${options.model}`);
  process.exit(2);
}

const slugOf = (id) => id.replace(/[/:]/g, '_');
const adapterFor = (entry) => (entry.vendor === 'ScaleDown' ? createScaleDown(entry) : createPerplexity(entry));

const adapter = adapterFor(descriptor);
const input = JSON.parse(await readFile(new URL(`fixtures/${options.fixture}/input.json`, ROOT), 'utf8'));

// Pass 1 is read, not re-run: the bytes are already on disk and charging twice for
// the same answer would make the two-tier cost wrong.
const pass1Slug = options.bankFrom ? slugOf(descriptorOf(options.bankFrom)?.id ?? options.bankFrom) : slugOf(descriptor.id);
const pass1 = JSON.parse(await readFile(new URL(`runs/live/${pass1Slug}/${options.fixture}.r${options.rep}.json`, ROOT), 'utf8'));
if (!pass1.http.ok) {
  console.error(`pass-1 record is HTTP ${pass1.http.status}; nothing to expand`);
  process.exit(1);
}

const derived = deriveProposals({ bank: pass1.bank, answers: pass1.normalised.answers, snapshot: pass1.snapshot });
const plan = planSecondPass({ proposals: derived.proposals, adapter });

const verdictBands = {
  supported_at_or_above: 0.6,
  unsupported_at_or_below: 0.4,
  authorised: false,
  note: 'provisional bands baked into evaluateSecondPass; a decision-path threshold needs its own pre-registration (R5) before any verdict is quoted as a result',
};

console.log(`expansion  ${descriptor.id}  over ${options.fixture}  (pass 1 from ${pass1.model.id} rep ${options.rep})`);
console.log(`  pass-1 answers: ${Object.keys(pass1.normalised.answers).length}, cost $${pass1.normalised.usage.cost_usd}`);
console.log(`  proposals derived: ${derived.stats.derived} (kept ${derived.stats.kept}, duplicates removed ${derived.stats.duplicates_removed})`);
console.log(`  by origin: ${JSON.stringify(derived.stats.by_origin)}`);
console.log(`  evidence-required but unavailable: ${plan.evidence_required_but_unavailable} of ${plan.accepted.length} accepted`);

if (plan.accepted.length === 0) {
  console.log('  nothing to ask: no proposal survived derivation, so there is no second pass');
  console.log('  this is the structural result of a no-evidence engine: two of the four proposal rules can never fire');
  if (!options.dry) {
    const outDir = new URL(`${options.out}/${slugOf(descriptor.id)}/`, ROOT);
    await mkdir(outDir, { recursive: true });
    await writeFile(
      new URL(`${options.fixture}.json`, outDir),
      `${JSON.stringify(
        {
          schema: 'gca-live-expansion-run/v1',
          fixture: options.fixture,
          model: descriptor.id,
          pass1_from: pass1.model.id,
          at: new Date().toISOString(),
          verdict_bands: verdictBands,
          proposals: derived,
          plan: { pass: plan.pass, accepted: 0, rejected: plan.rejected.length, evidence_available: plan.evidence_available },
          second_pass: { skipped: 'no proposals derived' },
          report: expansionReport({
            derived,
            plan,
            secondPass: { verdicts: [], stats: { evaluated: 0, supported: 0, unsupported: 0, indeterminate: 0, missing: 0 } },
            usage: { cost_usd: 0 },
            inventory: null,
          }),
        },
        null,
        2
      )}\n`
    );
  }
  process.exit(0);
}

const validatedBank = validateBank(plan.bank, { adapter, input });
if (!validatedBank.ok) {
  console.error('  second-pass bank refused:');
  for (const error of validatedBank.errors) console.error(`    - ${error}`);
  process.exit(1);
}

const state = buildState(input);
const request = adapter.buildRequest({ state, questions: plan.bank.questions });
request.endpoint = descriptor.endpoint ?? ENDPOINT;

const stateTokensEst = Math.ceil(state.text.length / 4);
const worstCaseUsd = ((stateTokensEst * 30 * descriptor.pricing.input_per_mtok) / 1e6) * plan.accepted.length;
console.log(`  second pass: ${plan.accepted.length} question(s) over ${state.text.length} chars`);
console.log(`  worst case: $${worstCaseUsd.toFixed(6)} (ceiling $${options.maxUsd})`);
for (const proposal of plan.accepted) console.log(`    ${proposal.id} ${proposal.type.padEnd(18)} ${proposal.question.slice(0, 100)}`);

if (options.dry) {
  console.log('  dry run — nothing sent');
  process.exit(0);
}
if (worstCaseUsd > options.maxUsd) {
  console.error('  refused: worst case exceeds the ceiling');
  process.exit(3);
}

const apiKey = process.env.OPENROUTER_API_KEY;
if (!apiKey) {
  console.error('  OPENROUTER_API_KEY is not set in this environment');
  process.exit(4);
}

const startedAt = Date.now();
const response = await send(
  {
    endpoint: request.endpoint,
    headers: {
      ...request.headers,
      authorization: `Bearer ${apiKey}`,
      'HTTP-Referer': 'https://github.com/Ai-Nspired/gca-experiment',
      'X-Title': 'gca-experiment expansion pass',
    },
    body: request.body,
  },
  fetch
);
const latencyMs = Date.now() - startedAt;

const outDir = new URL(`${options.out}/${slugOf(descriptor.id)}/`, ROOT);
await mkdir(outDir, { recursive: true });

const record = {
  schema: 'gca-live-expansion-run/v1',
  fixture: options.fixture,
  model: { id: descriptor.id, vendor: descriptor.vendor, pricing: descriptor.pricing },
  pass1_from: pass1.model.id,
  at: new Date().toISOString(),
  latency_ms: latencyMs,
  http: { status: response.status, ok: response.ok },
  request: { endpoint: request.endpoint, body: request.body, headers_sent: ['content-type', 'authorization (redacted)', 'HTTP-Referer', 'X-Title'] },
  verdict_bands: verdictBands,
  proposals: derived,
  plan: {
    pass: plan.pass,
    accepted: plan.accepted.map((proposal) => ({ id: proposal.id, type: proposal.type, origin: proposal.origin, question: proposal.question })),
    rejected: plan.rejected.length,
    evidence_available: plan.evidence_available,
    evidence_required_but_unavailable: plan.evidence_required_but_unavailable,
  },
  response_body: response.body,
};

if (!response.ok) {
  await writeFile(new URL(`${options.fixture}.json`, outDir), `${JSON.stringify(record, null, 2)}\n`);
  console.error(`  HTTP ${response.status} — recorded verbatim; ${JSON.stringify(response.body).slice(0, 500)}`);
  process.exit(5);
}

const normalised = normaliseResponse({ adapter, body: response.body, bank: plan.bank, state });
const secondPass = evaluateSecondPass({ plan, answers: normalised.answers });
const pass1Cost = pass1.normalised.usage.cost_usd ?? 0;
const pass2Cost = normalised.usage.cost_usd ?? 0;
const report = expansionReport({ derived, plan, secondPass, usage: { cost_usd: pass2Cost }, inventory: null });

record.normalised = { answers: normalised.answers, usage: normalised.usage, problems: normalised.problems };
record.second_pass = secondPass;
record.report = report;
record.two_tier_cost = {
  pass_1_usd: pass1Cost,
  pass_2_usd: pass2Cost,
  total_usd: Number((pass1Cost + pass2Cost).toFixed(8)),
  pass_2_share_of_total: pass1Cost + pass2Cost > 0 ? Number((pass2Cost / (pass1Cost + pass2Cost)).toFixed(3)) : null,
  same_state_twice: true,
  note: 'both passes send the full state; the second pass is an additional charge over the same context, not a saving on it',
};

await writeFile(new URL(`${options.fixture}.json`, outDir), `${JSON.stringify(record, null, 2)}\n`);

console.log(`  HTTP ${response.status} in ${latencyMs} ms  $${pass2Cost}  ${normalised.usage.input_tokens} in  problems=${normalised.problems.length}`);
for (const verdict of secondPass.verdicts) {
  console.log(`    ${verdict.proposal.id.padEnd(20)} ${String(verdict.probability).padEnd(20)} ${verdict.verdict}`);
}
console.log(`  verdicts: ${JSON.stringify(secondPass.stats)}`);
console.log(`  two-tier cost: $${record.two_tier_cost.total_usd} (pass 1 $${pass1Cost} + pass 2 $${pass2Cost})`);
console.log(`  incremental cost per supported card: ${report.incremental_cost_per_supported_card}`);
console.log(`  incremental completeness: ${report.incremental_completeness} — ${report.incremental_completeness_reason}`);
console.log(`  wrote ${options.out}/${slugOf(descriptor.id)}/${options.fixture}.json`);
