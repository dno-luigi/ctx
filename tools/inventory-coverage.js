/**
 * INVENTORY-COVERAGE-01 scoring.
 *
 * Compares the existing inventory against the additive coverage rules on required items
 * that were adjudicated from the source text before either was scored.
 *
 * Reported for both sides, because "detects something here" and "detects the right kind
 * of thing here" are different claims:
 *
 *   recall_strict   detected, and the class matches
 *   recall_loose    detected, class ignored
 *   precision_strict  rule items that overlap a required item of the same class
 *   precision_loose   rule items that overlap any required item
 *
 * Text addressed to a reader as an instruction is excluded from precision only, by the
 * declared pattern list in the required-items file.
 *
 * Usage: node tools/inventory-coverage.js [--required pilot/coverage/required-items.json]
 */

import { readFile, mkdir, writeFile } from 'node:fs/promises';

import { scanInventory } from '../inventory/scan.js';
import { scanCoverageRules } from '../inventory/rules-coverage.js';

const ROOT = new URL('../', import.meta.url);
const options = { required: 'pilot/coverage/required-items.json', out: 'runs/coverage' };
for (let index = 0; index < process.argv.length; index += 1) {
  const [flag, inline] = String(process.argv[index]).split('=');
  if (flag === '--required') options.required = inline ?? process.argv[++index];
  else if (flag === '--out') options.out = inline ?? process.argv[++index];
}

const spec = JSON.parse(await readFile(new URL(options.required, ROOT), 'utf8'));

/** How the existing inventory's kinds map onto the four classes, for a fair comparison. */
const BASELINE_CLASS = {
  entity: 'explicit_fact',
  cross_source_reference: 'relationship',
  relationship: 'relationship',
  missing_connection: 'relationship',
  unclaimed_span: 'structural_constraint',
  contradiction_candidate: 'structural_constraint',
  repeated_phrase: 'repeated_role',
};

const overlap = (a, b) => a.source_id === b.source_id && a.start < b.end && a.end > b.start;

function spansOfRequired(input, required) {
  const spans = [];
  for (const source of input.sources) {
    const text = source.content?.text ?? '';
    let at = text.indexOf(required.quote);
    while (at !== -1) {
      spans.push({ source_id: source.id, start: at, end: at + required.quote.length });
      at = text.indexOf(required.quote, at + 1);
    }
  }
  return spans;
}

const excluded = (text) => (spec.excluded_from_precision?.patterns ?? []).some((pattern) => text.toLowerCase().includes(pattern.toLowerCase()));

const CLASSES = ['explicit_fact', 'relationship', 'structural_constraint', 'repeated_role'];
const fixtures = {};
const totals = Object.fromEntries(
  CLASSES.map((cls) => [cls, { required: 0, baseline_strict: 0, baseline_loose: 0, new_strict: 0, new_loose: 0, new_items: 0, new_correct_strict: 0, new_correct_loose: 0, baseline_items: 0, baseline_correct_strict: 0, baseline_correct_loose: 0 }])
);

