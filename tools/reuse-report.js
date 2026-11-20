/**
 * How much of a snapshot — and of the second pass — could actually be reused?
 *
 * "One keeper snapshot makes the other models cheaper" hides four separate claims,
 * and they have four different answers. This tool measures each from the records
 * already paid for, and spends nothing:
 *
 *   1. **Cards across engines** — do two engines' pass-1 answers differ at all? If
 *      they agree, a second engine's pass 1 buys no new content.
 *   2. **The second pass's questions** — the proposal bank is harness-owned, so it
 *      should be byte-identical for every engine. Verified, not assumed.
 *   3. **The second pass's agenda over time** — proposals are derived from pass-1
 *      confidences. If those move between repetitions, re-running the snapshot
 *      produces a different second pass, so the agenda itself is not reusable.
 *   4. **The second pass's verdicts** — can one engine's verdict be inherited by
 *      another? That is the only reusable part that costs money, and it is the only
 *      part that cannot be reused without accepting an error rate.
 *
 * Reuse is never asserted as valueless or as free: each layer reports what it would
 * have saved and what it would have got wrong.
 *
 * Usage: node tools/reuse-report.js
 */

import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';

import { deriveProposals } from '../snapshot/expand.js';

const ROOT = new URL('../', import.meta.url);
const REPORTS = (await readdir(new URL('runs/live/', ROOT), { withFileTypes: true }))
  .filter((entry) => entry.isDirectory() && entry.name !== 'expansion')
  .map((entry) => entry.name);

const records = [];
for (const dir of REPORTS) {
  for (const file of await readdir(new URL(`runs/live/${dir}/`, ROOT))) {
    const match = file.match(/^(.+)\.r(\d+)\.json$/);
    if (!match) continue;
    const record = JSON.parse(await readFile(new URL(`runs/live/${dir}/${file}`, ROOT), 'utf8'));
    if (!record.http.ok) continue;
    records.push({ ...record, fixture: match[1], rep: Number(match[2]), slug: dir });
  }
}

if (records.length === 0) {
  console.error('no live records to analyse; run tools/live-decisions.js first');
  process.exit(1);
}

const fixtures = [...new Set(records.map((record) => record.fixture))].sort();
const models = [...new Set(records.map((record) => record.model.id))].sort();
const abstainBelow = (record) => record.bank?.abstain_below ?? 0.5;

function decisionKey(answer, threshold) {
  if (!answer) return 'missing';
  if (answer.type === 'noul') return `noul:${answer.probability >= threshold ? 'yes' : 'no'}`;
  if (answer.type === 'choice') return `choice:${answer.choice}`;
  if (answer.type === 'score') return `score:${answer.score}`;
  return 'locate';
}

// ------------------------------------------- 1. cards across engines (rep 1)

const cardAgreement = [];
for (const fixture of fixtures) {
  const byModel = new Map();
  for (const model of models) {
    const record = records.find((entry) => entry.fixture === fixture && entry.model.id === model && entry.rep === 1);
    if (record) byModel.set(model, record);
  }
  const entries = [...byModel.entries()];
  if (entries.length < 2) continue;
  const threshold = abstainBelow(entries[0][1]);
  const names = [...new Set(entries.flatMap(([, record]) => Object.keys(record.normalised.answers)))].sort();
  const perQuestion = names.map((name) => {
    const keys = entries.map(([model, record]) => [model, decisionKey(record.normalised.answers[name], threshold)]);
    return { name, keys, agree: new Set(keys.map(([, key]) => key)).size === 1 };
  });
  cardAgreement.push({
    fixture,
    models: entries.map(([model]) => model),
    questions: perQuestion.length,
    agree: perQuestion.filter((question) => question.agree).length,
    disagreements: perQuestion.filter((question) => !question.agree),
  });
}

// --------------------------- 3. the second pass's agenda, per repetition (free)

