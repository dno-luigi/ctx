/**
 * Inventory identity experiment.
 *
 * The question: can the inventory maintain a reliable model of *what changed*? Three
 * strategies, same data, same three controlled edits on F3 and the repeated-line edit on
 * F9. Nothing here changes the state classifier or any pilot threshold; this tool only
 * assigns identifiers and observes what happens to them across an edit.
 *
 *   S1 positional          `inv_0001` by scan order — the current scheme
 *   S2 content             digest(kind, label, sorted normalised span quotes)
 *   S3 content+occurrence  S2 plus an occurrence index per span, plus a revision registry
 *                          that links a new identity to the identity it replaced
 *
 * Assertions, all evaluated per transition:
 *   a. an edit creates a distinguishable new identity or revision
 *   b. the prior identity remains traceable
 *   c. a deletion produces an identifiable missing item
 *   d. unchanged items retain identity
 *   e. repeated identical lines do not collapse into one item
 *
 * S2 is deliberately the naive content-addressing, because its failure on (e) is the
 * thing that decides whether occurrence context has to be part of the identity.
 *
 * Usage: node tools/inventory-identity.js [--out runs/inventory-identity]
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';

import { digest, normalizeClaim } from '../src/canonical.js';
import { scanInventory } from '../inventory/scan.js';

const ROOT = new URL('../', import.meta.url);
const options = { out: 'runs/inventory-identity' };
for (let index = 0; index < process.argv.length; index += 1) {
  const [flag, inline] = String(process.argv[index]).split('=');
  if (flag === '--out') options.out = inline ?? process.argv[++index];
}

/** The same edits the state classifier uses. Declared once, applied in sequence. */
const EDITS = {
  F3: [
    { id: 'E1_value_change', source_id: 's1', find: 'retained for 30 days', replace: 'retained for 45 days', intent: 'in-place value change inside an item' },
    { id: 'E2_revision_bump', source_id: 's1', find: 'revision 12', replace: 'revision 13', intent: 'revision bump in an item header' },
    { id: 'E3_deletion', source_id: 's2', find: ' Nothing is deleted before that window closes.', replace: '', intent: 'delete a whole clause' },
  ],
  F9: [
    { id: 'E1_second_occurrence', source_id: 's1', find: '88113', replace: '90420', occurrence: 'last', intent: 'change the value in the second occurrence of a repeated line' },
  ],
};

/** Replace the first or last occurrence; return the edited source plus the changed range. */
function applyEdit(source, edit) {
  const text = source.content?.text ?? '';
  const at = edit.occurrence === 'last' ? text.lastIndexOf(edit.find) : text.indexOf(edit.find);
  if (at === -1) return { text, range: null, applied: false };
  const next = text.slice(0, at) + edit.replace + text.slice(at + edit.find.length);
  return { text: next, range: { source_id: source.id, start: at, end_before: at + edit.find.length, end_after: at + edit.replace.length }, applied: true };
}

function occurrenceIndex(text, quote, start) {
  let count = 0;
  for (let at = text.indexOf(quote); at !== -1 && at < start; at = text.indexOf(quote, at + 1)) count += 1;
  return count;
}

const normalisedSpans = (item) =>
  (item.spans ?? []).map((span) => `${span.source_id}:${normalizeClaim(span.quote)}`).sort().join('|');

const occurrenceSpans = (item, sources) =>
  (item.spans ?? [])
    .map((span) => {
      const text = sources.find((source) => source.id === span.source_id)?.content?.text ?? '';
      const occ = occurrenceIndex(text, span.quote, span.span?.start ?? span.start ?? 0);
      return `${span.source_id}:${normalizeClaim(span.quote)}#${occ}`;
    })
    .sort()
    .join('|');

function idFor(strategy, item, index, input) {
  const base = `${item.kind}|${normalizeClaim(item.label ?? '')}`;
  if (strategy === 'positional') return `inv_${String(index + 1).padStart(4, '0')}`;
  if (strategy === 'content') return `cinv_${digest({ base, spans: normalisedSpans(item) }).slice(0, 16)}`;
  return `civ_${digest({ base, spans: occurrenceSpans(item, input.sources) }).slice(0, 16)}`;
}

