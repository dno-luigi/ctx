/**
 * Card-generation stage: inventory items → questions → decisions → anchored cards.
 *
 * This is the step between "the inventory sees 96.8% of the required items" and "the
 * pilots' gates move", and it is measured as a pipeline rather than a headline number,
 * so that a high inventory recall cannot conceal a loss downstream.
 *
 * Stage accounting, per required item:
 *
 *   S1  oracle → inventory        an inventory item overlaps the adjudicated span
 *   S2  inventory → question      a question exists for that item
 *   S3  question → decision       the engine returned a usable answer (not an abstention)
 *   S4  decision → card           the answer states the requirement (lexical, declared)
 *   S5  card → anchor             the card is anchored to an item on the required span
 *   S6  card → classifiable       the card has an anchor, so a state can be established
 *
 * Unresolved items are retained as `unknown`, never dropped.
 *
 * The oracle is immutable: `pilot/coverage/required-items.json` is only read, its digest is
 * recorded, and questions are generated from **inventory items**, not from the required
 * list, so S2 can lose something.
 *
 * Gates are re-measured independently and their thresholds are untouched:
 *   H1 classification coverage ≥ 0.50   (F3, F9, original bank questions)
 *   H2 anchored plant coverage ≥ 0.60   (pilot/compaction/plants-probe.json)
 *
 * Usage: node tools/card-generation.js [--dry] [--max-usd 0.02] [--fixtures F1,F3,...]
 */

import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';

import { buildState, estimateTokens, send } from '../adapters/decision/interface.js';
import { normaliseResponse } from '../adapters/decision/normalize.js';
import { createPerplexity } from '../adapters/decision/perplexity.js';
import { anchorId } from '../cards/identity.js';
import { scanInventory } from '../inventory/scan.js';
import { scanCoverageRules } from '../inventory/rules-coverage.js';

const ROOT = new URL('../', import.meta.url);
const options = { dry: false, maxUsd: 0.02, out: 'runs/cardgen', model: 'perplexity/pplx-decider-flash-v1.2' };
for (let index = 0; index < process.argv.length; index += 1) {
  const [flag, inline] = String(process.argv[index]).split('=');
  if (flag === '--dry') options.dry = true;
  else if (flag === '--max-usd') options.maxUsd = Number(inline ?? process.argv[++index]);
  else if (flag === '--out') options.out = inline ?? process.argv[++index];
  else if (flag === '--model') options.model = inline ?? process.argv[++index];
}

const oracleRaw = await readFile(new URL('pilot/coverage/required-items.json', ROOT), 'utf8');
const oracleDigest = createHash('sha256').update(oracleRaw).digest('hex');
const oracle = JSON.parse(oracleRaw);
const plantsFile = JSON.parse(await readFile(new URL('pilot/compaction/plants-probe.json', ROOT), 'utf8'));
const deciders = JSON.parse(await readFile(new URL('deciders.json', ROOT), 'utf8'));
const descriptor = deciders.models.find((model) => model.id === options.model);
if (!descriptor) throw new Error(`unknown model ${options.model}`);
const adapter = createPerplexity(descriptor);

// Keep numeric tokens however short. Dropping them made "retained for 30 days" and
// "retained for 90 days" indistinguishable, so the matcher could not tell a recovered value
// from its sibling — the exact distinction this pipeline exists to preserve.
const tokens = (text) =>
  new Set(
    String(text ?? '')
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((token) => token.length >= 4 || /\d/.test(token))
  );
const overlap = (a, b) => {
  const left = tokens(a);
  const right = tokens(b);
  if (left.size === 0) return 0;
  let shared = 0;
  for (const token of left) if (right.has(token)) shared += 1;
  return shared / left.size;
};

/**
 * A `noul` answer is a probability, not text (probed: `{type:'noul', noul: 0.95}`). So the
 * question must carry a *proposition*, and the proposition has to come from the record —
 * the inventory item's own verbatim quote — not from the model. The model's only job is to
 * say whether the source supports it.
 */
