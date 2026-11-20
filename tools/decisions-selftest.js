import { readFile } from 'node:fs/promises';

import { buildState, createAdapter, spanToRef } from '../adapters/decision/interface.js';
import { normaliseResponse } from '../adapters/decision/normalize.js';
import { createPerplexity } from '../adapters/decision/perplexity.js';
import { createScaleDown } from '../adapters/decision/scaledown.js';
import { validateBank, validateProposalSet } from '../adapters/decision/validate.js';
import { assembleSnapshot } from '../snapshot/assemble.js';
import { MAX_PASSES, deriveProposals, evaluateSecondPass, expansionReport, planSecondPass } from '../snapshot/expand.js';
import { validateAssembled } from '../snapshot/validate.js';
import { hashSource } from '../src/canonical.js';

/**
 * Checks the decision interface, not a model.
 *
 * Everything here runs against recorded contract samples: no network call, no key,
 * no charge. The suite proves the four things the architecture claims and nothing
 * more: the request is not a chat request, the response is validated rather than
 * repaired, the assembler never invents evidence, and expansion is one pass.
 */

const ROOT = new URL('../', import.meta.url);
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

const deciders = JSON.parse(await readFile(new URL('./deciders.json', ROOT), 'utf8'));
const descriptorOf = (id) => deciders.models.find((model) => model.id === id);
const readSample = async (name) => JSON.parse(await readFile(new URL(`./recorded/decisions/${name}`, ROOT), 'utf8'));

function inputFor(stateText, sourceId = 's1') {
  const source = {
    id: sourceId,
    kind: 'document',
    label: 'recorded sample',
    media_type: 'text/plain',
    status: 'ready',
    content: { text: stateText, data_url: null },
    origin: { supplied_by: 'operator', method: 'paste', captured_at: '2026-11-18T00:00:00.000Z' },
    observation: 'observed',
  };
  source.hash = hashSource(source);
  return {
    schema: 'gca-input/v1',
    run: { id: 'rec', at: '2026-11-18T00:00:00.000Z', operator_ref: 'operator' },
    task: { question: 'recorded sample', deliverable: 'snapshot' },
    sources: [source],
    budgets: { max_input_tokens: 200000, max_sources: 6, max_bytes: 4000000 },
  };
}

const stateFor = (text, sourceId = 's1') => ({ text, segments: [{ source_id: sourceId, start: 0, end: text.length }] });

async function runSample(name) {
  const sample = await readSample(name);
  const adapter = sample.adapter.startsWith('scaledown') ? createScaleDown(descriptorOf(sample.adapter)) : createPerplexity(descriptorOf(sample.adapter));
  const sourceId = sample.source_id ?? 's1';
  const input = inputFor(sample.state, sourceId);
  const state = stateFor(sample.state, sourceId);
  const normalised = normaliseResponse({ adapter, body: sample.response, bank: sample.bank, state });
  const assembled = assembleSnapshot({
    input,
    bank: sample.bank,
    answers: normalised.answers,
    usage: normalised.usage,
    adapter,
    run: { id: 'rec:1', at: '2026-11-18T00:00:00.000Z', latency_ms: 210 },
  });
  const validated = validateAssembled({ input, snapshot: assembled.snapshot });
  return { sample, adapter, input, state, normalised, assembled, validated };
}

// ------------------------------------------------------------- adapter contract

console.log('\nadapter contract (a decision engine, not a chat provider)');
{
  const scaledown = createScaleDown(descriptorOf('scaledown/classify-1'));
  // The live endpoint (probed 2026-11-18) has no `locate` discriminator and every
  // vendor refuses `box`, so no engine in the cohort can return a text span. The
  // locate-handling path stays tested through a synthetic descriptor rather than
  // through a claim about a model that turned out to be false.
  const locateCapable = createPerplexity({ id: 'synthetic/locate-capable', questions: { types: ['noul', 'choice', 'score', 'locate'], max_locate: 128 } });

  check('ScaleDown declares no locate capability', scaledown.supportsLocate() === false);
  check(
    'a descriptor that serves locate yields a locate-capable adapter',
    locateCapable.supportsLocate() === true && locateCapable.capabilities.max_locate === 128
  );
  check(
    'no available engine in the verified cohort serves text evidence',
    deciders.models.filter((model) => model.available !== false).every((model) => !(model.questions?.served_types ?? []).includes('locate')),
    deciders.models.map((model) => `${model.id}:${(model.questions?.served_types ?? []).join('|') || '-'}`).join(', ')
  );
  check(
    'an adapter spec without an id is rejected',
    (() => {
      try {
        createAdapter({ vendor: 'x', capabilities: { question_types: [], pricing: { input_per_mtok: 0 } }, buildRequest() {}, extract() {} });
        return false;
      } catch {
        return true;
      }
    })()
  );
}

