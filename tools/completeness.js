/**
 * Q1 + Q2: is the neutral inventory a reliable denominator for completeness, and
 * can the harness identify what a snapshot *omitted* rather than only scoring what
 * it kept?
 *
 * One computation answers both, because both need the same thing: an item-by-item
 * comparison between the inventory (a model-independent scan of the corpus) and the
 * cards a snapshot actually contains.
 *
 * The honest difficulty is matching. Cards on this path carry **no citations**, so a
 * card cannot be matched to an inventory span by evidence; only by wording. That
 * matcher is declared in the output and its fragility is part of the diagnosis, not
 * a detail to hide:
 *
 *     an item is covered when the card's claim contains every entity key the item
 *     exposes, or — for items that expose none — when it shares at least 60% of the
 *     item's content tokens.
 *
 * Three things are reported per fixture:
 *
 *   1. **Denominator shape** — how many assertion-bearing items exist, by kind. A
 *      denominator of zero is reported as `vacuous`, not as completeness 1.0.
 *   2. **Coverage** — how many of those items a card accounts for, at two card-set
 *      sizes so the metric can be seen responding (or not) to real added content.
 *   3. **Omissions** — the items no card accounts for, each traceable to a source
 *      span, with an answer-key check: does the omitted region overlap a
 *      human-adjudicated required item? That separates a real omission from
 *      inventory noise, and shows where the inventory is blind.
 *
 * Usage:
 *   node tools/completeness.js --fixture F3 --model perplexity/pplx-decider-flash-v1.2
 *   node tools/completeness.js --fixtures F3,F9,F2a --model perplexity/pplx-decider-flash-v1.2 --broad runs/live/broad
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';

import { scanInventory } from '../inventory/scan.js';

const ROOT = new URL('../', import.meta.url);

function parseArgs(argv) {
  const options = { out: 'runs/completeness', fixtures: null, model: 'perplexity/pplx-decider-flash-v1.2', broad: null, records: 'runs/live' };
  for (let index = 0; index < argv.length; index += 1) {
    const [flag, inline] = argv[index].split('=');
    if (flag === '--fixture') options.fixtures = [(inline ?? argv[++index])];
    else if (flag === '--fixtures') options.fixtures = (inline ?? argv[++index]).split(',');
    else if (flag === '--model') options.model = inline ?? argv[++index];
    else if (flag === '--broad') options.broad = inline ?? argv[++index];
    else if (flag === '--records') options.records = inline ?? argv[++index];
    else if (flag === '--out') options.out = inline ?? argv[++index];
  }
  return options;
}

const options = parseArgs(process.argv.slice(2));
if (!options.fixtures) {
  console.error('usage: node tools/completeness.js --fixtures F3,F9 --model <slug> [--broad <dir>]');
  process.exit(2);
}

/** Kinds that state something a snapshot could have accounted for. */
const ASSERTION_KINDS = ['relationship', 'contradiction_candidate', 'unresolved_proposition', 'unclaimed_span', 'missing_connection', 'cross_source_reference'];

const STOPWORDS = new Set([
  'the', 'and', 'that', 'this', 'with', 'from', 'for', 'are', 'was', 'were', 'has', 'have', 'not', 'but',
  'its', 'into', 'than', 'then', 'they', 'their', 'which', 'while', 'when', 'what', 'does', 'did', 'only',
  'also', 'all', 'any', 'can', 'may', 'will', 'would', 'should', 'must', 'been', 'being', 'because',
]);

