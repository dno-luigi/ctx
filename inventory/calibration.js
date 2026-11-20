/**
 * Measuring the inventory's own detection limits.
 *
 * A reference instrument that is not itself measured is just a second opinion. So
 * the scan is run against corpora with **planted** structure and known expectations,
 * and the result is reported the only honest way available:
 *
 *   - **recall** — planted structures found, per kind and rule. This is a real
 *     measurement, because the expectation is known.
 *   - **span exactness** — every emitted span re-derived by the frozen resolver.
 *     Also a real measurement, and a hard one: a single miss is a defect.
 *   - **unlabelled items** — emitted but not matching a planted expectation. These
 *     are *not* false positives: the corpora contain unplanted material and the
 *     instrument may legitimately have found it. Precision is therefore **not**
 *     measured here and no precision number is reported.
 *
 * Consequence, stated wherever a calibration is emitted: recall on unlabelled,
 * real corpora is unknown. Knowing that the instrument finds what you planted does
 * not tell you what it misses.
 */

import { hashSource } from '../src/canonical.js';
import { scanInventory, verifySpans } from './scan.js';

export const CALIBRATION_SCHEMA = 'gca-inventory-calibration/v1';

export function syntheticInput(documents) {
  const sources = documents.map((document) => {
    const source = {
      id: document.source_id,
      kind: 'document',
      label: document.label ?? document.source_id,
      media_type: 'text/plain',
      status: 'ready',
      content: { text: document.text, data_url: null },
      origin: { supplied_by: 'operator', method: 'paste', captured_at: '2026-11-18T00:00:00.000Z' },
      observation: 'observed',
    };
    source.hash = hashSource(source);
    return source;
  });
  return {
    schema: 'gca-input/v1',
    run: { id: 'inventory-calibration', at: '2026-11-18T00:00:00.000Z', operator_ref: 'operator' },
    task: { question: 'planted structures for instrument calibration', deliverable: 'snapshot' },
    sources,
    budgets: { max_input_tokens: 4000, max_sources: 6, max_bytes: 100000 },
  };
}

/**
 * Planted corpora. `expect[].match` is a literal that must appear somewhere in the
 * emitted item (label, detail or quoted span). Deliberately small and readable so a
 * reader can check the expectations by eye.
 */
export const PLANTED_CORPORA = [
  {
    name: 'PLANT-1 dependency, cross-source, conflict, openness',
    documents: [
      {
        source_id: 's1',
        label: 'inventory policy',
        text:
          'Inventory policy\n\nThe billing service depends on the ledger service.\nCache TTL is 300 seconds.\nDeployment is pending approval by the platform team.\n',
      },
      {
        source_id: 's2',
        label: 'ledger notes',
        text:
          'Ledger notes\n\nThe billing service depends on the ledger service and the auth gateway.\nCache TTL is 900 seconds.\nMigration to v3.0 may change ordering.\n',
      },
    ],
    expect: [
      { kind: 'entity', match: 'billing service' },
      { kind: 'relationship', match: 'billing service' },
      { kind: 'cross_source_reference', match: 'billing service' },
      { kind: 'contradiction_candidate', match: '300' },
      { kind: 'unresolved_proposition', match: 'pending' },
      { kind: 'unresolved_proposition', match: 'may' },
    ],
  },
  {
    name: 'PLANT-2 obligation without a stated relation',
    documents: [
      {
        source_id: 's3',
        label: 'gateway notes',
        text: 'Gateway notes\n\nThe Auth Gateway must reject expired tokens.\nRotations happen weekly.\n',
      },
    ],
    expect: [
      { kind: 'entity', match: 'Auth Gateway' },
      { kind: 'unclaimed_span', match: 'must reject' },
    ],
  },
  {
    name: 'PLANT-3 same subject, two sources, no pairing',
    documents: [
      {
        source_id: 's4',
        label: 'cache policy',
        text: 'Cache policy\n\nThe Billing Cache evicts entries after 300 seconds of inactivity.\n',
      },
      {
        source_id: 's5',
        label: 'eviction notes',
        text: 'Eviction notes\n\nThe Archive Queue drops entries after 120 seconds.\n',
      },
    ],
    expect: [
      { kind: 'entity', match: 'Billing Cache' },
      { kind: 'missing_connection', match: 'entries' },
    ],
  },
];