// --------------------------------------------------------------- bank validity

console.log('\nquestion bank (the instrument rule is enforced, not trusted)');
{
  const scaledown = createScaleDown(descriptorOf('scaledown/classify-1'));
  const input = inputFor('alpha beta gamma.');
  const base = {
    schema: 'gca-questions/v1',
    bank_version: '1',
    fixture: 'T',
    authored_from: 'operator question',
    grounded_in_answer_key: false,
    questions: [{ name: 'q1', type: 'noul', instructions: 'Is alpha present?', claim: 'Alpha is present.' }],
  };

  check('a bank derived from the answer key is refused', validateBank({ ...base, grounded_in_answer_key: true }, { adapter: scaledown, input }).errors.some((e) => e.includes('grounded_in_answer_key')));
  check('a bank without authored_from is refused', validateBank({ ...base, authored_from: '' }, { adapter: scaledown, input }).errors.some((e) => e.includes('authored_from')));
  check(
    'a locate question is refused by an adapter without locate',
    validateBank({ ...base, questions: [...base.questions, { name: 'q2', type: 'locate', instructions: 'the sentence' }] }, { adapter: scaledown, input }).errors.some((e) => e.includes('supports 0'))
  );
  check(
    'a choice question with one option is refused',
    validateBank({ ...base, questions: [{ name: 'q1', type: 'choice', instructions: 'x', claim: 'y', criteria: ['only'] }] }, { adapter: scaledown, input }).errors.some((e) => e.includes('at least 2'))
  );
}

// --------------------------------------------------------------- request shape

console.log('\nrequest body (no chat shape anywhere)');
{
  const scaledown = createScaleDown(descriptorOf('scaledown/classify-1'));
  const perplexity = createPerplexity(descriptorOf('perplexity/pplx-decider-v1.3:free'));
  const sample = await readSample('scaledown-clean.json');
  const state = stateFor(sample.state);
  const sdRequest = scaledown.buildRequest({ state, questions: sample.bank.questions });
  const pxSample = await readSample('perplexity-locate.json');
  const pxRequest = perplexity.buildRequest({ state: stateFor(pxSample.state), questions: pxSample.bank.questions });

  check('ScaleDown body has exactly model, state and questions', JSON.stringify(Object.keys(sdRequest.body).sort()) === JSON.stringify(['model', 'questions', 'state']));
  check('ScaleDown state is an object with text (this engine reads state.text only)', typeof sdRequest.body.state === 'object' && typeof sdRequest.body.state.text === 'string');
  check('Perplexity state is a bare string', typeof pxRequest.body.state === 'string');
  const serialised = JSON.stringify([sdRequest.body, pxRequest.body]);
  check('no temperature, max_tokens, response_format or messages', !/temperature|max_tokens|response_format|messages/.test(serialised));
}

// ------------------------------------------------------------------ normalise

