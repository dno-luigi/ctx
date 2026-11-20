/**
 * Controlled-edit state classification.
 *
 * Applies a small, declared edit to a fixture's sources, then re-scans and asks of every
 * card in an existing snapshot: is this card **preserved**, **changed**, **superseded**
 * or **unknown**?
 *
 * The four words are given structural meanings, so nothing here depends on a model's
 * judgement:
 *
 *   preserved   every anchor still resolves to text containing the same quote
 *   changed     an anchor's quote is gone, but at least 60% of its content tokens survive
 *               in the edited source — the assertion's language is still there, altered
 *   superseded  an anchor's quote is gone and its language is gone with it
 *   unknown     the card carries no anchor, so no state can be established
 *
 * Being unable to classify the unanchored cards is the point: `unknown` is a real,
 * counted outcome, not a failure to report one. The same run measures whether the edit
 * created inventory items that no card covers — detectable omission at item level.
 *
 * No model calls. Everything is deterministic.
 *
 * Usage: node tools/identity-states.js [--fixture F3] [--model perplexity/pplx-decider-flash-v1.2] [--rep 1]
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';

import { scanInventory } from '../inventory/scan.js';
import { anchorId, identifySnapshot, resolveAnchor } from '../cards/identity.js';

const ROOT = new URL('../', import.meta.url);

const options = { fixture: 'F3', model: 'perplexity/pplx-decider-flash-v1.2', rep: 1, out: 'runs/identity-states/v2', expected: 'runs/identity-states/expected.json' };
for (let index = 0; index < process.argv.length; index += 1) {
  const [flag, inline] = String(process.argv[index]).split('=');
  if (flag === '--fixture') options.fixture = inline ?? process.argv[++index];
  else if (flag === '--model') options.model = inline ?? process.argv[++index];
  else if (flag === '--rep') options.rep = Number(inline ?? process.argv[++index]);
  else if (flag === '--out') options.out = inline ?? process.argv[++index];
  else if (flag === '--expected') options.expected = inline ?? process.argv[++index];
}

/**
 * Declared edits. Each names the source, the exact text, and what the edit is *for*, so
 * the expected effect is a prediction made before the result is seen.
 */
const EDITS = {
  F3: [
    { id: 'A_value_change', source_id: 's1', find: 'retained for 30 days', replace: 'retained for 45 days', intent: 'change a value inside an anchored sentence' },
    { id: 'B_revision_bump', source_id: 's1', find: 'revision 12', replace: 'revision 13', intent: 'bump a revision number in an anchored header' },
    { id: 'C_deletion', source_id: 's2', find: ' Nothing is deleted before that window closes.', replace: '', intent: 'delete an entire clause' },
  ],
  F9: [
    { id: 'D_second_occurrence', source_id: 's1', find: '88113', replace: '90420', occurrence: 'last', intent: 'change the value in the second occurrence of a repeated line' },
  ],
};

const SLUG = options.model.replace(/[/:]/g, '_');
const input = JSON.parse(await readFile(new URL(`fixtures/${options.fixture}/input.json`, ROOT), 'utf8'));
const record = JSON.parse(await readFile(new URL(`runs/live/${SLUG}/${options.fixture}.r${options.rep}.json`, ROOT), 'utf8'));

const surveyBefore = scanInventory(input, { maxItems: 20000 });
const itemsById = new Map(surveyBefore.items.map((item) => [item.id, item]));
const cards = identifySnapshot({ record, survey: surveyBefore });

// ---------------------------------------------------------------- apply the edits

function applyEdits(source, edits) {
  let text = source.content?.text ?? '';
  const applied = [];
  for (const edit of edits) {
    if (edit.occurrence === 'last') {
      const at = text.lastIndexOf(edit.find);
      if (at === -1) { applied.push({ ...edit, applied: false }); continue; }
      text = text.slice(0, at) + edit.replace + text.slice(at + edit.find.length);
      applied.push({ ...edit, applied: true, at });
      continue;
    }
    const at = text.indexOf(edit.find);
    if (at === -1) { applied.push({ ...edit, applied: false }); continue; }
    text = text.slice(0, at) + edit.replace + text.slice(at + edit.find.length);
    applied.push({ ...edit, applied: true, at });
  }
  return { text, applied };
}

