/**
 * Run the R-a neutral inventory over the real fixtures.
 *
 * This is the measurement the owner asked for before D0 is reconsidered: does the
 * rule-based scan supply a useful, independently reproducible denominator on real
 * material, or only on the planted corpora it was calibrated on?
 *
 * Three things are reported and deliberately kept apart:
 *
 *   1. **Yield** — how many items each rule and kind produces per fixture. This is
 *      not quality; it is volume, and volume is what an over-reporting rule inflates.
 *   2. **Span reproducibility** — every emitted span re-derived through the frozen
 *      resolver. A failure here is a defect in the instrument.
 *   3. **Coverage of human-adjudicated items** — post hoc, after the scan has
 *      finished and its output is fixed, each `ground_truth.required` entry is
 *      checked for any inventory item that cites an overlapping region. The scan
 *      never sees the answer key; `scanInventory` is given source material only, and
 *      this comparison runs afterwards on the frozen result.
 *
 * Coverage is not correctness. An item overlapping a required region may be a
 * different claim about the same words, and an item that overlaps nothing is not
 * thereby wrong. Precision stays unmeasured — there is no labelled set of *non*-
 * items — so no F-score is computed and every report says so.
 *
 * Usage: node tools/inventory-run.js [--out runs/inventory] [--fixtures F9,F3] [--max-items 20000]
 */

import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';

import { scanInventory, verifySpans } from '../inventory/scan.js';

const ROOT = new URL('../', import.meta.url);

function parseArgs(argv) {
  const options = { out: 'runs/inventory', fixtures: null, maxItems: 20000 };
  for (let index = 0; index < argv.length; index += 1) {
    const [flag, inline] = argv[index].split('=');
    const value = inline ?? argv[index + 1];
    if (flag === '--out') options.out = value;
    else if (flag === '--fixtures') options.fixtures = value.split(',').map((id) => id.trim()).filter(Boolean);
    else if (flag === '--max-items') options.maxItems = Number(value);
  }
  return options;
}

const options = parseArgs(process.argv.slice(2));

const fixtureIds = (await readdir(new URL('fixtures/', ROOT), { withFileTypes: true }))
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .filter((id) => !options.fixtures || options.fixtures.includes(id))
  .sort();

/** Rules whose spans are whole sentences, and therefore overlap almost anything. */
const SENTENCE_SCOPED = new Set(['shared_sentence', 'unclaimed_span', 'unresolved_cue']);

function spansOverlap(left, right) {
  if (!left?.span || !right?.span) return false;
  if (left.source_id !== right.source_id) return false;
  return left.span.start < right.span.end && right.span.start < left.span.end;
}

const reports = [];

for (const fixture of fixtureIds) {
  let input;
  try {
    input = JSON.parse(await readFile(new URL(`fixtures/${fixture}/input.json`, ROOT), 'utf8'));
  } catch {
    console.log(`  skip  ${fixture} — no readable input.json`);
    continue;
  }

  const textSources = (input.sources ?? []).filter((source) => typeof source?.content?.text === 'string' && source.content.text.length > 0);
  if (textSources.length === 0) {
    reports.push({ fixture, skipped: 'no text sources', sources: input.sources?.length ?? 0 });
    console.log(`  skip  ${fixture} — no text sources (text-only instrument)`);
    continue;
  }

  const startedAt = Date.now();
  // The scan sees source material only. The answer key is not in scope here.
  const inventory = scanInventory(input, { maxItems: options.maxItems });
  const spans = verifySpans(input, inventory.items);
  const elapsed = Date.now() - startedAt;

  let groundTruth = null;
  try {
    groundTruth = JSON.parse(await readFile(new URL(`fixtures/${fixture}/ground_truth.json`, ROOT), 'utf8'));
  } catch {
    groundTruth = null;
  }

  let coverage = null;
  if (groundTruth?.required?.length) {
    const perRequired = groundTruth.required.map((required) => {
      const ref = { source_id: required.source_id, span: required.span };
      const hits = inventory.items.filter((item) => (item.spans ?? []).some((candidate) => spansOverlap(candidate, ref)));
      // A whole-sentence span overlaps almost any quote inside that sentence, so a
      // bare overlap count overstates coverage. An item counts as pointing at the
      // region only when its rule emits a span narrower than the sentence.
      const pointHits = hits.filter((item) => !SENTENCE_SCOPED.has(item.rule));
      return {
        id: required.id,
        covered: hits.length > 0,
        covered_point: pointHits.length > 0,
        scope: pointHits.length > 0 ? 'point' : hits.length > 0 ? 'sentence_only' : 'none',
        hit_count: hits.length,
        kinds: [...new Set(hits.map((item) => item.kind))].sort(),
        rules: [...new Set(hits.map((item) => item.rule))].sort(),
      };
    });
    coverage = {
      required: perRequired.length,
      covered: perRequired.filter((entry) => entry.covered).length,
      covered_point: perRequired.filter((entry) => entry.covered_point).length,
      covered_sentence_only: perRequired.filter((entry) => entry.scope === 'sentence_only').length,
      per_required: perRequired,
      items_per_required: Number((inventory.items.length / perRequired.length).toFixed(2)),
    };
  }

  const report = {
    fixture,
    sources: textSources.length,
    characters: inventory.corpus.characters,
    sentences: inventory.corpus.sentences,
    elapsed_ms: elapsed,
    yield: { items: inventory.stats.items, derived: inventory.stats.derived, truncated: inventory.stats.truncated },
    by_kind: inventory.stats.by_kind,
    by_rule: inventory.stats.by_rule,
    distinct_entities: inventory.stats.distinct_entities,
    spans: { checked: spans.spans, resolved: spans.resolved, unverifiable: spans.unverifiable, failures: spans.failures.length, exact: spans.exact },
    coverage,
    probe_items: inventory.items.slice(0, 5).map((item) => ({ id: item.id, kind: item.kind, rule: item.rule, label: item.label })),
  };
  reports.push(report);

  console.log(
    `  ${fixture.padEnd(4)} ${String(inventory.corpus.characters).padStart(6)} chars  ${String(inventory.stats.items).padStart(5)} items` +
      `  spans ${spans.resolved}/${spans.spans} exact=${spans.exact}` +
      (coverage ? `  required ${coverage.covered}/${coverage.required} (point ${coverage.covered_point})` : '  (no answer key)') +
      `  ${elapsed}ms`
  );
}