function indexInventory(strategy, input) {
  const survey = scanInventory(input, { maxItems: 20000 });
  const byId = new Map();
  const rows = [];
  survey.items.forEach((item, index) => {
    const id = idFor(strategy, item, index, input);
    const spans = (item.spans ?? []).map((span) => ({ source_id: span.source_id, start: span.span.start, quote: span.quote }));
    rows.push({ index, id, kind: item.kind, label: item.label ?? '', spans, signature: `${item.kind}|${normalisedSpans(item)}` });
    if (!byId.has(id)) byId.set(id, { id, kind: item.kind, label: item.label ?? '', signatures: new Set(), spans: [] });
    const record = byId.get(id);
    record.signatures.add(`${item.kind}|${normalisedSpans(item)}`);
    record.spans.push(...spans);
  });
  return { survey, byId, rows };
}

/**
 * Collapse has two kinds and they are not the same failure:
 *
 *   duplicate_merges  two scan items with identical evidence landing on one identity —
 *                     benign de-duplication, and a sign the inventory emits redundant items
 *   repeat_merges     one identity covering two *occurrences* of the same text — the harmful
 *                     kind, because the two occurrences can diverge and one identity cannot
 *                     represent both
 *
 * Measured by grouping the positional scan entries under each strategy's identifiers.
 */
function collapseReport(strategy, input) {
  const positional = indexInventory('positional', input);
  const groups = new Map();
  for (const row of positional.rows) {
    const id = idFor(strategy, row, row.index, input);
    if (!groups.has(id)) groups.set(id, []);
    groups.get(id).push(row);
  }
  const merged = [...groups.entries()].filter(([, rows]) => rows.length > 1);
  const duplicateMerges = [];
  const repeatMerges = [];
  for (const [id, rows] of merged) {
    const signatures = new Set(rows.map((row) => row.signature));
    const offsets = new Set(rows.flatMap((row) => row.spans.map((span) => `${span.source_id}:${span.start}`)));
    const quotes = new Set(rows.flatMap((row) => row.spans.map((span) => normalizeClaim(span.quote))));
    if (signatures.size === 1) duplicateMerges.push({ id, items: rows.map((row) => row.index), kind: rows[0].kind });
    else if (quotes.size < offsets.size) repeatMerges.push({ id, items: rows.map((row) => row.index), kind: rows[0].kind });
  }
  return {
    merged_groups: merged.length,
    duplicate_merges: duplicateMerges,
    repeat_merges: repeatMerges,
    repeats_not_collapsed: repeatMerges.length === 0,
  };
}

const tokens = (text) =>
  new Set(
    String(text ?? '')
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((token) => token.length >= 4)
  );

function overlap(a, b) {
  const left = tokens(a);
  const right = tokens(b);
  if (left.size === 0 || right.size === 0) return 0;
  let shared = 0;
  for (const token of left) if (right.has(token)) shared += 1;
  return shared / left.size;
}

/** Parse-key content signature, ignoring identifiers. */
const signatureOf = (record) => [...record.signatures].sort().join('||');

/**
 * Evaluate the five assertions, with `null` for genuinely untestable ones.
 *
 * A vacuous "yes" is worse than an honest "not applicable", and this fixture set has two
 * cases where the edit is not covered by any inventory item at all. Those must be reported
 * as coverage failures, not as identity-strategy successes or failures.
 */
function assertionsFor({ transitions, deletionEdit, collapse, edits }) {
  const reasons = {};
  const totalNew = transitions.reduce((sum, transition) => sum + transition.new, 0);
  const totalLinks = transitions.reduce((sum, transition) => sum + transition.links, 0);
  const totalRetired = transitions.reduce((sum, transition) => sum + transition.retired, 0);
  const reassigned = transitions.reduce((sum, transition) => sum + transition.reassigned, 0);
  const editTouchesItems = totalNew > 0 || totalRetired > 0 || reassigned > 0;
  const hasDeletion = edits.some((edit) => edit.replace === '');

  let a = null;
  if (!editTouchesItems) {
    reasons.a = 'no inventory item covers the edited text, so no identity could change';
  } else {
    a = transitions
      .filter((transition) => transition.new > 0 || transition.reassigned > 0)
      .every((transition) => transition.reassigned === 0 && (transition.new > 0 || transition.links > 0));
  }

  let b = null;
  if (totalNew === 0) reasons.b = 'no new identity was created, so there is nothing to trace';
  else b = totalLinks === totalNew;

  let c = null;
  if (!hasDeletion) reasons.c = 'this fixture declares no deletion edit';
  else if (totalRetired === 0) reasons.c = 'the deleted text has no inventory item, so nothing can go missing';
  else c = Boolean(deletionEdit && deletionEdit.missing.length > 0);

  const d = transitions.every((transition) => transition.reassigned === 0);
  const e = collapse.repeat_merges.length === 0;

  return { a_edit_creates_distinguishable_identity: a, b_prior_identity_traceable: b, c_deletion_identifiable: c, d_unchanged_retain_identity: d, e_repeats_not_collapsed: e, reasons };
}