for (const [fixture, requiredList] of Object.entries(spec.fixtures ?? {})) {
  const input = JSON.parse(await readFile(new URL(`fixtures/${fixture}/input.json`, ROOT), 'utf8'));
  const baseline = scanInventory(input, { maxItems: 20000 });
  const coverage = scanCoverageRules(input);

  const requiredRows = requiredList.map((required) => {
    const spans = spansOfRequired(input, required);
    const hit = (item, kindOf) =>
      spans.some((span) => (item.spans ?? []).some((itemSpan) => overlap(span, { source_id: itemSpan.source_id, ...itemSpan.span })) && kindOf(item) === required.class);
    const hitLoose = (item) => spans.some((span) => (item.spans ?? []).some((itemSpan) => overlap(span, { source_id: itemSpan.source_id, ...itemSpan.span })));

    const baselineStrict = baseline.items.some((item) => hit(item, (candidate) => BASELINE_CLASS[candidate.kind]));
    const baselineLoose = baseline.items.some((item) => hitLoose(item));
    const newStrict = coverage.items.some((item) => hit(item, (candidate) => candidate.kind));
    const newLoose = coverage.items.some((item) => hitLoose(item));

    return {
      id: required.id,
      class: required.class,
      quote: required.quote.slice(0, 90),
      spans_found: spans.length,
      baseline_strict: baselineStrict,
      baseline_loose: baselineLoose,
      new_strict: newStrict,
      new_loose: newLoose,
      detected_by_baseline_class: baseline.items
        .filter((item) => (item.spans ?? []).some((itemSpan) => spans.some((span) => overlap(span, { source_id: itemSpan.source_id, ...itemSpan.span }))))
        .map((item) => `${item.kind}:${item.id}`)
        .slice(0, 4),
      detected_by_new_class: coverage.items
        .filter((item) => (item.spans ?? []).some((itemSpan) => spans.some((span) => overlap(span, { source_id: itemSpan.source_id, ...itemSpan.span }))))
        .map((item) => `${item.kind}:${item.id}`)
        .slice(0, 4),
    };
  });

  // Precision: every new item, judged against the required list.
  const scoredItems = coverage.items.map((item) => {
    const text = (item.spans ?? []).map((span) => span.quote).join(' ');
    const isExcluded = excluded(text);
    const strict = requiredRows.some((required) => {
      if (required.class !== item.kind) return false;
      const requiredSpanSource = (item.spans ?? []).some((span) => span.source_id);
      return requiredSpanSource && (item.spans ?? []).some((itemSpan) => requiredRows.find((row) => row.id === required.id));
    });
    // Evaluation by overlap against the required items of the same class.
    const strictHit = requiredList.some((required) => {
      if (required.class !== item.kind) return false;
      const requiredSpans = spansOfRequired(input, required);
      return (item.spans ?? []).some((itemSpan) => requiredSpans.some((span) => overlap(span, { source_id: itemSpan.source_id, ...itemSpan.span })));
    });
    const looseHit = requiredList.some((required) => {
      const requiredSpans = spansOfRequired(input, required);
      return (item.spans ?? []).some((itemSpan) => requiredSpans.some((span) => overlap(span, { source_id: itemSpan.source_id, ...itemSpan.span })));
    });
    return { id: item.id, kind: item.kind, label: item.label.slice(0, 80), excluded: isExcluded, strict_hit: strictHit, loose_hit: looseHit, unused: strict };
  });

  const countedItems = scoredItems.filter((item) => !item.excluded);
  const fixtureSummary = {
    required: requiredRows.length,
    baseline_strict_recall: Number((requiredRows.filter((row) => row.baseline_strict).length / requiredRows.length).toFixed(3)),
    baseline_loose_recall: Number((requiredRows.filter((row) => row.baseline_loose).length / requiredRows.length).toFixed(3)),
    new_strict_recall: Number((requiredRows.filter((row) => row.new_strict).length / requiredRows.length).toFixed(3)),
    new_loose_recall: Number((requiredRows.filter((row) => row.new_loose).length / requiredRows.length).toFixed(3)),
    new_items: coverage.items.length,
    excluded_items: scoredItems.length - countedItems.length,
    new_precision_strict: countedItems.length ? Number((countedItems.filter((item) => item.strict_hit).length / countedItems.length).toFixed(3)) : null,
    new_precision_loose: countedItems.length ? Number((countedItems.filter((item) => item.loose_hit).length / countedItems.length).toFixed(3)) : null,
    rows: requiredRows,
    false_positives: countedItems.filter((item) => !item.loose_hit).map((item) => `${item.kind}: ${item.label}`),
    false_negatives: requiredRows.filter((row) => !row.new_loose).map((row) => `${row.class}: ${row.quote}`),
    class_missed: requiredRows.filter((row) => row.new_loose && !row.new_strict).map((row) => `${row.class}: ${row.quote}`),
  };
  fixtures[fixture] = fixtureSummary;

  for (const cls of CLASSES) {
    const rows = requiredRows.filter((row) => row.class === cls);
    const bucket = totals[cls];
    bucket.required += rows.length;
    bucket.baseline_strict += rows.filter((row) => row.baseline_strict).length;
    bucket.baseline_loose += rows.filter((row) => row.baseline_loose).length;
    bucket.new_strict += rows.filter((row) => row.new_strict).length;
    bucket.new_loose += rows.filter((row) => row.new_loose).length;
  }
  const itemsOfClass = (cls) => countedItems.filter((item) => item.kind === cls);
  for (const cls of CLASSES) {
    totals[cls].new_items += itemsOfClass(cls).length;
    totals[cls].new_correct_strict += itemsOfClass(cls).filter((item) => item.strict_hit).length;
    totals[cls].new_correct_loose += itemsOfClass(cls).filter((item) => item.loose_hit).length;
  }
}

const aggregate = {};
for (const cls of CLASSES) {
  const bucket = totals[cls];
  aggregate[cls] = {
    new_correct_strict: bucket.new_correct_strict,
    new_correct_loose: bucket.new_correct_loose,
    required: bucket.required,
    baseline_recall_strict: bucket.required ? Number((bucket.baseline_strict / bucket.required).toFixed(3)) : null,
    baseline_recall_loose: bucket.required ? Number((bucket.baseline_loose / bucket.required).toFixed(3)) : null,
    new_recall_strict: bucket.required ? Number((bucket.new_strict / bucket.required).toFixed(3)) : null,
    new_recall_loose: bucket.required ? Number((bucket.new_loose / bucket.required).toFixed(3)) : null,
    new_items: bucket.new_items,
    new_precision_strict: bucket.new_items ? Number((bucket.new_correct_strict / bucket.new_items).toFixed(3)) : null,
    new_precision_loose: bucket.new_items ? Number((bucket.new_correct_loose / bucket.new_items).toFixed(3)) : null,
  };
}

