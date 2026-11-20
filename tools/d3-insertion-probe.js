/**
 * D3 insertion probe — is an occurrence's identity stable when the source gains a duplicate above it?
 *
 * The schema stores `occurrence` in the anchor id and verifies with the locator. This probe measures
 * four strategies against six edits, because "the ordinal might be unstable" is a hypothesis, and the
 * point is to replace it with a number.
 *
 * Strategies
 *   content           id = H(source, quote)                     — what the shipped identity layer does
 *   ordinal           id = H(source, quote, occurrence)          — what ARA-SCHEMA-01 §3.2 specifies
 *   context           id = H(source, quote, prev_line, next_line)— occurrence identity without an ordinal
 *   ordinal+context   id = H(source, quote, occurrence, context) — maximum specificity
 *
 * Outcomes per anchor
 *   correct        resolved to the occurrence it was created for
 *   silent_wrong   resolved to a different occurrence with no warning   ← the failure that matters
 *   flagged        refused as needs_reattribution
 *   broken         the quote no longer exists anywhere (correct for a revised line)
 *
 * Usage: node tools/d3-insertion-probe.js
 */

import { anchorId, resolveAnchor } from '../cards/identity.js';
import { digest, normalizeClaim } from '../src/canonical.js';

const H = (schema, ...parts) => digest({ schema, parts }).slice(0, 20);
const SOURCE = 'probe.txt';
const QUOTE = '  run();';

// ------------------------------------------------------------------ text helpers

const lines = (text) => {
  const out = [];
  let start = 0;
  for (const raw of text.split('\n')) {
    out.push({ start, end: start + raw.length, text: raw });
    start += raw.length + 1;
  }
  return out;
};

const positionsOf = (text, quote) => {
  const positions = [];
  for (let at = text.indexOf(quote); at !== -1; at = text.indexOf(quote, at + 1)) positions.push(at);
  return positions;
};

/**
 * The marker line *immediately* following an occurrence identifies it for scoring. Scanning forward
 * to the next marker at all lets an inserted duplicate inherit the marker of a later occurrence and
 * score as correct when it is the wrong line — a scoring defect that hides silent misattribution.
 */