const edits = EDITS[options.fixture] ?? [];
const edited = {
  ...input,
  sources: input.sources.map((source) => {
    const relevant = edits.filter((edit) => edit.source_id === source.id);
    if (relevant.length === 0) return source;
    const { text, applied } = applyEdits(source, relevant);
    source.__applied = applied;
    return { ...source, content: { ...source.content, text } };
  }),
};
const appliedEdits = input.sources.flatMap((source) => source.__applied ?? []);
const surveyAfter = scanInventory(edited, { maxItems: 20000 });

// Where each edit landed, so a card's basis can say whether its anchor was even in scope.
const editRegions = appliedEdits
  .filter((edit) => edit.applied && typeof edit.at === 'number')
  .map((edit) => ({ edit_id: edit.id, source_id: edit.source_id, start: edit.at, end: edit.at + (edit.replace?.length ?? 0) }));

const expectedFile = JSON.parse(await readFile(new URL(options.expected, ROOT), 'utf8').catch(() => '{"fixtures":{}}'));
const expected = expectedFile.fixtures?.[options.fixture]?.cards ?? null;

// ------------------------------------------------------------- classify the anchors

const contentTokens = (text) =>
  new Set(
    String(text ?? '')
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((token) => token.length >= 4)
  );

function classifyAnchor(anchor) {
  const result = resolveAnchor(edited, anchor);
  if (result.ok) return { state: 'preserved', mode: result.mode };

  const source = edited.sources.find((entry) => entry.id === anchor.locator.source_id);
  // No source at all means no basis for a state; that is not the same as "gone".
  if (!source) return { state: 'unresolvable', item_id: anchor.item_id, item_kind: anchor.kind };
  const text = (source?.content?.text ?? '').toLowerCase();
  const tokens = contentTokens(anchor.quote);
  const surviving = [...tokens].filter((token) => text.includes(token)).length;
  const ratio = tokens.size ? surviving / tokens.size : 0;
  return {
    state: ratio >= 0.6 ? 'changed' : 'superseded',
    surviving_token_ratio: Number(ratio.toFixed(2)),
    item_id: anchor.item_id,
    item_kind: anchor.kind,
  };
}

const ORDER = { preserved: 0, changed: 1, superseded: 2, unresolvable: 3, unknown: 4 };
// Exact overlap only. A deletion is a zero-length region, so an anchor touching that point counts.
const inEditRegion = (anchor) =>
  editRegions.some(
    (region) =>
      region.source_id === anchor.locator.source_id &&
      (region.end === region.start
        ? anchor.locator.start <= region.start && anchor.locator.end >= region.start
        : anchor.locator.start < region.end && anchor.locator.end > region.start)
  );

const classified = cards.map((card) => {
  if (card.anchor_ids.length === 0) {
    return { oid: card.oid, card_id: card.card_id, claim: card.claim, state: 'unknown', unknown_reason: 'no_anchor', basis: 'unanchored', anchors: [] };
  }
  const anchors = card.anchors.map((anchor) => ({ ...anchor, ...classifyAnchor(anchor), in_edit_region: inEditRegion(anchor) }));
  const worst = (key) => anchors.reduce((acc, anchor) => (ORDER[anchor[key]] > ORDER[acc] ? anchor[key] : acc), 'preserved');
  const unresolvable = anchors.some((anchor) => anchor.state === 'unresolvable');
  const state = unresolvable ? 'unknown' : worst('state');
  return {
    oid: card.oid,
    card_id: card.card_id,
    claim: card.claim,
    state,
    unknown_reason: unresolvable ? 'anchor_unresolvable' : undefined,
    basis: anchors.some((anchor) => anchor.in_edit_region) ? 'anchored_in_edit_region' : 'anchored_outside_edit_region',
    anchors,
  };
});

const tally = (rows) =>
  ['preserved', 'changed', 'superseded', 'unknown'].reduce((acc, state) => {
    acc[state] = rows.filter((row) => row.state === state).length;
    return acc;
  }, {});

// --------------------------------------------------- dependents and item-level omission

const changedAnchorIds = new Set(
  classified.flatMap((row) => row.anchors.filter((anchor) => anchor.state !== 'preserved').map((anchor) => anchor.anchor_id))
);