function compare(before, after, strategy, registry) {
  const stable = [];
  const reassigned = [];
  const newIds = [];
  const retired = [];

  for (const [id, record] of after.byId) {
    if (!before.byId.has(id)) newIds.push(id);
    else if (signatureOf(before.byId.get(id)) === signatureOf(record)) stable.push(id);
    else reassigned.push(id);
  }
  for (const id of before.byId.keys()) if (!after.byId.has(id)) retired.push(id);

  // Revision registry: one-to-one linking of each new identity to the identity it
  // replaced, by token overlap of the whole evidence text, same kind only. Greedy
  // assignment so that three new identities cannot all claim the same predecessor.
  const quoteText = (record) => record.spans.map((span) => span.quote).join(' ');
  const candidates = [];
  for (const newId of newIds) {
    const record = after.byId.get(newId);
    for (const oldId of retired) {
      const candidate = before.byId.get(oldId);
      if (candidate.kind !== record.kind) continue;
      const score = overlap(quoteText(record), quoteText(candidate));
      if (score >= 0.5) candidates.push({ newId, oldId, score });
    }
  }
  candidates.sort((left, right) => right.score - left.score);
  const links = [];
  const takenNew = new Set();
  const takenOld = new Set();
  for (const candidate of candidates) {
    if (takenNew.has(candidate.newId) || takenOld.has(candidate.oldId)) continue;
    takenNew.add(candidate.newId);
    takenOld.add(candidate.oldId);
    links.push({ new_id: candidate.newId, revision_of: candidate.oldId, similarity: Number(candidate.score.toFixed(2)) });
    registry.set(candidate.newId, { revision_of: candidate.oldId, generation: (registry.get(candidate.oldId)?.generation ?? 0) + 1 });
  }
  const linkedOld = new Set(links.map((link) => link.revision_of));

  return {
    stable: stable.length,
    reassigned: reassigned.length,
    reassigned_ids: reassigned,
    reassigned_detail: reassigned.map((id) => ({ id, label: before.byId.get(id)?.label ?? '' })),
    new: newIds.length,
    retired: retired.length,
    retired_ids: retired,
    links: links.length,
    // (c): a retired identity with no successor is an identifiable missing item.
    missing: retired.filter((id) => !linkedOld.has(id)),
    counts: { before: before.byId.size, after: after.byId.size },
  };
}

const results = [];