function tagAfter(text, position) {
  const all = lines(text);
  const index = all.findIndex((line) => position >= line.start && position <= line.end);
  const next = all[index + 1];
  if (!next) return null;
  const trimmed = next.text.trim();
  return trimmed.startsWith('#') ? trimmed.replace(/^#\s*/, '') : null;
}

function contextOf(text, position) {
  const all = lines(text);
  const index = all.findIndex((line) => position >= line.start && position <= line.end);
  return {
    prev: normalizeClaim(all[index - 1]?.text ?? ''),
    next: normalizeClaim(all[index + 1]?.text ?? ''),
  };
}

// ------------------------------------------------------------------ anchors

function makeAnchors(text) {
  const occurrences = positionsOf(text, QUOTE);
  return occurrences.map((position, index) => {
    const occurrence = index + 1;
    const context = contextOf(text, position);
    return {
      tag: tagAfter(text, position),
      occurrence,
      context,
      quote: QUOTE,
      locator: { source_id: SOURCE, start: position, end: position + QUOTE.length },
      ids: {
        content: anchorId({ source_id: SOURCE, quote: QUOTE }),
        ordinal: `anc_${H('probe/ordinal', SOURCE, QUOTE, String(occurrence))}`,
        context: `anc_${H('probe/context', SOURCE, QUOTE, context.prev, context.next)}`,
        'ordinal+context': `anc_${H('probe/both', SOURCE, QUOTE, String(occurrence), context.prev, context.next)}`,
      },
    };
  });
}

// ------------------------------------------------------------------ resolution per strategy

function resolveContent(text, anchor) {
  const result = resolveAnchor({ sources: [{ id: SOURCE, content: { text } }] }, anchor);
  return result.ok ? { position: result.span.start } : { failed: result.reason };
}

function resolveOrdinal(text, anchor) {
  const base = resolveContent(text, anchor);
  if (base.failed) return base;
  const rank = positionsOf(text, anchor.quote).indexOf(base.position) + 1;
  if (rank !== anchor.occurrence) return { flagged: `ordinal drifted: stored ${anchor.occurrence}, found ${rank}` };
  return base;
}

function resolveContext(text, anchor) {
  const candidates = positionsOf(text, anchor.quote).filter((position) => {
    const context = contextOf(text, position);
    return context.prev === anchor.context.prev && context.next === anchor.context.next;
  });
  if (candidates.length === 1) return { position: candidates[0] };
  if (candidates.length === 0) {
    const base = resolveContent(text, anchor);
    if (base.failed) return base;
    return { flagged: 'no occurrence matches the stored context' };
  }
  const nearest = candidates.reduce((best, position) => (Math.abs(position - anchor.locator.start) < Math.abs(best - anchor.locator.start) ? position : best), candidates[0]);
  return { position: nearest };
}

function resolveOrdinalAndContext(text, anchor) {
  const ordinal = resolveOrdinal(text, anchor);
  if (ordinal.flagged || ordinal.failed) return ordinal;
  return resolveContext(text, anchor);
}

const RESOLVERS = { content: resolveContent, ordinal: resolveOrdinal, context: resolveContext, 'ordinal+context': resolveOrdinalAndContext };

// ------------------------------------------------------------------ scenarios

const BASE = ['alpha', QUOTE, '# t1', 'beta', QUOTE, '# t2', 'gamma', ''].join('\n');
const BLOCK = Array.from({ length: 18 }, (_, index) => `filler ${index + 1}`).join('\n');

const SCENARIOS = [
  { id: 'S1', name: 'unrelated line inserted above', text: `prelude\n${BASE}`, expect: 'correct' },
  { id: 'S2', name: 'duplicate line inserted above (small)', text: `${QUOTE}\n${BASE}`, expect: 'correct' },
  { id: 'S3', name: 'duplicate inserted between the two occurrences', text: BASE.replace('# t1\n', `# t1\n${QUOTE}\n`), expect: 'correct' },
  { id: 'S5', name: 'unrelated line deleted above (offset shift)', text: BASE.replace('alpha\n', ''), expect: 'correct' },
  { id: 'S6', name: 'large block ending in a duplicate inserted above', text: `${QUOTE}\n${BLOCK}\n${BASE}`, expect: 'silent_wrong_exposed' },
  { id: 'S4', name: 'second occurrence revised', text: BASE.replace(`${QUOTE}\n# t2`, `  run(2);\n# t2`), expect: 'second_broken' },
];

// ------------------------------------------------------------------ run

const anchors = makeAnchors(BASE);
const intended = anchors.map((anchor) => anchor.tag);
const rows = [];

for (const scenario of SCENARIOS) {
  const row = { id: scenario.id, name: scenario.name, expect: scenario.expect, strategies: {} };
  for (const [strategy, resolver] of Object.entries(RESOLVERS)) {
    const outcomes = anchors.map((anchor) => {
      const result = resolver(scenario.text, anchor);
      if (result.failed) return { outcome: 'broken', detail: result.failed, tag: anchor.tag };
      if (result.flagged) return { outcome: 'flagged', detail: result.flagged, tag: anchor.tag };
      const found = tagAfter(scenario.text, result.position);
      return { outcome: found === anchor.tag ? 'correct' : 'silent_wrong', detail: found, tag: anchor.tag };
    });
    row.strategies[strategy] = outcomes;
  }
  rows.push(row);
}

// ------------------------------------------------------------------ scoring

const TALLY = ['correct', 'silent_wrong', 'flagged', 'broken'];
const summary = {};
for (const strategy of Object.keys(RESOLVERS)) {
  summary[strategy] = Object.fromEntries(TALLY.map((key) => [key, 0]));
  for (const row of rows) for (const outcome of row.strategies[strategy]) summary[strategy][outcome.outcome] += 1;
}

console.log(`intended occurrences: ${intended.join(', ')}`);
for (const row of rows) {
  console.log(`\n${row.id} ${row.name} (${row.expect})`);
  for (const [strategy, outcomes] of Object.entries(row.strategies)) {
    const rendered = outcomes.map((entry) => `${entry.tag}:${entry.outcome}`).join(' ');
    console.log(`  ${strategy.padEnd(18)} ${rendered}`);
  }
}

console.log('\ntotals across six edits, per strategy:');
for (const [strategy, counts] of Object.entries(summary)) {
  console.log(`  ${strategy.padEnd(18)} ${TALLY.map((key) => `${key}=${counts[key]}`).join(' ')}`);
}

const verdict = Object.entries(summary).map(([strategy, counts]) => ({ strategy, ...counts }));
console.log('\nstrategy with zero silent misattribution and zero false flags:',
  verdict.filter((entry) => entry.silent_wrong === 0 && entry.flagged === 0).map((entry) => entry.strategy).join(', ') || 'none');
console.log('strategies that silently misattribute:', verdict.filter((entry) => entry.silent_wrong > 0).map((entry) => `${entry.strategy} (${entry.silent_wrong})`).join(', ') || 'none');