console.log('\nnormalisation (reported, never repaired)');
{
  const clean = await runSample('scaledown-clean.json');
  check('a clean response produces no problems', clean.normalised.problems.length === 0, JSON.stringify(clean.normalised.problems));
  check('usage comes from the provider, not from a character estimate', clean.normalised.usage.input_tokens === 640 && clean.normalised.usage.source === 'reported');
  check('the question multiplier is reported', clean.normalised.question_multiplier > 1, String(clean.normalised.question_multiplier));
  check('cost is computed from reported usage', Math.abs(clean.normalised.usage.cost_usd - (640 * 0.04) / 1e6) < 1e-12);

  const bad = await runSample('malformed.json');
  const codes = new Set(bad.normalised.problems.map((problem) => problem.code));
  const expected = ['noul_out_of_range', 'choice_option_unknown', 'probabilities_not_normalised', 'choice_outside_criteria', 'span_text_mismatch', 'answer_missing', 'usage_missing'];
  check('every deliberate defect is reported', expected.every((code) => codes.has(code)), [...codes].join(', '));
  check('missing usage yields unknown cost, not an estimate', bad.normalised.usage.cost_usd === null && bad.normalised.usage.input_tokens === null);

  const astral = await runSample('perplexity-astral.json');
  const ref = astral.assembled.snapshot.observations[0]?.refs?.[0];
  check('code-point offsets are converted to UTF-16', ref?.span?.start === 14 && ref?.span?.end === 50, JSON.stringify(ref?.span));
  check('the converted quote is exact', ref?.quote === 'the retry completed after 7 seconds.');
  check(
    'a naive slice at the vendor offset would be wrong',
    astral.state.text.slice(13, 49) !== 'the retry completed after 7 seconds.'
  );
}

// ------------------------------------------------------------------- assemble

console.log('\nassembly (no invented evidence, frozen validators)');
{
  const clean = await runSample('scaledown-clean.json');
  const card = clean.assembled.snapshot.observations[0];
  check('without locate every card is inferred', card?.kind === 'inferred' && card.refs.length === 0);
  check('the no-locate snapshot still passes the frozen validator', clean.validated.ok === true, clean.validated.errors.join('; '));
  check('a low probability becomes an abstention, not a card', clean.assembled.snapshot.abstentions.length === 1 && clean.assembled.snapshot.observations.length === 1);

  const located = await runSample('perplexity-locate.json');
  check('a located card passes the frozen validator', located.validated.ok === true, located.validated.errors.join('; '));
  const locatedCard = located.assembled.snapshot.observations[0];
  check(
    'the located quote is a source-relative reference',
    locatedCard?.refs?.[0]?.source_id === 's1' && located.state.text.slice(locatedCard.refs[0].span.start, locatedCard.refs[0].span.end) === locatedCard.refs[0].quote
  );

  const stripped = await readSample('perplexity-locate.json');
  stripped.response.answers.auth_fix_where = { type: 'locate', spans: [] };
  const adapter = createPerplexity(descriptorOf('perplexity/pplx-decider-v1.3:free'));
  const input = inputFor(stripped.state);
  const normalised = normaliseResponse({ adapter, body: stripped.response, bank: stripped.bank, state: stateFor(stripped.state) });
  const assembled = assembleSnapshot({ input, bank: stripped.bank, answers: normalised.answers, usage: normalised.usage, adapter, run: { id: 'rec:2', at: '2026-11-18T00:00:00.000Z' } });
  check(
    'declaring evidence with no spans is recorded, not filled in',
    assembled.problems.some((problem) => problem.code === 'evidence_missing') && assembled.snapshot.observations[0].refs.length === 0
  );
}

// --------------------------------------------------------------------- expand