const propositionFor = (item) => (item.spans?.[0]?.quote ?? item.label ?? '').slice(0, 240);
const instructionFor = (proposition) => `Is the following stated in the source, verbatim or in substance? "${proposition}"`;

/** Answers arrive as probabilities; tolerate a text answer too, and record which happened. */
function extractAnswer(answer) {
  if (answer === null || answer === undefined) return { probability: null, text: null };
  if (typeof answer === 'number') return { probability: answer, text: null };
  if (typeof answer === 'string') return { probability: null, text: answer.trim() || null };
  if (typeof answer === 'object') {
    for (const key of ['noul', 'probability', 'value', 'score']) {
      if (typeof answer[key] === 'number') return { probability: answer[key], text: null };
    }
    for (const key of ['text', 'answer', 'statement', 'claim']) {
      if (typeof answer[key] === 'string' && answer[key].trim()) return { probability: null, text: answer[key].trim() };
    }
  }
  return { probability: null, text: null };
}

const spanOverlaps = (itemSpan, required) =>
  itemSpan.source_id === required.source_id && itemSpan.span.start < required.end && itemSpan.span.end > required.start;

function spansOf(input, quote, sourceId) {
  const spans = [];
  for (const source of input.sources ?? []) {
    if (sourceId && source.id !== sourceId) continue;
    const text = source.content?.text ?? '';
    let at = text.indexOf(quote);
    while (at !== -1) {
      spans.push({ source_id: source.id, start: at, end: at + quote.length });
      at = text.indexOf(quote, at + 1);
    }
  }
  return spans;
}

const answerText = (answer) => {
  if (answer === null || answer === undefined) return null;
  if (typeof answer === 'string') return answer.trim() || null;
  if (typeof answer === 'object') {
    for (const key of ['value', 'answer', 'text', 'statement', 'claim']) {
      if (typeof answer[key] === 'string' && answer[key].trim()) return answer[key].trim();
    }
    if (typeof answer.probability === 'number' && typeof answer.value === 'number') return String(answer.value);
    return JSON.stringify(answer);
  }
  return String(answer);
};

const fixtures = Object.keys(oracle.fixtures);
const perFixture = [];
let worstCaseUsd = 0;
const prepared = [];

for (const fixture of fixtures) {
  const input = JSON.parse(await readFile(new URL(`fixtures/${fixture}/input.json`, ROOT), 'utf8'));
  const baseline = scanInventory(input, { maxItems: 20000 });
  const coverage = scanCoverageRules(input);
  const state = buildState(input);
  const questions = coverage.items.map((item, index) => {
    const proposition = propositionFor(item);
    return {
      name: `cov_${String(index + 1).padStart(3, '0')}`,
      type: 'noul',
      instructions: instructionFor(proposition),
      claim: proposition,
      source_id: item.spans?.[0]?.source_id ?? null,
      item_id: item.id,
      item_kind: item.kind,
      _item: item,
    };
  });
  worstCaseUsd += ((estimateTokens(state.text) * (questions.length + 1) * 2) * (descriptor.pricing?.input_per_mtok ?? 0.02)) / 1e6;
  prepared.push({ fixture, input, baseline, coverage, state, questions });
}

console.log(`card generation — ${options.model} over ${prepared.length} fixture(s), ${prepared.reduce((n, f) => n + f.questions.length, 0)} question(s)`);
console.log(`  oracle digest ${oracleDigest.slice(0, 16)} (read-only, immutable)`);
console.log(`  worst case pre-flight $${worstCaseUsd.toFixed(6)} (ceiling $${options.maxUsd})`);
if (worstCaseUsd > options.maxUsd) {
  console.error('  refused: worst case exceeds the ceiling');
  process.exit(3);
}
if (options.dry) {
  for (const entry of prepared) console.log(`  ${entry.fixture}: ${entry.questions.length} question(s), state ${entry.state.text.length} chars`);
  console.log('  dry run — nothing sent');
  process.exit(0);
}