function haystack(item) {
  return JSON.stringify([item.label, item.detail, (item.spans ?? []).map((ref) => ref.quote)]).toLowerCase();
}

function emptyKindCounts() {
  return { expected: 0, found: 0, emitted: 0, labelled: 0, unlabelled: 0 };
}

export function calibrate({ corpora = PLANTED_CORPORA, maxItems = 500 } = {}) {
  const perKind = {};
  const perRule = {};
  const perCorpus = [];
  let expectedTotal = 0;
  let foundTotal = 0;
  let spanFailures = 0;
  let spansChecked = 0;

  for (const corpus of corpora) {
    const input = syntheticInput(corpus.documents);
    const inventory = scanInventory(input, { maxItems });
    const verification = verifySpans(input, inventory.items);
    spansChecked += verification.spans;
    if (!verification.exact) spanFailures += verification.failures.length;

    const matchTable = corpus.expect.map((expectation) => {
      const hit = inventory.items.find((item) => item.kind === expectation.kind && haystack(item).includes(expectation.match.toLowerCase()));
      return { ...expectation, found: Boolean(hit), item_id: hit?.id ?? null };
    });

    const labels = corpus.expect.map((expectation) => `${expectation.kind}:${expectation.match.toLowerCase()}`);
    const emittedByKind = {};
    for (const item of inventory.items) {
      emittedByKind[item.kind] = (emittedByKind[item.kind] ?? 0) + 1;
      const labelled = labels.some((label) => haystack(item).includes(label.split(':')[1]));
      const bucket = (perKind[item.kind] ??= emptyKindCounts());
      bucket.emitted += 1;
      if (labelled) bucket.labelled += 1;
      else bucket.unlabelled += 1;
      const rule = (perRule[item.rule] ??= emptyKindCounts());
      rule.emitted += 1;
      if (labelled) rule.labelled += 1;
      else rule.unlabelled += 1;
    }
    for (const entry of matchTable) {
      const bucket = (perKind[entry.kind] ??= emptyKindCounts());
      bucket.expected += 1;
      if (entry.found) bucket.found += 1;
      expectedTotal += 1;
      if (entry.found) foundTotal += 1;
    }

    perCorpus.push({
      name: corpus.name,
      items: inventory.items.length,
      expected: matchTable.length,
      found: matchTable.filter((entry) => entry.found).length,
      span_exact: verification.exact,
      misses: matchTable.filter((entry) => !entry.found).map((entry) => `${entry.kind}:${entry.match}`),
      by_kind: emittedByKind,
    });
  }

  const recallByKind = {};
  for (const [kind, bucket] of Object.entries(perKind)) {
    recallByKind[kind] = bucket.expected === 0 ? null : Number((bucket.found / bucket.expected).toFixed(3));
  }

  return {
    schema: CALIBRATION_SCHEMA,
    instrument: 'inventory/scan.js',
    corpora: perCorpus,
    recall: {
      overall: expectedTotal === 0 ? null : Number((foundTotal / expectedTotal).toFixed(3)),
      expected: expectedTotal,
      found: foundTotal,
      by_kind: recallByKind,
    },
    precision: {
      measured: false,
      reason: 'planted corpora contain unplanted material, so an unmatched item is not a false positive; precision needs a fully labelled corpus',
    },
    spans: { checked: spansChecked, failures: spanFailures, exact: spanFailures === 0 },
    unlabelled: {
      note: 'emitted items that matched no planted expectation; candidate discoveries, not errors',
      total: Object.values(perKind).reduce((total, bucket) => total + bucket.unlabelled, 0),
      by_kind: Object.fromEntries(Object.entries(perKind).map(([kind, bucket]) => [kind, bucket.unlabelled])),
    },
    per_kind: perKind,
    per_rule: perRule,
    limits:
      'recall is measured only for structures that were planted; recall on unlabelled material is unknown and no precision figure is claimed',
  };
}
