/**
 * The card-and-ID experiment.
 *
 * Hypothesis under test: deterministic card identities plus explicit provenance turn
 * a snapshot from a summary into reusable knowledge, so later work compounds instead
 * of restarting. Four measurements, plus the one that decides whether adding cards
 * means anything.
 *
 *   1. **ID resolution** — do cards reconnect to their source, and does identity
 *      survive editing? Tested by shifting every offset (prepend a preamble) and by
 *      revising one quoted span, then re-resolving by quote.
 *   2. **Cross-card reuse** — do multiple assessments land on the same identities?
 *      Measured across repetitions, across engines, and across the F2a–F2d variants.
 *   3. **Onboarding marginal cost** — if a new source arrives, how much of its
 *      structure is *already anchored* by existing cards? Reported as a potential
 *      saving at a measured per-question price, never as a realised one.
 *   4. **Cross-system transfer** — the precondition is identity agreement: do two
 *      engines produce the same card ids for the same source? Plus the measured
 *      transfer results already on record.
 *
 * No calls: everything is recomputed from recorded runs and the deterministic scan.
 *
 * Usage: node tools/card-id-experiment.js [--fixtures F9,F3,F2a,F2b,F2c,F2d] [--model flash-slug]
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';

import { scanInventory } from '../inventory/scan.js';
import { anchorId, identifySnapshot, resolveAnchor, verifyByFrozenLocator } from '../cards/identity.js';

const ROOT = new URL('../', import.meta.url);

const options = { fixtures: ['F9', 'F3', 'F2a', 'F2b', 'F2c', 'F2d'], out: 'runs/card-id' };
for (let index = 0; index < process.argv.length; index += 1) {
  const [flag, inline] = String(process.argv[index]).split('=');
  if (flag === '--fixtures') options.fixtures = (inline ?? process.argv[++index]).split(',');
  else if (flag === '--out') options.out = inline ?? process.argv[++index];
}

const deciders = JSON.parse(await readFile(new URL('deciders.json', ROOT), 'utf8'));
const models = deciders.models.filter((model) => model.available !== false).map((model) => model.id);
const slugOf = (id) => id.replace(/[/:]/g, '_');

const ASSERTION_KINDS = ['relationship', 'contradiction_candidate', 'unresolved_proposition', 'unclaimed_span', 'missing_connection', 'cross_source_reference'];
const ALL_KINDS = [...ASSERTION_KINDS, 'entity'];

async function loadRecord(fixture, model, rep, dir = 'runs/live') {
  try {
    const record = JSON.parse(await readFile(new URL(`${dir}/${slugOf(model)}/${fixture}.r${rep}.json`, ROOT), 'utf8'));
    return record.http?.ok ? record : null;
  } catch {
    return null;
  }
}

const perFixture = [];
const allCards = [];

for (const fixture of options.fixtures) {
  const input = JSON.parse(await readFile(new URL(`fixtures/${fixture}/input.json`, ROOT), 'utf8'));
  const survey = scanInventory(input, { maxItems: 20000 });
  const assertions = survey.items.filter((item) => ASSERTION_KINDS.includes(item.kind));

  const cards = [];
  for (const model of models) {
    for (let rep = 1; rep <= 5; rep += 1) {
      const record = await loadRecord(fixture, model, rep);
      if (!record) continue;
      for (const card of identifySnapshot({ record, survey })) {
        cards.push({ ...card, fixture, model, rep });
      }
    }
  }
  if (cards.length === 0) continue;

  // ------------------------------------------------------- 1. ID resolution

  const anchors = cards.flatMap((card) => card.anchors.map((anchor) => ({ ...anchor, card_id: card.card_id })));
  const uniqueAnchors = new Map();
  for (const anchor of anchors) uniqueAnchors.set(anchor.anchor_id, anchor);

  const resolveOn = (state) => {
    const modes = { same_offset: 0, relocated: 0, disambiguated: 0 };
    let ok = 0;
    let frozenOk = 0;
    for (const anchor of uniqueAnchors.values()) {
      const result = resolveAnchor(state, anchor);
      if (result.ok) {
        ok += 1;
        modes[result.mode] += 1;
      }
      if (verifyByFrozenLocator(state, anchor).ok) frozenOk += 1;
    }
    return { total: uniqueAnchors.size, resolved: ok, modes, frozen_locator_agrees: frozenOk };
  };

  const asRecorded = resolveOn(input);

  // Offset shift: every locator moves, identity must not.
  const shifted = {
    ...input,
    sources: input.sources.map((source) => ({
      ...source,
      content: { ...source.content, text: `PREAMBLE added for the identity test.\n${source.content?.text ?? ''}` },
    })),
  };
  const afterShift = resolveOn(shifted);
  const idsUnchangedAfterShift = [...uniqueAnchors.values()].every((anchor) => {
    const reId = anchorId({ source_id: anchor.locator.source_id, quote: anchor.quote });
    return reId === anchor.anchor_id;
  });

  // Text revision: revising the quoted text must break that identity, and only it.
  // Every occurrence is revised, so the test measures identity rather than occurrence.
  const firstAnchor = [...uniqueAnchors.values()][0];
  let revision = null;
  if (firstAnchor) {
    // Replace the quoted language, not merely append to it: appending would leave the
    // phrase detectable and the anchor id legitimately unchanged.
    const revisedText = `${firstAnchor.quote.split(/\s+/)[0]} (revised language)`;
    const mutated = {
      ...input,
      sources: input.sources.map((source) =>
        source.id === firstAnchor.locator.source_id && typeof source.content?.text === 'string'
          ? { ...source, content: { ...source.content, text: source.content.text.split(firstAnchor.quote).join(revisedText) } }
          : source
      ),
    };
    const mutatedSurvey = scanInventory(mutated, { maxItems: 20000 });
    const survivingOldId = mutatedSurvey.items.some((item) =>
      (item.spans ?? []).some((span) => anchorId(span) === firstAnchor.anchor_id)
    );
    const othersUnchanged = [...uniqueAnchors.values()]
      .filter((anchor) => anchor.anchor_id !== firstAnchor.anchor_id)
      .filter((anchor) => !mutatedSurvey.items.some((item) => (item.spans ?? []).some((span) => anchorId(span) === anchor.anchor_id)))
      .length;
    revision = {
      anchor: firstAnchor.anchor_id,
      revised_quote: revisedText.slice(0, 120),
      old_id_survives_in_rescan: survivingOldId,
      identity_changed: !survivingOldId,
      other_anchors_also_lost: othersUnchanged,
    };
  }

  // ---------------------------------------------------------- 2. cross-card reuse

  const idCounts = new Map();
  for (const card of cards) idCounts.set(card.card_id, (idCounts.get(card.card_id) ?? 0) + 1);
  const idsByModel = {};
  const idsByRep = {};
  for (const card of cards) {
    (idsByModel[card.model] ??= new Set()).add(card.card_id);
    (idsByRep[card.rep] ??= new Set()).add(card.card_id);
  }
  const modelSets = Object.values(idsByModel);
  const sharedAcrossModels = [...idCounts.keys()].filter((id) => modelSets.filter((set) => set.has(id)).length >= 2);
  const repSets = Object.values(idsByRep);
  const sharedAcrossReps = [...idCounts.keys()].filter((id) => repSets.filter((set) => set.has(id)).length >= 2);

  // ------------------------------------------------------- 4. engine agreement

  const engineAgreement = modelSets.length >= 2 ? Number((sharedAcrossModels.length / Math.max(1, idCounts.size)).toFixed(3)) : null;

  perFixture.push({
    fixture,
    cards: cards.length,
    distinct_card_ids: idCounts.size,
    cards_per_id: Number((cards.length / Math.max(1, idCounts.size)).toFixed(2)),
    unanchored_cards: cards.filter((card) => card.unanchored).length,
    anchors: {
      distinct: uniqueAnchors.size,
      cards_with_anchor: cards.filter((card) => card.anchor_ids.length > 0).length,
      resolution_unchanged: asRecorded,
      resolution_after_offset_shift: afterShift,
      ids_stable_under_offset_shift: idsUnchangedAfterShift,
      revision,
    },
    reuse: {
      ids_seen_in_multiple_models: sharedAcrossModels.length,
      ids_seen_in_multiple_repetitions: sharedAcrossReps.length,
      engine_identity_agreement: engineAgreement,
      assertion_denominator: assertions.length,
      anchored_assertion_items: new Set(
        cards.flatMap((card) => card.anchors.filter((anchor) => ASSERTION_KINDS.includes(anchor.kind)).map((anchor) => anchor.item_id))
      ).size,
      anchored_coverage: assertions.length
        ? Number(
            (new Set(cards.flatMap((card) => card.anchors.filter((anchor) => ASSERTION_KINDS.includes(anchor.kind)).map((anchor) => anchor.item_id))).size / assertions.length).toFixed(3)
          )
        : null,
    },
  });

  for (const card of cards) allCards.push(card);
}

// ------------------------------------------- coverage: does adding cards add coverage?

const broadRecord = await loadRecord('F3', 'perplexity/pplx-decider-flash-v1.2', 1, 'runs/live/broad');
const baseRecord = await loadRecord('F3', 'perplexity/pplx-decider-flash-v1.2', 1);
let coverageResponse = null;
if (broadRecord && baseRecord) {
  const input = JSON.parse(await readFile(new URL('fixtures/F3/input.json', ROOT), 'utf8'));
  const survey = scanInventory(input, { maxItems: 20000 });
  const assertions = survey.items.filter((item) => ASSERTION_KINDS.includes(item.kind));
  const narrow = identifySnapshot({ record: baseRecord, survey });
  const broad = identifySnapshot({ record: broadRecord, survey });
  const anchoredItems = (cards, kinds) =>
    new Set(cards.flatMap((card) => card.anchors.filter((a) => kinds.includes(a.kind)).map((a) => a.item_id)));
  const ratio = (count, denominator) => (denominator ? Number((count / denominator).toFixed(3)) : null);

  const narrowAssertions = anchoredItems(narrow, ASSERTION_KINDS);
  const combinedAssertions = anchoredItems([...narrow, ...broad], ASSERTION_KINDS);
  const narrowAll = anchoredItems(narrow, ALL_KINDS);
  const combinedAll = anchoredItems([...narrow, ...broad], ALL_KINDS);

  coverageResponse = {
    fixture: 'F3',
    denominator_assertions: assertions.length,
    denominator_all_items: survey.items.length,
    assertions: {
      narrow: { cards: narrow.length, anchored_items: narrowAssertions.size, coverage: ratio(narrowAssertions.size, assertions.length) },
      with_added_cards: { cards: narrow.length + broad.length, anchored_items: combinedAssertions.size, coverage: ratio(combinedAssertions.size, assertions.length) },
      added_items: combinedAssertions.size - narrowAssertions.size,
    },
    all_inventory_items: {
      narrow: { anchored_items: narrowAll.size, coverage: ratio(narrowAll.size, survey.items.length) },
      with_added_cards: { anchored_items: combinedAll.size, coverage: ratio(combinedAll.size, survey.items.length) },
      added_items: combinedAll.size - narrowAll.size,
    },
    answers_the_question: null,
    reading: null,
  };

  const grew = (block) => block.with_added_cards.anchored_items > block.narrow.anchored_items;
  coverageResponse.answers_the_question =
    grew(coverageResponse.all_inventory_items)
      ? 'yes — added cards added anchored coverage of the inventory'
      : 'no — added cards added only count';
  const broadUnanchored = broad.filter((card) => card.unanchored).length;
  coverageResponse.held_out_cards = { cards: broad.length, unanchored: broadUnanchored };
  coverageResponse.reading = grew(coverageResponse.assertions) || grew(coverageResponse.all_inventory_items)
    ? 'added cards cover more of the inventory'
    : broadUnanchored === broad.length
      ? `added cards cover nothing further because none of the ${broad.length} held-out cards could be anchored at all: the inventory emits no item for the facts they assert, so coverage is bounded by the inventory rather than by card count`
      : `added cards anchored ${broad.length - broadUnanchored} item(s) but none outside the existing set`;
}

// --------------------------------------------------- 3. onboarding marginal cost

const flashF2a = await loadRecord('F2a', 'perplexity/pplx-decider-flash-v1.2', 1);
const perQuestionUsd = flashF2a ? Number(((flashF2a.normalised.usage.cost_usd ?? 0) / Object.keys(flashF2a.request.body.questions).length).toFixed(8)) : null;

const onboarding = [];
for (const entry of perFixture) {
  const others = perFixture.filter((other) => other.fixture !== entry.fixture);
  const fixtureCards = allCards.filter((card) => card.fixture === entry.fixture);
  const ownAnchors = new Set(fixtureCards.flatMap((card) => card.anchor_ids));
  const priorAnchors = new Set(
    allCards
      .filter((card) => others.some((other) => other.fixture === card.fixture))
      .flatMap((card) => card.anchor_ids)
  );
  const reused = [...ownAnchors].filter((id) => priorAnchors.has(id));
  onboarding.push({
    fixture: entry.fixture,
    anchors: ownAnchors.size,
    anchors_already_known_from_another_fixture: reused.length,
    reuse_fraction: ownAnchors.size ? Number((reused.length / ownAnchors.size).toFixed(3)) : null,
    potential_questions_skipped: reused.length,
    potential_saving_usd: perQuestionUsd === null ? null : Number((reused.length * perQuestionUsd).toFixed(8)),
    caveat: 'upper bound: an anchor known from another source does not mean the question is unnecessary, only that its evidence is already identified',
  });
}

const f2Variants = ['F2a', 'F2b', 'F2c', 'F2d'];
const variantSets = new Map();
for (const card of allCards) {
  if (!f2Variants.includes(card.fixture)) continue;
  if (!variantSets.has(card.fixture)) variantSets.set(card.fixture, new Set());
  variantSets.get(card.fixture).add(card.card_id);
}
const variantOverlap = [];
for (let i = 0; i < f2Variants.length; i += 1) {
  for (let j = i + 1; j < f2Variants.length; j += 1) {
    const left = variantSets.get(f2Variants[i]);
    const right = variantSets.get(f2Variants[j]);
    if (!left || !right) continue;
    const shared = [...left].filter((id) => right.has(id)).length;
    variantOverlap.push({
      pair: `${f2Variants[i]}~${f2Variants[j]}`,
      left_ids: left.size,
      right_ids: right.size,
      shared,
      jaccard: Number((shared / (left.size + right.size - shared)).toFixed(3)),
    });
  }
}

const summary = {
  schema: 'gca-card-id-experiment/v1',
  generated_at: new Date().toISOString(),
  hypothesis:
    'deterministic card identity plus explicit provenance makes knowledge reusable across assessments, engines, fixtures and systems, so later onboarding compounds instead of restarting',
  spend: 0,
  source: 'recorded runs only; no calls',
  identity: {
    anchor_definition: 'digest(source_id, normalised quote) — content-addressed',
    card_definition: 'digest(normalised claim, sorted anchor ids) — probabilities and run metadata excluded',
    assigned_by: 'assembly, from operator-authored bank text against a deterministic scan; never by a model',
  },
  per_fixture: perFixture,
  coverage_response: coverageResponse,
  cross_fixture_reuse: { variants: variantOverlap },
  onboarding,
  per_question_cost_reference_usd: perQuestionUsd,
  transfer_already_measured: {
    delta_questions_across_two_fixtures: '6/6 across four engines (LIVE-RUN-01 §13, §14)',
    heldout_substitution: '1/6 to 2/8 genuine retention — transfer is claim-scoped, not knowledge-scoped',
  },
  limits: [
    'Anchor quality is bounded by the same lexical matcher used for completeness; an anchor is as good as the bank claim naming the inventory item.',
    'F2a–F2d are variants of one source, so their overlap is an upper bound on cross-source reuse, not a typical one.',
    'Onboarding savings are potential, computed at a measured per-question price; nothing here re-ran a bank to realise them.',
    'No ARA or AA exists in this repository, so cross-system transfer is measured at the identity and decision level only.',
  ],
};

await mkdir(new URL(`${options.out}/`, ROOT), { recursive: true });
await writeFile(new URL(`${options.out}/experiment.json`, ROOT), `${JSON.stringify(summary, null, 2)}\n`);

// -------------------------------------------------------------------- console

console.log('1. id resolution');
for (const entry of perFixture) {
  const a = entry.anchors;
  console.log(
    `   ${entry.fixture.padEnd(4)} anchors ${String(a.distinct).padStart(3)}  cards-with-anchor ${a.cards_with_anchor}/${entry.cards}  unanchored ${entry.unanchored_cards}` +
      `  resolve ${a.resolution_unchanged.resolved}/${a.resolution_unchanged.total} (${JSON.stringify(a.resolution_unchanged.modes)})` +
      `  after-shift ${a.resolution_after_offset_shift.resolved}/${a.resolution_after_offset_shift.total} (${JSON.stringify(a.resolution_after_offset_shift.modes)})` +
      `  ids stable ${a.ids_stable_under_offset_shift}` +
      (a.revision ? `  revision breaks identity ${a.revision.identity_changed}${a.revision.other_anchors_also_lost === 0 ? ' (no collateral loss)' : ` (collateral ${a.revision.other_anchors_also_lost})`}` : '')
  );
}

console.log('\n2. cross-card reuse');
for (const entry of perFixture) {
  console.log(
    `   ${entry.fixture.padEnd(4)} cards ${String(entry.cards).padStart(3)}  distinct ids ${String(entry.distinct_card_ids).padStart(3)}  cards/id ${entry.cards_per_id}` +
      `  ids in ≥2 engines ${entry.reuse.ids_seen_in_multiple_models}  ids in ≥2 reps ${entry.reuse.ids_seen_in_multiple_repetitions}` +
      `  anchored coverage ${entry.reuse.anchored_coverage === null ? 'n/a' : entry.reuse.anchored_coverage}`
  );
}

console.log('\n3. onboarding marginal cost (potential)');
for (const entry of onboarding) {
  console.log(
    `   ${entry.fixture.padEnd(4)} anchors ${String(entry.anchors).padStart(3)}  already known elsewhere ${String(entry.anchors_already_known_from_another_fixture).padStart(3)}` +
      `  reuse ${entry.reuse_fraction === null ? 'n/a' : entry.reuse_fraction}  potential saving $${entry.potential_saving_usd ?? 'n/a'}`
  );
}
console.log('   cross-fixture (F2a–F2d variants):');
for (const pair of variantOverlap) console.log(`     ${pair.pair}  shared ${pair.shared}/${pair.right_ids}  jaccard ${pair.jaccard}`);

console.log('\n4. engine identity agreement (precondition for transfer)');
for (const entry of perFixture) console.log(`   ${entry.fixture.padEnd(4)} ${entry.reuse.engine_identity_agreement === null ? 'n/a' : entry.reuse.engine_identity_agreement}`);

console.log('\ncoverage: does adding cards add coverage?');
if (coverageResponse) {
  const a = coverageResponse.assertions;
  const b = coverageResponse.all_inventory_items;
  console.log(
    `   F3 assertions (${coverageResponse.denominator_assertions}): ${a.narrow.cards} cards → ${a.narrow.anchored_items} (${a.narrow.coverage});` +
      ` +${a.with_added_cards.cards - a.narrow.cards} cards → ${a.with_added_cards.anchored_items} (${a.with_added_cards.coverage})`
  );
  console.log(
    `   F3 all items (${coverageResponse.denominator_all_items}): ${b.narrow.anchored_items} (${b.narrow.coverage}); +cards → ${b.with_added_cards.anchored_items} (${b.with_added_cards.coverage})`
  );
  console.log(`   → ${coverageResponse.answers_the_question}`);
  console.log(`     ${coverageResponse.reading}`);
} else {
  console.log('   no broad record available');
}

console.log(`\nwrote ${options.out}/experiment.json`);