function normalize(text) {
  return String(text ?? '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

function containsPhrase(haystack, phrase) {
  const needle = normalize(phrase);
  if (!needle) return false;
  return ` ${haystack} `.includes(` ${needle} `);
}

function contentTokens(text) {
  return new Set(normalize(text).split(' ').filter((token) => token.length >= 4 && !STOPWORDS.has(token)));
}

/** Entity keys an item exposes, if it exposes any. */
function itemKeys(item) {
  if (item.kind === 'relationship') return item.detail?.entities ?? null;
  if (item.kind === 'entity') return item.detail?.key ? [item.detail.key] : null;
  if (item.kind === 'cross_source_reference') return item.detail?.key ? [item.detail.key] : null;
  return null;
}

const MATCHER = 'item covered when a card claim contains every exposed entity key; otherwise >=60% of the item content tokens appear in the claim';

function cardMatchesItem(card, item) {
  const hay = normalize(card.claim);
  const keys = itemKeys(item);
  if (keys && keys.length) return keys.every((key) => containsPhrase(hay, key));
  const entities = item.detail?.entities ?? [];
  if (entities.length) return entities.every((key) => containsPhrase(hay, key));
  const tokens = contentTokens(`${item.label ?? ''} ${item.reason ?? ''}`);
  if (tokens.size === 0) return false;
  const hits = [...tokens].filter((token) => containsPhrase(hay, token)).length;
  return hits / tokens.size >= 0.6;
}

function spansOverlap(left, right) {
  if (!left?.span || !right?.span) return false;
  if (left.source_id !== right.source_id) return false;
  return left.span.start < right.span.end && right.span.start < left.span.end;
}

const slugOf = (id) => id.replace(/[/:]/g, '_');

async function loadRecord(dir, fixture, slug, rep = 1) {
  try {
    return JSON.parse(await readFile(new URL(`${dir}/${slug}/${fixture}.r${rep}.json`, ROOT), 'utf8'));
  } catch {
    return null;
  }
}

const reports = [];

for (const fixture of options.fixtures) {
  const input = JSON.parse(await readFile(new URL(`fixtures/${fixture}/input.json`, ROOT), 'utf8'));
  const inventory = scanInventory(input, { maxItems: 20000 });
  const cardsRecord = await loadRecord(options.records, fixture, slugOf(options.model));
  if (!cardsRecord?.http?.ok) {
    console.log(`  skip  ${fixture} — no successful ${options.model} snapshot to compare`);
    continue;
  }
  const cards = cardsRecord.snapshot.observations;

  let broadCards = null;
  if (options.broad) {
    const broadRecord = await loadRecord(options.broad, fixture, slugOf(options.model));
    if (broadRecord?.http?.ok) broadCards = [...cards, ...broadRecord.snapshot.observations];
  }

  const assertions = inventory.items.filter((item) => ASSERTION_KINDS.includes(item.kind));
  const byKind = {};
  for (const item of assertions) byKind[item.kind] = (byKind[item.kind] ?? 0) + 1;

  const coverageOf = (cardSet) => {
    const matches = new Map();
    for (const item of assertions) {
      const hit = cardSet.find((card) => cardMatchesItem(card, item));
      if (hit) matches.set(item.id, hit.oid);
    }
    return matches;
  };
  const narrow = coverageOf(cards);
  const broad = broadCards ? coverageOf(broadCards) : null;

  const omissions = assertions
    .filter((item) => !narrow.has(item.id))
    .map((item) => ({
      id: item.id,
      kind: item.kind,
      rule: item.rule,
      label: item.label,
      spans: item.spans.map((span) => ({ source_id: span.source_id, start: span.span.start, end: span.span.end, quote: span.quote.slice(0, 120) })),
      detail: item.detail,
    }));

  let groundTruth = null;
  try {
    groundTruth = JSON.parse(await readFile(new URL(`fixtures/${fixture}/ground_truth.json`, ROOT), 'utf8'));
  } catch {
    groundTruth = null;
  }

  let answerKey = null;
  if (groundTruth?.required?.length) {
    /** Direct matcher: the card's own wording against the required item's wording. */
    const directMatch = (required, cardSet) => {
      const tokens = contentTokens(required.quote);
      if (tokens.size === 0) return false;
      return cardSet.some((card) => {
        const hay = normalize(card.claim);
        const hits = [...tokens].filter((token) => containsPhrase(hay, token)).length;
        return hits / tokens.size >= 0.6;
      });
    };

    const perRequired = groundTruth.required.map((required) => {
      const overlapping = assertions.filter((item) => item.spans.some((span) => spansOverlap(span, { source_id: required.source_id, span: required.span })));
      // Chain: card covers an inventory assertion that overlaps the required span.
      const coveredViaInventory = overlapping.some((item) => narrow.has(item.id));
      // Direct: card wording vs required wording, no inventory in between.
      const coveredDirect = directMatch(required, cards);
      const omitted = overlapping.filter((item) => !narrow.has(item.id));
      return {
        id: required.id,
        quote: String(required.quote).slice(0, 100),
        inventory_emits_anything_overlapping: overlapping.length > 0,
        covered_via_inventory: coveredViaInventory,
        covered_direct: coveredDirect,
        matchers_disagree: coveredViaInventory !== coveredDirect,
        flagged_as_omitted: omitted.map((item) => item.id),
      };
    });
    answerKey = {
      required: perRequired.length,
      inventory_blind: perRequired.filter((entry) => !entry.inventory_emits_anything_overlapping).length,
      covered_via_inventory: perRequired.filter((entry) => entry.covered_via_inventory).length,
      covered_direct: perRequired.filter((entry) => entry.covered_direct).length,
      matcher_disagreements: perRequired.filter((entry) => entry.matchers_disagree).map((entry) => entry.id),
      omitted_and_detected: perRequired.filter((entry) => !entry.covered_direct && entry.flagged_as_omitted.length > 0).length,
      omitted_and_missed: perRequired.filter((entry) => !entry.covered_direct && entry.flagged_as_omitted.length === 0).length,
      per_required: perRequired,
    };
  }

  const report = {
    fixture,
    model: options.model,
    cards: cards.length,
    inventory: { items: inventory.stats.items, assertions: assertions.length, by_kind: byKind, vacuous: assertions.length === 0 },
    matcher: MATCHER,
    coverage: {
      narrow: { cards: cards.length, covered: narrow.size, denominator: assertions.length, ratio: assertions.length ? Number((narrow.size / assertions.length).toFixed(3)) : null },
      broad: broad ? { cards: broadCards.length, covered: broad.size, denominator: assertions.length, ratio: assertions.length ? Number((broad.size / assertions.length).toFixed(3)) : null } : null,
    },
    omissions: { count: omissions.length, items: omissions },
    answer_key: answerKey,
    limits: [
      'Cards carry no citations, so matching is lexical. A card that discusses an item in different words is counted as an omission, and a card that echoes an item label is counted as coverage.',
      'The denominator inherits every inventory blind spot measured in LIVE-RUN-01 §7: key-value records, unique numeric facts, and anything that repeats nowhere.',
      'A ratio is only meaningful when the denominator is non-trivial and the matcher is sound; both are reported rather than assumed.',
    ],
  };
  reports.push(report);

  const ratio = report.coverage.narrow.ratio;
  console.log(
    `  ${fixture.padEnd(4)} cards ${String(cards.length).padStart(2)}  denominator ${String(assertions.length).padStart(3)} (${Object.entries(byKind).map(([k, v]) => `${k}=${v}`).join(' ') || 'none'})` +
      `  covered ${String(narrow.size).padStart(3)}  ratio ${ratio === null ? 'n/a' : ratio}` +
      (broad ? `  broad(${broadCards.length} cards) ${broad.size}${report.coverage.broad.ratio === null ? '' : ` (${report.coverage.broad.ratio})`}` : '') +
      (report.inventory.vacuous ? '  VACUOUS' : '')
  );
  if (answerKey) {
    console.log(
      `       answer key: ${answerKey.required} required, inventory blind to ${answerKey.inventory_blind}, cards cover ${answerKey.covered_via_inventory} (via inventory) / ${answerKey.covered_direct} (direct), matchers disagree on [${answerKey.matcher_disagreements.join(',')}], omitted-and-detected ${answerKey.omitted_and_detected}, omitted-and-missed ${answerKey.omitted_and_missed}`
    );
  }
}

const summary = {
  schema: 'gca-completeness/v1',
  generated_at: new Date().toISOString(),
  question: 'does the neutral inventory provide a reliable denominator for snapshot completeness, and can omissions be identified rather than only retained content scored?',
  matcher: MATCHER,
  fixtures: reports,
  answer_key_totals: reports.reduce(
    (total, report) => {
      if (!report.answer_key) return total;
      return {
        required: total.required + report.answer_key.required,
        inventory_blind: total.inventory_blind + report.answer_key.inventory_blind,
        covered_via_inventory: total.covered_via_inventory + report.answer_key.covered_via_inventory,
        covered_direct: total.covered_direct + report.answer_key.covered_direct,
        matcher_disagreements: total.matcher_disagreements + report.answer_key.matcher_disagreements.length,
        omitted_and_detected: total.omitted_and_detected + report.answer_key.omitted_and_detected,
        omitted_and_missed: total.omitted_and_missed + report.answer_key.omitted_and_missed,
      };
    },
    { required: 0, inventory_blind: 0, covered_via_inventory: 0, covered_direct: 0, matcher_disagreements: 0, omitted_and_detected: 0, omitted_and_missed: 0 }
  ),
};

await mkdir(new URL(`${options.out}/`, ROOT), { recursive: true });
await writeFile(new URL(`${options.out}/completeness.json`, ROOT), `${JSON.stringify(summary, null, 2)}\n`);

console.log('\nanswer-key totals');
console.log(JSON.stringify(summary.answer_key_totals, null, 2));
console.log(`\nwrote ${options.out}/completeness.json`);
