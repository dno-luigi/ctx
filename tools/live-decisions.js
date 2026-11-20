/**
 * Live decision-model run: one fixture, one engine, one pass, repeated k times.
 *
 * This is the paid path. It performs exactly what the adapter contract permits —
 * build a request, execute it, normalise the response, assemble cards — and writes
 * everything it received so the run can be re-examined without paying twice.
 *
 * Repeats exist because a single answer cannot be told apart from a lucky sample.
 * Each repetition is a separate call with an identical body; nothing is cached and
 * nothing is retried on a non-2xx, because a retry would silently change the sample.
 *
 * Guards:
 *
 *   - the API key is read from the environment and never written, echoed or logged;
 *   - a pre-flight cost ceiling refuses a call whose worst case, multiplied by the
 *     number of repetitions, would exceed `--max-usd`;
 *   - `--dry` validates the bank and prints the request without executing it;
 *   - a non-2xx response is recorded verbatim, the remaining repetitions still run,
 *     and the process fails loudly at the end.
 *
 * Usage:
 *   node tools/live-decisions.js --fixture F9 --model scaledown/classify-1 --bank banks/F9.json
 *   node tools/live-decisions.js --fixture F9 --model scaledown/classify-1 --bank banks/F9.json --repeat 5
 *   node tools/live-decisions.js --fixture F9 --model scaledown/classify-1 --bank banks/F9.json --dry
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';

import { buildState, estimateTokens, send } from '../adapters/decision/interface.js';
import { normaliseResponse } from '../adapters/decision/normalize.js';
import { createPerplexity } from '../adapters/decision/perplexity.js';
import { createScaleDown } from '../adapters/decision/scaledown.js';
import { validateBank } from '../adapters/decision/validate.js';
import { assembleSnapshot } from '../snapshot/assemble.js';
import { validateAssembled } from '../snapshot/validate.js';

const ROOT = new URL('../', import.meta.url);
const ENDPOINT = 'https://openrouter.ai/api/alpha/decisions';

function parseArgs(argv) {
  const options = { out: 'runs/live', maxUsd: 0.1, dry: false, label: null, repeat: 1 };
  for (let index = 0; index < argv.length; index += 1) {
    const [flag, inline] = argv[index].split('=');
    if (flag === '--fixture') options.fixture = inline ?? argv[++index];
    else if (flag === '--model') options.model = inline ?? argv[++index];
    else if (flag === '--bank') options.bank = inline ?? argv[++index];
    else if (flag === '--out') options.out = inline ?? argv[++index];
    else if (flag === '--max-usd') options.maxUsd = Number(inline ?? argv[++index]);
    else if (flag === '--repeat') options.repeat = Number(inline ?? argv[++index]);
    else if (flag === '--label') options.label = inline ?? argv[++index];
    else if (flag === '--dry') options.dry = true;
  }
  return options;
}

const options = parseArgs(process.argv.slice(2));
if (!options.fixture || !options.model || !options.bank) {
  console.error('usage: node tools/live-decisions.js --fixture <id> --model <slug> --bank <path> [--repeat n] [--dry] [--max-usd 0.1]');
  process.exit(2);
}
if (!Number.isInteger(options.repeat) || options.repeat < 1) {
  console.error('--repeat must be a positive integer');
  process.exit(2);
}

const deciders = JSON.parse(await readFile(new URL('deciders.json', ROOT), 'utf8'));
const descriptor = deciders.models.find((model) => model.id === options.model || model.request_model === options.model);
if (!descriptor) {
  console.error(`unknown model ${options.model}; known ids: ${deciders.models.map((model) => model.id).join(', ')}`);
  process.exit(2);
}

const adapter = descriptor.vendor === 'ScaleDown' ? createScaleDown(descriptor) : createPerplexity(descriptor);
const input = JSON.parse(await readFile(new URL(`fixtures/${options.fixture}/input.json`, ROOT), 'utf8'));
const authored = JSON.parse(await readFile(new URL(options.bank, ROOT), 'utf8'));

/**
 * Capability filtering, and nothing else. A `locate` question is dropped only when
 * the engine cannot answer it, and the drop is recorded so a run without citations
 * cannot be mistaken for a run that found none.
 */