// ------------------------------------------------------------------- aggregate

const measured = reports.filter((report) => !report.skipped);
const byKind = {};
const byRule = {};
for (const report of measured) {
  for (const [kind, count] of Object.entries(report.by_kind)) byKind[kind] = (byKind[kind] ?? 0) + count;
  for (const [rule, count] of Object.entries(report.by_rule)) byRule[rule] = (byRule[rule] ?? 0) + count;
}

const totalItems = measured.reduce((total, report) => total + report.yield.items, 0);
const requiredTotal = measured.reduce((total, report) => total + (report.coverage?.required ?? 0), 0);
const requiredCovered = measured.reduce((total, report) => total + (report.coverage?.covered ?? 0), 0);
const requiredPoint = measured.reduce((total, report) => total + (report.coverage?.covered_point ?? 0), 0);
const requiredSentenceOnly = measured.reduce((total, report) => total + (report.coverage?.covered_sentence_only ?? 0), 0);
const spanFailures = measured.reduce((total, report) => total + report.spans.failures, 0);

const aggregate = {
  schema: 'gca-inventory-run/v1',
  instrument: 'R-a neutral inventory (inventory/scan.js)',
  reference_instrument: true,
  ground_truth: false,
  precision: 'unmeasured — no labelled set of non-items exists, so no precision or F-score is reported',
  fixtures_run: measured.map((report) => report.fixture),
  fixtures_skipped: reports.filter((report) => report.skipped).map((report) => ({ fixture: report.fixture, reason: report.skipped })),
  totals: {
    items: totalItems,
    characters: measured.reduce((total, report) => total + report.characters, 0),
    truncations: measured.reduce((total, report) => total + report.yield.truncated, 0),
    span_failures: spanFailures,
    required_items: requiredTotal,
    required_covered: requiredCovered,
    required_covered_point: requiredPoint,
    required_covered_sentence_only: requiredSentenceOnly,
    required_coverage_ratio: requiredTotal === 0 ? null : Number((requiredCovered / requiredTotal).toFixed(3)),
    required_point_ratio: requiredTotal === 0 ? null : Number((requiredPoint / requiredTotal).toFixed(3)),
    items_per_required: requiredTotal === 0 ? null : Number((totalItems / requiredTotal).toFixed(2)),
  },
  by_kind: byKind,
  by_rule: byRule,
  rule_share: Object.fromEntries(
    Object.entries(byRule)
      .sort((a, b) => b[1] - a[1])
      .map(([rule, count]) => [rule, Number((count / Math.max(1, totalItems)).toFixed(3))])
  ),
  reports,
};

await mkdir(new URL(`${options.out}/`, ROOT), { recursive: true });
await writeFile(new URL(`${options.out}/inventory-run.json`, ROOT), `${JSON.stringify(aggregate, null, 2)}\n`);

console.log('\naggregate');
console.log(`  items: ${totalItems} over ${measured.length} fixture(s), ${aggregate.totals.characters} chars`);
console.log(`  kind yields: ${Object.entries(byKind).map(([kind, count]) => `${kind}=${count}`).join(' ') || 'none'}`);
console.log(`  dominant rule: ${Object.entries(aggregate.rule_share)[0]?.map((value) => value).join(' = ') ?? 'none'}`);
for (const [rule, count] of Object.entries(byRule).sort((a, b) => b[1] - a[1])) {
  console.log(`    ${String(count).padStart(5)}  ${(100 * count / Math.max(1, totalItems)).toFixed(1).padStart(5)}%  ${rule}`);
}
console.log(`  span exactness: ${spanFailures === 0 ? 'every emitted span re-derived' : `${spanFailures} FAILURES`}`);
if (requiredTotal > 0) {
  console.log(`  answer-key overlap: ${requiredCovered}/${requiredTotal} required items share a region with some inventory item (post hoc)`);
  console.log(`    of which point-scoped: ${requiredPoint}/${requiredTotal}; sentence-only: ${requiredSentenceOnly} (a whole-sentence span overlaps whatever is inside it)`);
  console.log(`  items per required item: ${aggregate.totals.items_per_required} (volume, not precision)`);
}
console.log(`  precision: unmeasured`);
console.log(`\nwrote ${options.out}/inventory-run.json`);

process.exit(spanFailures === 0 ? 0 : 1);