const apiKey = process.env.OPENROUTER_API_KEY;
if (!apiKey) {
  console.error('  OPENROUTER_API_KEY is not set');
  process.exit(4);
}

const slug = descriptor.id.replace(/[/:]/g, '_');
const runDir = new URL(`${options.out}/${slug}/`, ROOT);
await mkdir(runDir, { recursive: true });
let spend = 0;

for (const entry of prepared) {
  const { fixture, input, baseline, coverage, state, questions } = entry;
  const request = adapter.buildRequest({ state, questions: questions.map(({ _item, ...question }) => question) });
  const startedAt = Date.now();
  const response = await send(
    { endpoint: request.endpoint, headers: { ...request.headers, authorization: `Bearer ${apiKey}`, 'HTTP-Referer': 'https://github.com/Ai-Nspired/gca-experiment', 'X-Title': 'gca-experiment card generation' }, body: request.body },
    fetch
  );
  const latencyMs = Date.now() - startedAt;
  const record = { schema: 'gca-cardgen-run/v1', fixture, model: options.model, at: new Date().toISOString(), latency_ms: latencyMs, http: { status: response.status, ok: response.ok }, request: { endpoint: request.endpoint, body: request.body }, response_body: response.body };
  await writeFile(new URL(`${fixture}.json`, runDir), `${JSON.stringify(record, null, 2)}\n`);
  if (!response.ok) {
    console.log(`  ${fixture}: HTTP ${response.status} — recorded; answers unavailable`);
    perFixture.push({ fixture, http_ok: false, questions: questions.length });
    continue;
  }

  const normalised = normaliseResponse({ adapter, body: response.body, bank: { questions }, state });
  spend += normalised.usage?.cost_usd ?? 0;

  // Card emission: the claim is the item's verbatim statement; the model only supplies the
  // confidence gate. Below the bank's abstain floor the item is retained as unknown, never
  // silently dropped.
  const ABSTAIN_BELOW = 0.5;
  const cards = questions.map((question) => {
    const answer = extractAnswer(normalised.answers?.[question.name]);
    const item = question._item;
    const span = item.spans?.[0];
    const supported = answer.probability === null ? Boolean(answer.text) : answer.probability >= ABSTAIN_BELOW;
    return {
      item_id: item.id,
      item_kind: item.kind,
      question: question.name,
      probability: answer.probability,
      resolved: supported,
      claim: supported ? (answer.text ?? question.claim) : null,
      anchor: span ? { anchor_id: anchorId(span), item_id: item.id, source_id: span.source_id, start: span.span.start, end: span.span.end, quote: span.quote } : null,
      unknown: !supported,
      unknown_reason: supported ? null : 'model_did_not_support',
    };
  });

  // ---- stage accounting against the immutable oracle
  const required = oracle.fixtures[fixture] ?? [];
  const rows = required.map((requirement) => {
    const requiredSpans = spansOf(input, requirement.quote, requirement.source_id);
    const covering = coverage.items.filter((item) => (item.spans ?? []).some((span) => requiredSpans.some((requiredSpan) => spanOverlaps(span, requiredSpan))));
    const coveringCards = cards.filter((card) => covering.some((item) => item.id === card.item_id));
    const resolved = coveringCards.filter((card) => card.resolved);
    // Symmetric containment: a card states a requirement when either text contains the
    // other's content tokens. Directional-only under-counts a card whose quote is a whole
    // sentence carrying a shorter required phrase.
    const states = resolved.filter((card) => Math.max(overlap(card.claim, requirement.quote), overlap(requirement.quote, card.claim)) >= 0.6);
    const anchored = states.filter((card) => card.anchor && covering.some((item) => item.id === card.item_id && (item.spans ?? []).some((span) => requiredSpans.some((requiredSpan) => spanOverlaps(span, requiredSpan)))));
    return {
      id: requirement.id,
      class: requirement.class,
      quote: requirement.quote.slice(0, 80),
      s1_inventory: covering.length > 0,
      s2_question: coveringCards.length > 0,
      s3_decision: resolved.length > 0,
      s4_card_states_requirement: states.length > 0,
      s5_anchored_on_required_span: anchored.length > 0,
      s6_classifiable: anchored.length > 0,
      answer: states[0]?.claim?.slice(0, 140) ?? resolved[0]?.claim?.slice(0, 140) ?? null,
    };
  });

  perFixture.push({
    fixture,
    http_ok: true,
    questions: questions.length,
    cost_usd: normalised.usage?.cost_usd ?? null,
    stages: {
      required: rows.length,
      s1_inventory: rows.filter((row) => row.s1_inventory).length,
      s2_question: rows.filter((row) => row.s2_question).length,
      s3_decision: rows.filter((row) => row.s3_decision).length,
      s4_card_states_requirement: rows.filter((row) => row.s4_card_states_requirement).length,
      s5_anchored_on_required_span: rows.filter((row) => row.s5_anchored_on_required_span).length,
      s6_classifiable: rows.filter((row) => row.s6_classifiable).length,
    },
    unresolved: cards.filter((card) => card.unknown).map((card) => card.item_id),
    rows,
    cards,
  });
  console.log(`  ${fixture}: ${questions.length} q, $${normalised.usage?.cost_usd ?? 0}, rows ${JSON.stringify(perFixture.at(-1).stages)}`);
}