const overall = {
  required: Object.values(aggregate).reduce((sum, entry) => sum + entry.required, 0),
  baseline_recall_strict: null,
  baseline_recall_loose: null,
  new_recall_strict: null,
  new_recall_loose: null,
  new_items: Object.values(aggregate).reduce((sum, entry) => sum + entry.new_items, 0),
  new_precision_strict: null,
  new_precision_loose: null,
};
const allRequired = Object.values(fixtures).reduce((sum, entry) => sum + entry.required, 0);
overall.baseline_recall_strict = Number((Object.values(fixtures).reduce((sum, entry) => sum + Math.round(entry.baseline_strict_recall * entry.required), 0) / allRequired).toFixed(3));
overall.baseline_recall_loose = Number((Object.values(fixtures).reduce((sum, entry) => sum + Math.round(entry.baseline_loose_recall * entry.required), 0) / allRequired).toFixed(3));
overall.new_recall_strict = Number((Object.values(fixtures).reduce((sum, entry) => sum + Math.round(entry.new_strict_recall * entry.required), 0) / allRequired).toFixed(3));
overall.new_recall_loose = Number((Object.values(fixtures).reduce((sum, entry) => sum + Math.round(entry.new_loose_recall * entry.required), 0) / allRequired).toFixed(3));

const counted = Object.values(fixtures).reduce((sum, entry) => sum + entry.new_items - entry.excluded_items, 0);
overall.new_precision_strict = Number((Object.values(totals).reduce((sum, entry) => sum + entry.new_correct_strict, 0) / Math.max(1, counted)).toFixed(3));
overall.new_precision_loose = Number((Object.values(totals).reduce((sum, entry) => sum + entry.new_correct_loose, 0) / Math.max(1, counted)).toFixed(3));

const summary = {
  schema: 'gca-inventory-coverage/v1',
  generated_at: new Date().toISOString(),
  spend: 0,
  required_items: options.required,
  authored_before_new_rules: spec.authored_before_new_rules,
  matching_rule: spec.matching_rule,
  baseline_class_mapping: BASELINE_CLASS,
  aggregate,
  overall,
  fixtures,
  limits: [
    'one reviewer authored the required items; independence is procedural, not inter-rater',
    'ten fixtures, all short synthetic documents; F2a-F2d are unadjudicated',
    'the required lists are not exhaustive: a rule item overlapping no required item is counted a false positive even if it is a true fact nobody listed',
  ],
};

await mkdir(new URL(`${options.out}/`, ROOT), { recursive: true });
await writeFile(new URL(`${options.out}/coverage.json`, ROOT), `${JSON.stringify(summary, null, 2)}\n`);

console.log('INVENTORY-COVERAGE-01 — precision and recall by class\n');
console.log('class                     req  baseline(strict/loose)   new(strict/loose)   new items  new precision(strict/loose)');
for (const cls of CLASSES) {
  const entry = aggregate[cls];
  console.log(
    `${cls.padEnd(24)} ${String(entry.required).padStart(3)}   ${String(entry.baseline_recall_strict).padStart(5)}/${String(entry.baseline_recall_loose).padEnd(5)}   ` +
      `${String(entry.new_recall_strict).padStart(5)}/${String(entry.new_recall_loose).padEnd(5)}   ${String(entry.new_items).padStart(4)}      ${String(entry.new_precision_strict).padStart(5)}/${entry.new_precision_loose}`
  );
}
console.log(
  `\n${'overall'.padEnd(24)} ${String(overall.required).padStart(3)}   ${String(overall.baseline_recall_strict).padStart(5)}/${String(overall.baseline_recall_loose).padEnd(5)}   ` +
    `${String(overall.new_recall_strict).padStart(5)}/${String(overall.new_recall_loose).padEnd(5)}   ${String(overall.new_items).padStart(4)}      ${overall.new_precision_strict}/${overall.new_precision_loose}`
);

for (const [fixture, entry] of Object.entries(fixtures)) {
  console.log(`\n${fixture}: required ${entry.required}, new items ${entry.new_items} (excluded ${entry.excluded_items})`);
  for (const row of entry.rows) {
    const status = row.new_strict ? 'ok  ' : row.new_loose ? 'CLASS' : 'MISS ';
    console.log(`  ${status} ${row.class.padEnd(22)} ${row.quote.slice(0, 66)}`);
  }
  for (const miss of entry.class_missed) console.log(`    class-mismatch: ${miss}`);
}

console.log(`\nwrote ${options.out}/coverage.json`);