const dependents = [];
for (const anchorIdValue of changedAnchorIds) {
  const affected = classified.filter((row) => row.anchors.some((anchor) => anchor.anchor_id === anchorIdValue));
  dependents.push({
    anchor_id: anchorIdValue,
    cards_sharing_this_anchor: affected.length,
    distinct_card_ids: new Set(affected.map((row) => row.card_id)).size,
    distinct_questions: [...new Set(affected.map((row) => row.oid))],
    states: tally(affected.map((row) => ({ state: row.state }))),
  });
}

const anchoredItemIds = new Set(cards.flatMap((card) => card.anchors.map((anchor) => anchor.item_id)));
const beforeItemIds = new Set(surveyBefore.items.map((item) => item.id));
const newItemIds = surveyAfter.items.filter((item) => !beforeItemIds.has(item.id)).map((item) => item.id);
const uncoveredAfter = surveyAfter.items.filter((item) => !anchoredItemIds.has(item.id)).map((item) => item.id);
const uncoveredNew = newItemIds.filter((id) => !anchoredItemIds.has(id));

// ------------------------------------------------- accuracy against independent adjudication

let accuracy = null;
if (expected) {
  const rows = classified.map((row) => ({
    oid: row.oid,
    expected: expected[row.oid]?.expected_state ?? null,
    actual: row.state,
    basis: row.basis,
    unknown_reason: row.unknown_reason ?? null,
  }));
  const adjudicated = rows.filter((row) => row.expected !== null);
  const classifiedRows = adjudicated.filter((row) => row.actual !== 'unknown');
  const unknownRows = adjudicated.filter((row) => row.actual === 'unknown');
  accuracy = {
    adjudicated: adjudicated.length,
    classified: classifiedRows.length,
    classified_correct: classifiedRows.filter((row) => row.actual === row.expected).length,
    accuracy_over_classified: classifiedRows.length
      ? Number((classifiedRows.filter((row) => row.actual === row.expected).length / classifiedRows.length).toFixed(3))
      : null,
    // The expensive failure: the source changed in a way that affects the card, and the
    // system could not say so. Counted separately from accuracy, never folded into it.
    affected_but_unknown: unknownRows.filter((row) => row.expected !== 'preserved' && row.expected !== 'unknown').length,
    expected_unknown_correctly: unknownRows.filter((row) => row.expected === 'unknown').length,
    wrongly_unknown: unknownRows.filter((row) => row.expected === 'preserved').length,
    spurious_classification: classifiedRows.filter((row) => row.expected === 'unknown').length,
    disagreements: adjudicated.filter((row) => row.actual !== row.expected).map((row) => ({ oid: row.oid, expected: row.expected, actual: row.actual, basis: row.basis, unknown_reason: row.unknown_reason })),
    // Four-way diagnostic. A single accuracy number hides the difference between a system
    // that abstains safely and one that asserts wrongly; these are counted separately.
    confusion: {
      correctly_classified: adjudicated.filter((row) => row.actual !== 'unknown' && row.actual === row.expected).length,
      correctly_abstained: adjudicated.filter((row) => row.actual === 'unknown' && row.expected === 'unknown').length,
      incorrectly_classified: adjudicated.filter((row) => row.actual !== 'unknown' && row.actual !== row.expected).length,
      incorrectly_abstained: adjudicated.filter((row) => row.actual === 'unknown' && row.expected !== 'unknown').length,
    },
  };
}

const unknownReasons = classified
  .filter((row) => row.state === 'unknown')
  .reduce((acc, row) => {
    const key = row.unknown_reason ?? 'unstated';
    acc[key] = (acc[key] ?? 0) + 1;
    return acc;
  }, {});

const byQuestion = {};
for (const row of classified) {
  (byQuestion[row.oid] ??= []).push(row.state);
}
const questionStates = Object.fromEntries(
  Object.entries(byQuestion).map(([oid, states]) => [
    oid,
    {
      state: states.reduce((worst, state) => (ORDER[state] > ORDER[worst] ? state : worst), 'preserved'),
      counts: tally(states.map((state) => ({ state }))),
    },
  ])
);