function bankFor(adapter) {
  const supportsLocate = adapter.supportsLocate();
  const kept = [];
  const dropped = [];
  for (const question of authored.questions) {
    if (question.type === 'locate' && !supportsLocate) {
      dropped.push(question.name);
      continue;
    }
    const copy = { ...question };
    if (copy.evidence && !supportsLocate) {
      // The citation is declared in the authored bank; the engine cannot supply it.
      // Record the declaration instead of silently deleting the requirement.
      copy._evidence_declared = copy.evidence;
      delete copy.evidence;
    }
    kept.push(copy);
  }
  return { bank: { ...authored, questions: kept }, dropped };
}

const { bank, dropped } = bankFor(adapter);
const validatedBank = validateBank(bank, { adapter, input });
if (!validatedBank.ok) {
  console.error('bank refused:');
  for (const error of validatedBank.errors) console.error(`  - ${error}`);
  process.exit(1);
}

const state = buildState(input);
const request = adapter.buildRequest({ state, questions: bank.questions });
request.endpoint = descriptor.endpoint ?? ENDPOINT;

// ---------------------------------------------------------------- cost ceiling

const pricing = adapter.capabilities.pricing;
const stateTokensEst = estimateTokens(state.text);
// Observed on the live endpoint: ScaleDown reports ~4-17x the chars/4 estimate
// because it re-counts the state per question. 30x is the guard band.
const MULTIPLIER_GUARD = 30;
const worstCaseInput = stateTokensEst * MULTIPLIER_GUARD;
const worstCaseUsdPerCall = (worstCaseInput * pricing.input_per_mtok) / 1e6;
const worstCaseUsd = worstCaseUsdPerCall * options.repeat;
const costGuard = {
  state_tokens_est_chars4: stateTokensEst,
  multiplier_guard: MULTIPLIER_GUARD,
  worst_case_input_tokens_per_call: worstCaseInput,
  worst_case_usd_per_call: Number(worstCaseUsdPerCall.toFixed(6)),
  worst_case_usd_total: Number(worstCaseUsd.toFixed(6)),
  repetitions: options.repeat,
  ceiling_usd: options.maxUsd,
  refused: worstCaseUsd > options.maxUsd,
};

console.log(`live  ${descriptor.id}  over ${options.fixture}  ×${options.repeat}`);
console.log(`  state: ${state.text.length} chars (~${stateTokensEst} tokens at chars/4), ${state.segments.length} source(s)`);
console.log(`  bank: ${bank.questions.length} question(s)${dropped.length ? `, ${dropped.length} locate question(s) dropped for capability` : ''}`);
console.log(`  worst case pre-flight: $${costGuard.worst_case_usd_total} for ${options.repeat} call(s) (ceiling $${options.maxUsd})`);
if (costGuard.refused) {
  console.error('  refused: worst case exceeds the ceiling; raise --max-usd deliberately, not by reflex');
  process.exit(3);
}
if (options.dry) {
  console.log(`  dry run — request body keys: ${Object.keys(request.body).join(', ')}`);
  console.log(`  questions sent: ${Object.keys(request.body.questions).join(', ')}`);
  process.exit(0);
}

const apiKey = process.env.OPENROUTER_API_KEY;
if (!apiKey) {
  console.error('  OPENROUTER_API_KEY is not set in this environment');
  process.exit(4);
}

const slug = descriptor.id.replace(/[/:]/g, '_');
const runDir = new URL(`${options.out}/${slug}/`, ROOT);
await mkdir(runDir, { recursive: true });

const askedQuestions = bank.questions.filter((question) => question.type !== 'locate');
const seen = [];
let httpFailures = 0;
let invalid = 0;

