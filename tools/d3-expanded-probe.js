/**
 * D3 expanded probe — is any occurrence-identity rule safe enough to become the contract?
 *
 * Adds what the first probe lacked: three or more identical occurrences, adjacent edits, a multi-line
 * construct, and a context-collision scene where two occurrences have identical neighbours. Also adds
 * the refined strategy you specified, which separates *identity* from *resolution*:
 *
 *   anchor_id           identity of the occurrence, fixed at creation
 *   context_fingerprint evidence used to resolve it, allowed to drift
 *   locator             mutable candidate position
 *   resolution_status   verified | ambiguous | needs_reattribution | unresolved
 *
 * Governing rule under test: an anchor may move, but it may never silently change what it refers to.
 *
 * Usage: node tools/d3-expanded-probe.js
 */

import { anchorId } from '../cards/identity.js';
import { digest, normalizeClaim } from '../src/canonical.js';

const H = (schema, ...parts) => digest({ schema, parts }).slice(0, 20);
const SOURCE = 'expanded.txt';

// ------------------------------------------------------------------ scenes as segment lists

const QUOTE = '  run();';
const BLOCK = ['  open();', '  close();'].join('\n');

/** Join segments and record where each occurrence sits, with its tag and context. */
function sceneOf(segments, quote) {
  const text = segments.map((segment) => segment.text).join('\n');
  const offsets = [];
  let at = 0;
  for (const segment of segments) {
    offsets.push(at);
    at += segment.text.length + 1;
  }
  const occurrences = [];
  segments.forEach((segment, index) => {
    if (segment.text !== quote) return;
    const start = offsets[index];
    const tag = [segments[index + 1], segments[index + 2]].map((entry) => entry?.text?.trim() ?? '').find((text) => text.startsWith('#')) ?? null;
    occurrences.push({
      index,
      tag: tag ? tag.replace(/^#\s*/, '') : null,
      start,
      end: start + quote.length,
      prev: normalizeClaim(segments[index - 1]?.text ?? ''),
      next: normalizeClaim(segments[index + 1]?.text ?? ''),
    });
  });
  return { segments, quote, text, occurrences };
}

const MAIN = [
  { text: 'alpha' },
  { text: QUOTE },
  { text: 'ctx 1' },
  { text: '# t1' },
  { text: 'beta' },
  { text: QUOTE },
  { text: 'ctx 2' },
  { text: '# t2' },
  { text: 'gamma' },
];

// Two occurrences with identical neighbours: identical context, different markers.
const COLLISION = [
  { text: 'alpha' },
  { text: QUOTE },
  { text: 'ctx same' },
  { text: '# c1' },
  { text: 'alpha' },
  { text: QUOTE },
  { text: 'ctx same' },
  { text: '# c2' },
  { text: 'gamma' },
];

// Two occurrences with identical neighbours and enough separation that a third twin can be placed
// exactly where one of them used to be (E12).
const COLLISION2 = [
  { text: 'alpha' },
  { text: QUOTE },
  { text: 'ctx same' },
  { text: '# c1' },
  { text: 'alpha' },
  { text: QUOTE },
  { text: 'ctx same' },
  { text: '# c2' },
  { text: 'gamma' },
];

const THREE = [
  { text: 'alpha' },
  { text: QUOTE },
  { text: 'ctx 1' },
  { text: '# t1' },
  { text: 'beta' },
  { text: QUOTE },
  { text: 'ctx 2' },
  { text: '# t2' },
  { text: 'beta2' },
  { text: QUOTE },
  { text: 'ctx 3' },
  { text: '# t3' },
  { text: 'gamma' },
];

const BLOCK_SCENE = [
  { text: 'alpha' },
  { text: BLOCK },
  { text: 'ctx b1' },
  { text: '# b1' },
  { text: 'beta' },
  { text: BLOCK },
  { text: 'ctx b2' },
  { text: '# b2' },
  { text: 'gamma' },
];

const clone = (segments) => segments.map((segment) => ({ ...segment }));

// ------------------------------------------------------------------ edits

const EDITS = [
  { id: 'E1', name: 'unrelated line prepended (control)', base: 'main', apply: (s) => [{ text: 'prelude' }, ...clone(s)] },
  { id: 'E2', name: 'duplicate prepended (third occurrence above)', base: 'main', apply: (s) => [{ text: QUOTE }, ...clone(s)] },
  { id: 'E3', name: 'duplicate inserted between the two', base: 'main', apply: (s) => { const out = clone(s); const at = out.findIndex((segment) => segment.text.trim() === '# t1'); out.splice(at + 1, 0, { text: QUOTE }); return out; } },
  { id: 'E4', name: 'large block ending in a duplicate, prepended', base: 'main', apply: (s) => [...Array.from({ length: 18 }, (_, i) => ({ text: `filler ${i + 1}` })), { text: QUOTE }, ...clone(s)] },
  { id: 'E5', name: 'unrelated line deleted above (offset shift)', base: 'main', apply: (s) => clone(s).filter((segment, index) => !(index === 0 && segment.text === 'alpha')) },
  { id: 'E6', name: 'adjacent edit above the first occurrence', base: 'main', apply: (s) => { const out = clone(s); out[0] = { text: 'alpha edited' }; return out; } },
  { id: 'E7', name: 'second occurrence revised', base: 'main', apply: (s) => { const out = clone(s); const at = out.map((segment) => segment.text).lastIndexOf(QUOTE); out[at] = { text: '  run(2);' }; return out; } },
  { id: 'E8', name: 'three identical occurrences, duplicate prepended', base: 'three', apply: (s) => [{ text: QUOTE }, ...clone(s)] },
  { id: 'E9', name: 'multi-line construct duplicated above', base: 'block', apply: (s) => [{ text: BLOCK }, ...clone(s)] },
  { id: 'E10', name: 'adjacent edits above and below one occurrence', base: 'main', apply: (s) => { const out = clone(s); out[0] = { text: 'alpha edited' }; out[2] = { text: 'ctx 1 edited' }; return out; } },
  { id: 'E11', name: 'context collision (identical neighbours)', base: 'collision', apply: (s) => clone(s) },
  // The structural proof: the twin is placed at the old locator of the second occurrence, so
  // "nearest" is the twin and a resolver that trusts proximity reports verified for a wrong line.
  { id: 'E12', name: 'collision twin inserted at the old locator', base: 'collision2', apply: (s) => { const out = clone(s); const at = out.findIndex((segment) => segment.text.trim() === '# c1'); out.splice(at + 1, 0, { text: 'alpha' }, { text: QUOTE }, { text: 'ctx same' }); return out; } },
];

// ------------------------------------------------------------------ strategies

function anchorsOf(scene) {
  return scene.occurrences.map((occurrence, index) => ({
    ...occurrence,
    occurrence: index + 1,
    fingerprint: `${occurrence.prev}|${occurrence.next}`,
    quote: scene.quote,
    ids: {
      content: anchorId({ source_id: SOURCE, quote: scene.quote }),
      ordinal: `anc_${H('probe2/ordinal', SOURCE, scene.quote, String(index + 1))}`,
      context: `anc_${H('probe2/context', SOURCE, scene.quote, occurrence.prev, occurrence.next)}`,
      'ordinal+context': `anc_${H('probe2/both', SOURCE, scene.quote, String(index + 1), occurrence.prev, occurrence.next)}`,
      refined: `anc_${H('probe2/refined', SOURCE, scene.quote, occurrence.prev, occurrence.next)}`,
    },
  }));
}

const positionsOf = (text, quote) => {
  const positions = [];
  for (let at = text.indexOf(quote); at !== -1; at = text.indexOf(quote, at + 1)) positions.push(at);
  return positions;
};

function contextAt(text, start, end) {
  // The quote ends at the end of its line, so `after` begins with the newline that terminates it.
  // Reading the next line without skipping that newline yields '' and makes every fingerprint
  // mismatch — which looks exactly like "context identity never verifies anything".
  const before = text.slice(0, start).replace(/\n$/, '');
  const prevLine = before.split('\n').pop() ?? '';
  const after = text.slice(end).replace(/^\n/, '');
  const nextBreak = after.indexOf('\n');
  const nextLine = nextBreak === -1 ? after : after.slice(0, nextBreak);
  return `${normalizeClaim(prevLine)}|${normalizeClaim(nextLine)}`;
}

const nearest = (candidates, from) => candidates.reduce((best, position) => (Math.abs(position - from) < Math.abs(best - from) ? position : best), candidates[0]);

const RESOLVERS = {
  content: (text, anchor) => {
    const positions = positionsOf(text, anchor.quote);
    if (!positions.length) return { status: 'unresolved' };
    return { status: 'verified', position: nearest(positions, anchor.start) };
  },
  ordinal: (text, anchor) => {
    const positions = positionsOf(text, anchor.quote);
    if (!positions.length) return { status: 'unresolved' };
    const chosen = nearest(positions, anchor.start);
    const rank = positions.indexOf(chosen) + 1;
    return rank === anchor.occurrence ? { status: 'verified', position: chosen } : { status: 'needs_reattribution', detail: `ordinal ${anchor.occurrence} → ${rank}` };
  },
  context: (text, anchor) => {
    const positions = positionsOf(text, anchor.quote);
    if (!positions.length) return { status: 'unresolved' };
    const matching = positions.filter((position) => contextAt(text, position, position + anchor.quote.length) === anchor.fingerprint);
    if (!matching.length) return { status: 'needs_reattribution', detail: 'no context match' };
    return { status: 'verified', position: nearest(matching, anchor.start) };
  },
  'ordinal+context': (text, anchor) => {
    const ordinal = RESOLVERS.ordinal(text, anchor);
    if (ordinal.status !== 'verified') return ordinal;
    return RESOLVERS.context(text, anchor);
  },
  // Identity fixed at creation; resolution reports what it can and cannot verify.
  refined: (text, anchor) => {
    const positions = positionsOf(text, anchor.quote);
    if (!positions.length) return { status: 'unresolved' };
    const matching = positions.filter((position) => contextAt(text, position, position + anchor.quote.length) === anchor.fingerprint);
    if (matching.length === 1) return { status: 'verified', position: matching[0] };
    if (matching.length > 1) return { status: 'ambiguous', detail: `${matching.length} occurrences share the recorded context` };
    return { status: 'needs_reattribution', detail: 'context drifted with no matching occurrence' };
  },
};

// ------------------------------------------------------------------ run

const SCENES = { main: MAIN, three: THREE, block: BLOCK_SCENE, collision: COLLISION, collision2: COLLISION2 };
const results = [];
const totals = {};
for (const strategy of Object.keys(RESOLVERS)) totals[strategy] = { verified_correct: 0, verified_wrong: 0, ambiguous: 0, needs_reattribution: 0, unresolved: 0 };

for (const edit of EDITS) {
  const base = SCENES[edit.base];
  const baseScene = sceneOf(base, edit.base === 'block' ? BLOCK : QUOTE);
  const anchors = anchorsOf(baseScene);
  const editedScene = sceneOf(edit.apply(base), edit.base === 'block' ? BLOCK : QUOTE);
  const row = { id: edit.id, name: edit.name, strategies: {} };

  for (const [strategy, resolve] of Object.entries(RESOLVERS)) {
    const outcomes = anchors.map((anchor) => {
      const result = resolve(editedScene.text, anchor);
      if (result.status !== 'verified') return { status: result.status, tag: anchor.tag, detail: result.detail ?? null };
      const found = editedScene.occurrences.find((occurrence) => occurrence.start === result.position)?.tag ?? null;
      return { status: found === anchor.tag ? 'verified_correct' : 'verified_wrong', tag: anchor.tag, found };
    });
    row.strategies[strategy] = outcomes;
    for (const outcome of outcomes) totals[strategy][outcome.status] += 1;
  }
  results.push(row);
}

for (const row of results) {
  console.log(`\n${row.id} ${row.name}`);
  for (const [strategy, outcomes] of Object.entries(row.strategies)) {
    console.log(`  ${strategy.padEnd(18)} ${outcomes.map((outcome) => `${outcome.tag ?? '?'}:${outcome.status}`).join(' ')}`);
  }
}

console.log('\ntotals:');
for (const [strategy, counts] of Object.entries(totals)) {
  console.log(`  ${strategy.padEnd(18)} ${Object.entries(counts).map(([key, value]) => `${key}=${value}`).join(' ')}`);
}

const safe = Object.entries(totals).filter(([, counts]) => counts.verified_wrong === 0);
console.log('\nzero silent misattribution:', safe.map(([strategy]) => strategy).join(', ') || 'none');
console.log('silently misattributes:', Object.entries(totals).filter(([, counts]) => counts.verified_wrong > 0).map(([strategy, counts]) => `${strategy} (${counts.verified_wrong})`).join(', ') || 'none');
const collisionRow = results.find((row) => row.id === 'E11');
console.log('collision scene statuses:', Object.entries(collisionRow.strategies).map(([strategy, outcomes]) => `${strategy}=${outcomes.map((outcome) => outcome.status).join('/')}`).join(' '));