console.log('\nexpansion (one pass, harness-derived proposals)');
{
  const clean = await runSample('scaledown-clean.json');
  const scaledown = clean.adapter;

  // Clone answers only: the adapter carries functions and is not cloneable.
  const uncertainAnswers = structuredClone(clean.normalised.answers);
  uncertainAnswers.replicas.confidence = 0.55;
  const derived = deriveProposals({ bank: clean.sample.bank, answers: uncertainAnswers, snapshot: clean.assembled.snapshot });
  const lowConfidence = derived.proposals.find((proposal) => proposal.origin === 'low_confidence_choice');
  check('a low-confidence classification yields a high-priority proposal', Boolean(lowConfidence) && lowConfidence.priority === 'high');

  const duplicateSet = {
    schema: 'gca-questions/v1',
    bank_version: '1',
    fixture: 'D',
    authored_from: 'operator question',
    grounded_in_answer_key: false,
    questions: [
      { name: 'a', type: 'locate', instructions: 'the sentence' },
      { name: 'b', type: 'locate', instructions: 'the same sentence' },
    ],
  };
  const span = { source_id: 's1', quote: 'alpha beta', span: { start: 0, end: 10 } };
  const duplicated = deriveProposals({
    bank: duplicateSet,
    answers: { a: { type: 'locate', spans: [span] }, b: { type: 'locate', spans: [span] } },
    snapshot: { observations: [] },
  });
  check(
    'identical proposals are deduplicated and the removal is counted',
    duplicated.proposals.length === 1 && duplicated.stats.duplicates_removed === 1,
    `${duplicated.proposals.length} kept, ${duplicated.stats.duplicates_removed} counted`
  );

  check(
    'a second expansion pass is refused',
    (() => {
      try {
        planSecondPass({ proposals: derived.proposals, adapter: scaledown, pass: MAX_PASSES + 1 });
        return false;
      } catch {
        return true;
      }
    })()
  );

  const plan = planSecondPass({ proposals: derived.proposals, adapter: scaledown });
  check('the second pass asks exactly one question per accepted proposal', plan.bank.questions.length === plan.accepted.length && plan.bank.questions.every((question) => question.type === 'noul'));
  check(
    'evidence-required proposals are counted as unavailable without locate',
    plan.evidence_available === false && plan.evidence_required_but_unavailable === plan.accepted.filter((proposal) => proposal.evidence_required).length
  );

  check('the derived proposal set validates against the harness-owned schema', validateProposalSet({ schema: 'gca-proposals/v1', proposals: derived.proposals }).ok === true);

  const bounded = deriveProposals({ bank: duplicateSet, answers: duplicated.proposals.length ? { a: { type: 'locate', spans: [span] }, b: { type: 'locate', spans: [span] } } : {}, snapshot: { observations: [] }, limit: 0 });
  check('truncation is reported rather than silent', bounded.stats.truncated === 1 && bounded.proposals.length === 0);

  const verdicts = evaluateSecondPass({ plan, answers: Object.fromEntries(plan.bank.questions.map((question, index) => [question.name, { type: 'noul', noul: index === 0 ? 0.8 : 0.2 }])) });
  check('second-pass verdicts split supported, unsupported and indeterminate', verdicts.stats.evaluated === plan.accepted.length && verdicts.stats.missing === 0);

  const claimProposal = { id: 'c1', type: 'claim', title: 't', reason: 'r', question: 'q?', priority: 'medium', evidence_required: true, origin: 'unclaimed_locate_span' };
  const report = expansionReport({
    derived: { stats: { ...derived.stats, kept: 1 } },
    plan: { pass: 1, accepted: [claimProposal], rejected: [], evidence_available: true, evidence_required_but_unavailable: 0 },
    secondPass: { verdicts: [{ proposal: claimProposal, probability: 0.9, verdict: 'supported' }], stats: { evaluated: 1, supported: 1, unsupported: 0, indeterminate: 0, missing: 0 } },
    usage: { cost_usd: 0.0002 },
  });
  check('a supported claim proposal counts as an additional card', report.additional_cards === 1 && report.incremental_cost_per_supported_card === 0.0002);
  check('incremental completeness is reported as unmeasured, not invented', report.incremental_completeness === null && Boolean(report.incremental_completeness_reason));
  check('the report states one pass and refuses recursion', report.passes === 1 && report.recursion.includes(String(MAX_PASSES)));
}

// --------------------------------------------------------------------- cohort

console.log('\ncohort (no chat model is required or present)');
{
  const ids = deciders.models.map((model) => model.id);
  check('no generative vendor appears in the cohort', !ids.some((id) => /^(openai|google|anthropic)\//.test(id)), ids.join(', '));
  check(
    'every cohort entry declares input pricing and a context window',
    deciders.models.every((model) => typeof model.pricing?.input_per_mtok === 'number' && model.context_tokens > 0)
  );
}

console.log('');
const summary = `checks executed: ${executed} (passed: ${passed}, failed: ${failures.length})`;
if (failures.length) {
  console.error(`decisions selftest failed — ${summary}`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log(`decisions selftest passed — ${summary}`);