for (let rep = 1; rep <= options.repeat; rep += 1) {
  const startedAt = Date.now();
  const response = await send(
    {
      endpoint: request.endpoint,
      headers: {
        ...request.headers,
        authorization: `Bearer ${apiKey}`,
        'HTTP-Referer': 'https://github.com/Ai-Nspired/gca-experiment',
        'X-Title': 'gca-experiment decision adapter',
      },
      body: request.body,
    },
    fetch
  );
  const latencyMs = Date.now() - startedAt;

  const record = {
    schema: 'gca-live-decision-run/v1',
    fixture: options.fixture,
    label: options.label,
    repetition: { index: rep, of: options.repeat },
    model: { id: descriptor.id, request_model: descriptor.request_model, vendor: descriptor.vendor, pricing },
    at: new Date().toISOString(),
    latency_ms: latencyMs,
    http: { status: response.status, ok: response.ok },
    request: {
      endpoint: request.endpoint,
      body: request.body,
      headers_sent: ['content-type', 'authorization (redacted)', 'HTTP-Referer', 'X-Title'],
    },
    bank,
    dropped_questions: dropped,
    cost_guard: costGuard,
    response_body: response.body,
  };

  const recordUrl = new URL(`${options.fixture}.r${rep}.json`, runDir);

  if (!response.ok) {
    httpFailures += 1;
    await writeFile(recordUrl, `${JSON.stringify(record, null, 2)}\n`);
    console.log(`  rep ${rep}: HTTP ${response.status} — recorded verbatim; ${JSON.stringify(response.body).slice(0, 200)}`);
    continue;
  }

  const normalised = normaliseResponse({ adapter, body: response.body, bank, state });
  const assembled = assembleSnapshot({
    input,
    bank,
    answers: normalised.answers,
    usage: normalised.usage,
    adapter,
    run: { id: `${options.fixture}:${descriptor.id}:r${rep}`, at: new Date().toISOString(), latency_ms: latencyMs },
  });
  const validated = validateAssembled({ input, snapshot: assembled.snapshot });
  if (!validated.ok) invalid += 1;

  const cardsWithEvidenceDeclared = bank.questions.filter((question) => question._evidence_declared).length;
  const citedCards = assembled.snapshot.observations.filter((observation) => observation.refs.length > 0).length;

  record.normalised = {
    answers: normalised.answers,
    usage: normalised.usage,
    problems: normalised.problems,
    question_multiplier: normalised.question_multiplier,
  };
  record.snapshot = assembled.snapshot;
  record.assembly_problems = assembled.problems;
  record.validation = validated;
  record.evidence_capability = {
    adapter_supports_locate: adapter.supportsLocate(),
    cards_with_evidence_declared: cardsWithEvidenceDeclared,
    cards_cited: citedCards,
  };

  await writeFile(recordUrl, `${JSON.stringify(record, null, 2)}\n`);
  seen.push({ rep, normalised, cards: assembled.snapshot.observations.length, citedCards, abstentions: assembled.snapshot.abstentions.length });

  console.log(
    `  rep ${rep}: HTTP ${response.status} ${latencyMs} ms  $${normalised.usage.cost_usd}  ${normalised.usage.input_tokens} in  problems=${normalised.problems.length}`
  );
}

// -------------------------------------------------------------------- summary

const costTotal = seen.reduce((total, entry) => total + (entry.normalised.usage.cost_usd ?? 0), 0);
console.log(`  total measured cost: $${Number(costTotal.toFixed(8))} over ${seen.length} successful call(s)`);

const questionNames = new Set(seen.flatMap((entry) => Object.keys(entry.normalised.answers)));
let stable = 0;
for (const name of questionNames) {
  const values = seen.map((entry) => JSON.stringify(entry.normalised.answers[name] ?? null));
  const same = new Set(values);
  if (same.size === 1) stable += 1;
  else console.log(`  varies  ${name}: ${[...same].join(' | ').slice(0, 200)}`);
}
console.log(`  byte-identical answers across repetitions: ${stable}/${questionNames.size}`);
console.log(`  wrote ${options.out}/${slug}/${options.fixture}.r<1..${options.repeat}>.json`);

process.exit(httpFailures > 0 || invalid > 0 ? 1 : 0);