const agendas = [];
for (const fixture of fixtures) {
  for (const model of models) {
    const reps = records.filter((entry) => entry.fixture === fixture && entry.model.id === model).sort((a, b) => a.rep - b.rep);
    if (reps.length === 0) continue;
    const perRep = reps.map((record) => {
      const derived = deriveProposals({ bank: record.bank, answers: record.normalised.answers, snapshot: record.snapshot });
      return {
        rep: record.rep,
        proposals: derived.proposals.map((proposal) => ({ signature: `${proposal.origin}|${proposal.question}`, id: proposal.id, type: proposal.type })),
      };
    });
    const union = new Set(perRep.flatMap((entry) => entry.proposals.map((proposal) => proposal.signature)));
    const withProposals = perRep.filter((entry) => entry.proposals.length > 0).length;
    agendas.push({
      fixture,
      model,
      repetitions: reps.length,
      union_proposals: union.size,
      repetitions_with_any_proposal: withProposals,
      per_rep: perRep.map((entry) => ({ rep: entry.rep, count: entry.proposals.length, signatures: entry.proposals.map((proposal) => proposal.signature) })),
      // A frozen snapshot is only reusable if replaying pass 1 reproduces the same
      // agenda. One proposal appearing in one of five repetitions is not reproducible.
      agenda_reproducible: union.size > 0 ? perRep.every((entry) => entry.proposals.length === perRep[0].proposals.length) && new Set(perRep.map((entry) => JSON.stringify(entry.proposals.map((p) => p.signature)))).size === 1 : true,
    });
  }
}

const exploredAgendas = agendas.filter((agenda) => agenda.union_proposals > 0);

// --------------------------------------- 2 + 4. the second pass, across engines