// ---------------------------------------------------------------- gates, independently

// H1: the original F3/F9 bank questions, anchored against the extended inventory.
const h1 = [];
for (const fixture of ['F3', 'F9']) {
  const entry = prepared.find((candidate) => candidate.fixture === fixture);
  if (!entry) continue;
  const bank = JSON.parse(await readFile(new URL(`banks/${fixture}.json`, ROOT), 'utf8'));
  const generated = perFixture.find((candidate) => candidate.fixture === fixture);
  const cards = generated?.cards ?? [];
  const extendedItems = [...entry.baseline.items, ...entry.coverage.items];
  // Anchoring uses the card claim only, never the question's instructions: including the
  // instructions let a relational question ("do the two documents agree...") match a
  // retention fact on the word "retention" and produced a false 1.000.
  const matchScore = (claim, item) => {
    const itemText = `${item.label} ${(item.spans ?? []).map((span) => span.quote).join(' ')}`;
    return Math.max(overlap(claim, itemText), overlap(itemText, claim));
  };
  const anchoredBy = (question) => extendedItems.filter((item) => matchScore(question.claim, item) >= 0.6);
  const baselineAnchored = (question) => entry.baseline.items.filter((item) => matchScore(question.claim, item) >= 0.6);
  const questions = bank.questions.filter((question) => question.type !== 'locate');
  h1.push({
    fixture,
    questions: questions.length,
    baseline_anchored: questions.filter((question) => baselineAnchored(question).length > 0).length,
    extended_anchored: questions.filter((question) => anchoredBy(question).length > 0).length,
    generated_cards: cards.length,
    coverage_baseline: Number((questions.filter((question) => baselineAnchored(question).length > 0).length / questions.length).toFixed(3)),
    coverage_extended: Number((questions.filter((question) => anchoredBy(question).length > 0).length / questions.length).toFixed(3)),
    still_unanchored: questions.filter((question) => anchoredBy(question).length === 0).map((question) => question.name),
  });
}

