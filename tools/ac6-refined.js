/**
 * AC-6 under the refined identity model (A1′).
 *
 * Same measurement basis as the acceptance suite, so the numbers are comparable: every trimmed line
 * of `src/spans.js` at least 8 characters long is an anchor, occurrence ordinal taken from repeated
 * trimmed lines, revision = rename `locate` → `locateSpan`.
 *
 * Under A1′ identity is H(source, quote, birth_context), and resolution reports a status instead of
 * choosing: verified | ambiguous | needs_reattribution | unresolved. This tool reports occurrence
 * survival, distinct-quote survival, false flags and actual reattributions separately, because on
 * this corpus they are four different counts.
 *
 * Usage: node tools/ac6-refined.js
 */

import { readFile } from 'node:fs/promises';

import { digest } from '../src/canonical.js';

const ROOT = new URL('../', import.meta.url);
const H = (schema, ...parts) => digest({ schema, parts }).slice(0, 20);

const FILE = 'src/spans.js';
const original = await readFile(new URL(FILE, ROOT), 'utf8');
const revised = original.replace(/\blocate\b/g, 'locateSpan');

const normalize = (line) => line.trim().replace(/\s+/g, ' ');

/** Every trimmed line >= 8 chars is an anchor, exactly as AC-6 defines them. */
function anchorsOf(text) {
  const anchors = [];
  const seen = new Map();
  const lines = text.split('\n');
  let offset = 0;
  lines.forEach((line, index) => {
    const quote = line.trim();
    if (quote.length >= 8) {
      const occurrence = (seen.get(quote) ?? 0) + 1;
      seen.set(quote, occurrence);
      const birthContext = `${normalize(lines[index - 1] ?? '')}|${normalize(lines[index + 1] ?? '')}`;
      anchors.push({
        quote,
        occurrence,
        lineIndex: index,
        start: offset,
        fingerprint: birthContext,
        // A1′: identity includes the birth context, so it is fixed at creation and never recomputed.
        anchor_id: `anc_${H('ara/anchor/v2', FILE, quote, String(occurrence), birthContext)}`,
      });
    }
    offset += line.length + 1;
  });
  return anchors;
}

function occurrencesOf(text, quote) {
  const found = [];
  const seen = new Map();
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === quote) {
      const occurrence = (seen.get(quote) ?? 0) + 1;
      seen.set(quote, occurrence);
      found.push(occurrence);
    }
  }
  return found;
}

function contextAtLine(text, quoteOccurrence) {
  const lines = text.split('\n');
  let seen = 0;
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index].trim() !== quoteOccurrence.quote) continue;
    seen += 1;
    if (seen === quoteOccurrence.occurrence) {
      return `${normalize(lines[index - 1] ?? '')}|${normalize(lines[index + 1] ?? '')}`;
    }
  }
  return null;
}

function resolve(anchor) {
  const present = occurrencesOf(revised, anchor.quote);
  if (present.length === 0) return { status: 'unresolved' };
  const matching = present.filter((occurrence) => contextAtLine(revised, { quote: anchor.quote, occurrence }) === anchor.fingerprint);
  if (matching.length === 1) return { status: 'verified', occurrence: matching[0] };
  if (matching.length > 1) return { status: 'ambiguous', candidates: matching };
  return { status: 'needs_reattribution' };
}

const anchors = anchorsOf(original);
const results = anchors.map((anchor) => ({ anchor, ...resolve(anchor) }));

const counts = { verified: 0, ambiguous: 0, needs_reattribution: 0, unresolved: 0 };
for (const result of results) counts[result.status] += 1;

// A reattribution is a *verified* resolution that lands on a different occurrence of the same quote.
const reattributed = results.filter((result) => result.status === 'verified' && result.occurrence !== result.anchor.occurrence);
// Every needs_reattribution on this corpus is a false flag: the quote text is unchanged, only
// neighbouring lines were renamed, so the anchor's referent is intact.
const falseFlags = results.filter((result) => result.status === 'needs_reattribution');
const distinct = new Set(anchors.map((anchor) => anchor.quote));
const survivingQuotes = new Set(results.filter((result) => result.status === 'verified').map((result) => result.anchor.quote));
const ambiguousQuotes = new Set(results.filter((result) => result.status === 'ambiguous').map((result) => result.anchor.quote));

console.log(`AC-6 under A1′ — ${FILE}, ${anchors.length} occurrences, ${distinct.size} distinct quotes`);
console.log(`  verified            ${counts.verified} occurrences / ${survivingQuotes.size} distinct quotes (${((100 * survivingQuotes.size) / distinct.size).toFixed(1)}%)`);
console.log(`  ambiguous           ${counts.ambiguous} occurrences / ${ambiguousQuotes.size} distinct quotes`);
console.log(`  needs_reattribution ${counts.needs_reattribution} occurrences  (false flags: ${falseFlags.length})`);
console.log(`  unresolved          ${counts.unresolved} occurrences  (${results.filter((result) => result.status === 'unresolved').map((result) => result.anchor.quote.slice(0, 34)).join(' | ')})`);
console.log(`  actual reattributions ${reattributed.length}`);
if (falseFlags.length) console.log(`  false-flag lines: ${falseFlags.map((result) => `L${result.anchor.lineIndex + 1} "${result.anchor.quote.slice(0, 26)}"`).join(' | ')}`);
if (ambiguousQuotes.size) console.log(`  ambiguous quotes: ${[...ambiguousQuotes].map((quote) => quote.slice(0, 30)).join(' | ')}`);