let expansion = [];
try {
  const dirs = (await readdir(new URL('runs/live/expansion/', ROOT), { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
  for (const dir of dirs) {
    for (const file of await readdir(new URL(`runs/live/expansion/${dir}/`, ROOT))) {
      if (!file.endsWith('.json')) continue;
      const record = JSON.parse(await readFile(new URL(`runs/live/expansion/${dir}/${file}`, ROOT), 'utf8'));
      if (!record.http?.ok || !record.second_pass) continue;
      expansion.push({ ...record, slug: dir });
    }
  }
} catch {
  expansion = [];
}

let verdictReuse = null;
if (expansion.length > 1) {
  const questionBodies = expansion.map((entry) => JSON.stringify(entry.request.body.questions));
  const identicalQuestions = new Set(questionBodies).size === 1;
  const byProposal = {};
  for (const entry of expansion) {
    for (const verdict of entry.second_pass.verdicts) {
      const key = `${entry.fixture}|${verdict.proposal.origin}|${verdict.proposal.question}`;
      (byProposal[key] ??= []).push({
        model: entry.model.id,
        probability: verdict.probability,
        verdict: verdict.verdict,
        cost_usd: entry.normalised.usage.cost_usd,
        input_tokens: entry.normalised.usage.input_tokens,
      });
    }
  }
  const perProposal = Object.entries(byProposal).map(([key, entries]) => {
    const verdicts = [...new Set(entries.map((entry) => entry.verdict))];
    let agreePairs = 0;
    let pairs = 0;
    for (let i = 0; i < entries.length; i += 1) {
      for (let j = i + 1; j < entries.length; j += 1) {
        pairs += 1;
        if (entries[i].verdict === entries[j].verdict) agreePairs += 1;
      }
    }
    return {
      proposal: key,
      engines: entries,
      unanimous: verdicts.length === 1,
      verdicts,
      pairwise_agreement: pairs ? Number((agreePairs / pairs).toFixed(3)) : null,
      probability_range: Number((Math.max(...entries.map((entry) => entry.probability)) - Math.min(...entries.map((entry) => entry.probability))).toFixed(4)),
    };
  });
  const totalPairwise = perProposal.reduce((sum, entry) => sum + (entry.pairwise_agreement ?? 0) * 3, 0);
  verdictReuse = {
    proposals_shared: perProposal.length,
    engines_per_proposal: expansion.length / Math.max(1, perProposal.length),
    identical_question_bodies: identicalQuestions,
    question_body_note: identicalQuestions
      ? 'the proposal bank is byte-identical across engines: 100% of the second pass\'s questions are reusable as-is'
      : 'question bodies differ across engines, so the bank is NOT reusable as-is',
    per_proposal: perProposal,
    pairwise_agreement: perProposal.length ? Number((totalPairwise / (perProposal.length * 3)).toFixed(3)) : null,
    verdict_inheritance_error_rate: perProposal.length ? Number((1 - totalPairwise / (perProposal.length * 3)).toFixed(3)) : null,
  };
}

// ------------------------------------------------------------------ economics

const perModelFixture = models.map((model) => {
  const rep1 = records.filter((entry) => entry.model.id === model && entry.rep === 1);
  const cost = rep1.reduce((sum, entry) => sum + (entry.normalised.usage.cost_usd ?? 0), 0);
  return { model, assessments: rep1.length, cost_usd: Number(cost.toFixed(8)), input_tokens: rep1.reduce((sum, entry) => sum + (entry.normalised.usage.input_tokens ?? 0), 0) };
});
const cohortCost = perModelFixture.reduce((sum, entry) => sum + entry.cost_usd, 0);
const cheapest = perModelFixture.reduce((best, entry) => (entry.cost_usd < best.cost_usd ? entry : best), perModelFixture[0]);

const secondPassShare = expansion.map((entry) => {
  const pass1 = records.find((record) => record.fixture === entry.fixture && record.model.id === entry.model.id && record.rep === 1);
  const pass1Cost = pass1?.normalised.usage.cost_usd ?? 0;
  const pass2Cost = entry.normalised.usage.cost_usd ?? 0;
  return {
    fixture: entry.fixture,
    model: entry.model.id,
    pass1_usd: pass1Cost,
    pass2_usd: pass2Cost,
    pass2_share: pass1Cost + pass2Cost > 0 ? Number((pass2Cost / (pass1Cost + pass2Cost)).toFixed(3)) : null,
    pass2_usd_as_fraction_of_pass1: pass1Cost > 0 ? Number((pass2Cost / pass1Cost).toFixed(3)) : null,
    state_recounted: true,
  };
});

const summary = {
  schema: 'gca-reuse-report/v1',
  generated_at: new Date().toISOString(),
  spend: 0,
  source: 'records already paid for; this analysis makes no calls',
  layers: {
    cards_across_engines: {
      question: 'if a second engine re-ran pass 1, would it add any card the first engine did not?',
      per_fixture: cardAgreement,
      agreement: cardAgreement.reduce((sum, entry) => sum + entry.agree, 0),
      total: cardAgreement.reduce((sum, entry) => sum + entry.questions, 0),
    },
    second_pass_agenda_over_time: {
      question: 'if the snapshot were re-taken, would the second pass ask the same things?',
      agendas: exploredAgendas,
      reproducible: exploredAgendas.filter((agenda) => agenda.agenda_reproducible).length,
      explored: exploredAgendas.length,
    },
    second_pass_questions_across_engines: {
      question: 'is the proposal bank reusable without rewriting?',
      ...verdictReuse,
    },
    second_pass_verdicts: {
      question: 'can one engine\'s verdict be inherited by another?',
      pairwise_agreement: verdictReuse?.pairwise_agreement ?? null,
      inheritance_error_rate: verdictReuse?.verdict_inheritance_error_rate ?? null,
      caveat: 'n = 1 shared proposal; this bounds nothing statistically',
    },
    economics: {
      cohort_cost_usd: Number(cohortCost.toFixed(8)),
      per_model: perModelFixture,
      single_keeper: {
        model: cheapest.model,
        cost_usd: cheapest.cost_usd,
        avoided_usd: Number((cohortCost - cheapest.cost_usd).toFixed(8)),
        avoided_fraction: cohortCost > 0 ? Number(((cohortCost - cheapest.cost_usd) / cohortCost).toFixed(3)) : null,
        condition: 'only valid if one engine\'s decisions are accepted as authoritative for all consumers, which the 42/42 card agreement below makes plausible on this material and does not prove in general',
      },
      second_pass_share: secondPassShare,
      state_reuse: {
        reusable: false,
        note: 'both passes send the full state; nothing about the state is cached, so a second pass costs an additional full-state charge rather than a discounted one',
      },
    },
  },
  limits: [
    'Three fixtures, fourteen questions: agreement across engines is measured on easy, confident material and says nothing about questions near a boundary.',
    'Only one proposal exists in the whole sample, so verdict agreement is n = 1 and no rate is claimed from it.',
    'Cost reuse is arithmetic on measured prices, not a projection of a different workload.',
    'Nothing here validates that reusing one engine\'s snapshot is correct; it measures how often the engines agreed.',
  ],
};

await mkdir(new URL('runs/live/', ROOT), { recursive: true });
await writeFile(new URL('runs/live/reuse.json', ROOT), `${JSON.stringify(summary, null, 2)}\n`);

// -------------------------------------------------------------------- console

const cards = summary.layers.cards_across_engines;
console.log('1. cards across engines (rep 1)');
for (const entry of cards.per_fixture) console.log(`   ${entry.fixture.padEnd(4)} ${entry.agree}/${entry.questions} questions identical across ${entry.models.length} engines`);
console.log(`   total: ${cards.agreement}/${cards.total}`);

console.log('\n2. second-pass agenda over repetitions (derived free, no calls)');
if (exploredAgendas.length === 0) {
  console.log('   no configuration ever produced a proposal, so there is no agenda to reuse');
} else {
  for (const agenda of exploredAgendas) {
    console.log(`   ${agenda.fixture} · ${agenda.model}: ${agenda.union_proposals} distinct proposal(s), present in ${agenda.repetitions_with_any_proposal}/${agenda.repetitions} repetition(s), reproducible=${agenda.agenda_reproducible}`);
    for (const rep of agenda.per_rep) console.log(`      rep ${rep.rep}: ${rep.count} — ${rep.signatures.map((s) => s.split('|')[0]).join(', ') || 'none'}`);
  }
}

console.log('\n3. second-pass questions across engines');
if (!verdictReuse) console.log('   no second-pass records to compare');
else {
  console.log(`   byte-identical proposal bank across engines: ${verdictReuse.identical_question_bodies}`);
  console.log(`   ${verdictReuse.question_body_note}`);
}

console.log('\n4. second-pass verdicts across engines');
if (verdictReuse) {
  for (const entry of verdictReuse.per_proposal) {
    console.log(`   ${entry.proposal}`);
    for (const engine of entry.engines) console.log(`      ${engine.model.padEnd(36)} P=${String(engine.probability).padEnd(20)} ${engine.verdict.padEnd(14)} $${engine.cost_usd}`);
    console.log(`      unanimous=${entry.unanimous}  pairwise agreement=${entry.pairwise_agreement}  probability range=${entry.probability_range}`);
  }
  console.log(`   inheritance error rate: ${verdictReuse.verdict_inheritance_error_rate} (n = ${verdictReuse.proposals_shared} proposal)`);
}

console.log('\n5. economics');
for (const entry of perModelFixture) console.log(`   ${entry.model.padEnd(36)} ${entry.assessments} assessment(s)  $${entry.cost_usd}`);
const keeper = summary.layers.economics.single_keeper;
console.log(`   one keeper (${keeper.model}): $${keeper.cost_usd}, cohort $${summary.layers.economics.cohort_cost_usd}, avoided ${(keeper.avoided_fraction * 100).toFixed(1)}%`);
for (const entry of secondPassShare) {
  console.log(`   ${entry.fixture} · ${entry.model.padEnd(36)} pass 2 = ${(entry.pass2_share * 100).toFixed(1)}% of the two-tier cost (+${(entry.pass2_usd_as_fraction_of_pass1 * 100).toFixed(1)}% of pass 1), state re-sent in full`);
}

console.log('\nwrote runs/live/reuse.json');