// H2: planted constraints, scored against the generated anchored cards.
const h2 = [];
for (const [fixture, plants] of Object.entries(plantsFile.fixtures ?? {})) {
  const generated = perFixture.find((candidate) => candidate.fixture === fixture);
  if (!generated?.cards) continue;
  const rows = plants.map((plant) => {
    // Direction matters: "does this card state the plant?" is the plant's content found in
    // the card, which is the same convention completeness.js uses for item coverage. Using
    // the card as the denominator penalises a card for being longer than the plant it
    // contains — the 30-day card scored 0.55 against its own subject and was counted absent.
    const scored = generated.cards
      .filter((card) => card.resolved && card.anchor)
      .map((card) => ({ card, score: overlap(plant.plant, card.claim), reverse: overlap(card.claim, plant.plant) }))
      .sort((left, right) => right.score - left.score);
    const best = scored[0];
    return {
      plant_id: plant.id,
      present: Boolean(best && best.score >= 0.6),
      overlap: best ? Number(best.score.toFixed(2)) : 0,
      overlap_reverse: best ? Number(best.reverse.toFixed(2)) : 0,
      claim: best?.card?.claim?.slice(0, 120) ?? null,
    };
  });
  h2.push({
    fixture,
    plants: rows.length,
    anchored_plant_coverage: Number((rows.filter((row) => row.present).length / rows.length).toFixed(3)),
    rows,
  });
}

const stageTotals = perFixture
  .filter((entry) => entry.stages)
  .reduce(
    (acc, entry) => {
      for (const key of Object.keys(entry.stages)) acc[key] = (acc[key] ?? 0) + entry.stages[key];
      return acc;
    },
    {}
  );

const summary = {
  schema: 'gca-cardgen-summary/v1',
  generated_at: new Date().toISOString(),
  model: options.model,
  oracle: { file: 'pilot/coverage/required-items.json', sha256: oracleDigest, immutable: true, authored_before_new_rules: oracle.authored_before_new_rules },
  spend_usd: Number(spend.toFixed(8)),
  conversion: stageTotals,
  conversion_rates: Object.fromEntries(
    Object.entries(stageTotals).map(([key, value]) => [key, stageTotals.required ? Number((value / stageTotals.required).toFixed(3)) : null])
  ),
  per_fixture: perFixture.map(({ cards, ...rest }) => rest),
  gates: {
    h1_classification_coverage: { threshold: 0.5, measured: h1, note: 'original bank questions anchored against the extended inventory; unanchored cards are the only source of unknown, so anchored fraction equals classification coverage' },
    h2_anchored_plant_coverage: { threshold: 0.6, measured: h2 },
  },
  limits: [
    'the H1 coverage figure counts anchored cards; the classifier maps every unanchored card to unknown, so anchored fraction and classification coverage coincide on this card set',
    'questions are generated from inventory items, not from the oracle, so S2 can lose items',
    'S4 uses a lexical match between the answer and the adjudicated requirement, as declared',
  ],
};

await writeFile(new URL(`${options.out}/${slug}/summary.json`, ROOT), `${JSON.stringify(summary, null, 2)}\n`);

console.log(`\nconversion (per required item)`);
for (const [key, value] of Object.entries(stageTotals)) console.log(`  ${key.padEnd(28)} ${String(value).padStart(3)}  ${stageTotals.required ? ((value / stageTotals.required) * 100).toFixed(1) + '%' : ''}`);
console.log('\nH1 gate (classification coverage, threshold 0.50)');
for (const entry of h1) console.log(`  ${entry.fixture}: baseline ${entry.coverage_baseline} → extended ${entry.coverage_extended}  (${entry.questions} questions, unanchored: ${entry.still_unanchored.join(',') || 'none'})`);
console.log('\nH2 gate (anchored plant coverage, threshold 0.60)');
for (const entry of h2) console.log(`  ${entry.fixture}: ${entry.anchored_plant_coverage}  (${entry.plants} plants)`);
console.log(`\nspend $${summary.spend_usd}`);
console.log(`wrote ${options.out}/${slug}/summary.json`);