const summary = {
  schema: 'gca-identity-states/v1',
  generated_at: new Date().toISOString(),
  fixture: options.fixture,
  model: options.model,
  rep: options.rep,
  spend: 0,
  declared_edits: appliedEdits.map(({ source_id, find, replace, intent, applied, occurrence }) => ({ source_id, find, replace, intent, applied, occurrence: occurrence ?? 'first' })),
  definitions: {
    preserved: 'every anchor still resolves to text containing the same quote',
    changed: 'anchor quote gone, but ≥60% of its content tokens survive in the edited source',
    superseded: 'anchor quote gone and its language gone with it',
    unknown: 'card carries no anchor, so no state can be established',
  },
  cards: { total: cards.length, ...tally(classified) },
  classification: {
    coverage: cards.length ? Number(((cards.length - classified.filter((row) => row.state === 'unknown').length) / cards.length).toFixed(3)) : null,
    unknown_reasons: unknownReasons,
    bases: classified.reduce((acc, row) => { acc[row.basis] = (acc[row.basis] ?? 0) + 1; return acc; }, {}),
    accuracy,
  },
  edit_regions: editRegions,
  questions: questionStates,
  per_card: classified,
  dependents: {
    anchors_touched: changedAnchorIds.size,
    fan_out: dependents,
    cards_affected_total: classified.filter((row) => row.state !== 'preserved' && row.state !== 'unknown').length,
  },
  omission: {
    items_before: surveyBefore.items.length,
    items_after: surveyAfter.items.length,
    new_items_from_edit: newItemIds.length,
    new_item_ids: newItemIds,
    anchored_items: anchoredItemIds.size,
    uncovered_items_after: uncoveredAfter.length,
    uncovered_new_items: uncoveredNew.length,
    detectable: uncoveredNew.length > 0,
  },
};

await mkdir(new URL(`${options.out}/`, ROOT), { recursive: true });
await writeFile(new URL(`${options.out}/${options.fixture}.json`, ROOT), `${JSON.stringify(summary, null, 2)}\n`);

console.log(`controlled edit → ${options.fixture} (${options.model})`);
for (const edit of summary.declared_edits) console.log(`  ${edit.applied ? 'applied' : 'NOT APPLIED'}  ${edit.source_id} "${edit.find}" → "${edit.replace}"  (${edit.intent})`);
console.log(`\ncards ${cards.length}: preserved ${summary.cards.preserved}  changed ${summary.cards.changed}  superseded ${summary.cards.superseded}  unknown ${summary.cards.unknown}`);
console.log(`coverage ${summary.classification.coverage}  unknown reasons ${JSON.stringify(unknownReasons)}  bases ${JSON.stringify(summary.classification.bases)}`);
if (accuracy) {
  console.log(
    `accuracy over classified ${accuracy.classified_correct}/${accuracy.classified} = ${accuracy.accuracy_over_classified}` +
      `  affected-but-unknown ${accuracy.affected_but_unknown}  wrongly-unknown ${accuracy.wrongly_unknown}  spurious ${accuracy.spurious_classification}`
  );
  for (const row of accuracy.disagreements) console.log(`  disagreement ${row.oid}: expected ${row.expected}, actual ${row.actual} (${row.basis}${row.unknown_reason ? `, ${row.unknown_reason}` : ''})`);
}
for (const [oid, entry] of Object.entries(questionStates)) {
  console.log(`  ${oid.padEnd(24)} ${entry.state}`);
}
console.log(`\ndependents: ${changedAnchorIds.size} anchor(s) touched, ${summary.dependents.cards_affected_total} card(s) affected`);
for (const entry of dependents) {
  console.log(`  ${entry.anchor_id.slice(0, 26)}  cards ${entry.cards_sharing_this_anchor}  distinct ids ${entry.distinct_card_ids}  questions ${entry.distinct_questions.join(',')}`);
}
console.log(`\nomission: items ${surveyBefore.items.length} → ${surveyAfter.items.length} (+${newItemIds.length} from the edit), uncovered after edit ${uncoveredAfter.length}, newly uncovered ${uncoveredNew.length}, detectable ${summary.omission.detectable}`);
console.log(`\nwrote ${options.out}/${options.fixture}.json`);