for (const fixture of ['F3', 'F9']) {
  const original = JSON.parse(await readFile(new URL(`fixtures/${fixture}/input.json`, ROOT), 'utf8'));

  // Sequential states so the revision history has something to be a history of.
  const states = [{ label: 'original', input: original }];
  let current = original;
  for (const edit of EDITS[fixture] ?? []) {
    const next = { ...current, sources: current.sources.map((source) => (source.id === edit.source_id ? { ...source, content: { ...source.content, text: applyEdit(source, edit).text } } : source)) };
    current = next;
    states.push({ label: edit.id, input: next, edit });
  }

  for (const strategy of ['positional', 'content', 'content_occurrence']) {
    const registry = new Map();
    let previous = indexInventory(strategy, states[0].input);
    const transitions = [];
    const originalIndex = previous;

    for (let index = 1; index < states.length; index += 1) {
      const nextIndex = indexInventory(strategy, states[index].input);
      const diff = compare(previous, nextIndex, strategy, registry);
      transitions.push({ edit: states[index].label, ...diff });
      previous = nextIndex;
    }

    // (e) collapse, split into the benign and harmful kinds.
    const collapse = collapseReport(strategy, states[0].input);

    // Offset shift: identity must survive text inserted above every offset, and the
    // surviving identity must still describe the same evidence.
    const shifted = {
      ...states[0].input,
      sources: states[0].input.sources.map((source) => ({ ...source, content: { ...source.content, text: `PREAMBLE.\n${source.content?.text ?? ''}` } })),
    };
    const shiftedIndex = indexInventory(strategy, shifted);
    const shiftStable = [...originalIndex.byId.entries()].filter(
      ([id, record]) => shiftedIndex.byId.has(id) && [...shiftedIndex.byId.get(id).signatures].sort().join('||') === [...record.signatures].sort().join('||')
    ).length;

    const changedEdit = transitions.filter((transition) => transition.new > 0 || transition.reassigned > 0);
    const deletionEdit = transitions.find((transition) => transition.retired > 0 && transition.new === 0);

    results.push({
      fixture,
      strategy,
      items: originalIndex.byId.size,
      transitions,
      collapse,
      offset_shift: { ids_total: originalIndex.byId.size, ids_identical_after_shift: shiftStable, retained: Number((shiftStable / Math.max(1, originalIndex.byId.size)).toFixed(3)) },
      assertions: assertionsFor({ transitions, deletionEdit, collapse, edits: EDITS[fixture] ?? [] }),
      evidence: {
        reassigned_anywhere: transitions.reduce((sum, transition) => sum + transition.reassigned, 0),
        missing_items: transitions.flatMap((transition) => transition.missing),
        links: transitions.flatMap((transition) => transition.links ?? []).length,
      },
    });
  }
}

const summary = {
  schema: 'gca-inventory-identity/v1',
  generated_at: new Date().toISOString(),
  spend: 0,
  source: 'deterministic scan over controlled edits; no model calls',
  edits: Object.fromEntries(Object.entries(EDITS).map(([fixture, edits]) => [fixture, edits.map(({ id, source_id, find, replace, intent }) => ({ id, source_id, find, replace, intent }))])),
  strategies: {
    positional: 'inv_0001 by scan order (current scheme)',
    content: 'digest(kind, label, sorted normalised span quotes)',
    content_occurrence: 'content + per-span occurrence index + revision registry',
  },
  results,
  recommendation_pending: true,
};

await mkdir(new URL(`${options.out}/`, ROOT), { recursive: true });
await writeFile(new URL(`${options.out}/experiment.json`, ROOT), `${JSON.stringify(summary, null, 2)}\n`);

for (const fixture of ['F3', 'F9']) {
  console.log(`\n${fixture} — ${summary.edits[fixture].map((edit) => edit.id).join(' → ')}`);
  const rows = results.filter((row) => row.fixture === fixture);
  for (const row of rows) {
    const a = row.assertions;
    const mark = (value) => (value === null ? 'n/a' : value ? 'yes' : 'NO ');
    console.log(
      `  ${row.strategy.padEnd(19)} items ${String(row.items).padStart(2)}  a=${mark(a.a_edit_creates_distinguishable_identity)}` +
        ` b=${mark(a.b_prior_identity_traceable)} c=${mark(a.c_deletion_identifiable)}` +
        ` d=${mark(a.d_unchanged_retain_identity)} e=${mark(a.e_repeats_not_collapsed)}` +
        `  dup-merges ${row.collapse.duplicate_merges.length} repeat-merges ${row.collapse.repeat_merges.length} shift-retained ${row.offset_shift.retained}`
    );
    for (const transition of row.transitions) {
      console.log(`      ${transition.edit.padEnd(20)} stable ${transition.stable} reassigned ${transition.reassigned} new ${transition.new} retired ${transition.retired} links ${transition.links} missing ${transition.missing.length}`);
    }
    if (row.collapse.repeat_merges.length) {
      for (const merge of row.collapse.repeat_merges.slice(0, 3)) console.log(`        repeat-merge ${merge.id.slice(0, 22)} ${merge.kind} covers items ${merge.items.join(',')}`);
    }
    for (const [key, reason] of Object.entries(row.assertions.reasons ?? {})) console.log(`        ${key}: ${reason}`);
  }
}

console.log(`\nwrote ${options.out}/experiment.json`);
