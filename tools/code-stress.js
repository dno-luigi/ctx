/**
 * Code-corpus stress test of the information model.
 *
 * Four probes, all deterministic, no model call, no file modification:
 *
 *   A  identity under repetition   — do distinct occurrences of the same line collapse to one id?
 *   B  constraints in code         — do the inventory rules see guards, refusals and limits?
 *   C  relationships in code       — do they see imports, i.e. the edges RDA propagates over?
 *   D  differential update         — does a rename break exactly what changed, and are dependents
 *                                    discoverable at all?
 *
 * The point is to find out which parts of INFORMATION-MODEL-01 are safe to build on for code,
 * before an ARA schema turns an assumption into a table.
 *
 * Usage: node tools/code-stress.js
 * Writes: runs/code-stress/report.json
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';

import { anchorId, resolveAnchor } from '../cards/identity.js';
import { scanCoverageRules } from '../inventory/rules-coverage.js';

const ROOT = new URL('../', import.meta.url);
const corpus = JSON.parse(await readFile(new URL('pilot/code/corpus.json', ROOT), 'utf8'));
const oracle = JSON.parse(await readFile(new URL('pilot/code/constraints-oracle.json', ROOT), 'utf8'));

const texts = new Map();
for (const file of corpus.files) texts.set(file, await readFile(new URL(file, ROOT), 'utf8'));

/** Line records with absolute offsets, so spans and lines can be compared. */
function linesOf(text) {
  const out = [];
  let start = 0;
  for (const raw of text.split('\n')) {
    const leading = raw.length - raw.trimStart().length;
    const trimmed = raw.trim();
    out.push({ start: start + leading, end: start + leading + trimmed.length, text: trimmed, rawStart: start });
    start += raw.length + 1;
  }
  return out;
}

const overlaps = (span, line) => span.start < line.end && span.end > line.start;

// ---------------------------------------------------------------- probe A: identity under repetition

function probeIdentity() {
  const rows = [];
  for (const [file, text] of texts) {
    const lines = linesOf(text).filter((line) => line.text.length >= 8);
    const byQuote = new Map();
    for (const line of lines) {
      const key = line.text;
      if (!byQuote.has(key)) byQuote.set(key, []);
      byQuote.get(key).push(line);
    }
    const repeated = [...byQuote.entries()].filter(([, occurrences]) => occurrences.length > 1);
    const colliding = repeated.reduce((sum, [, occurrences]) => sum + occurrences.length, 0);
    const worst = repeated.sort((a, b) => b[1].length - a[1].length)[0] ?? null;

    // Two distinct occurrences of the same line: same id, different places.
    let identityCollapses = null;
    if (worst) {
      const [quote, occurrences] = worst;
      const id = anchorId({ source_id: file, quote });
      const probe = occurrences.slice(0, 2).map((line) => ({ anchor_id: id, quote, locator: { source_id: file, start: line.start, end: line.end } }));
      const resolved = probe.map((anchor) => resolveAnchor({ sources: [{ id: file, content: { text } }] }, anchor));
      identityCollapses = {
        quote: quote.slice(0, 60),
        occurrences: occurrences.length,
        distinct_anchor_ids: 1,
        resolves_independently: resolved.every((result, index) => result.ok && result.span.start === probe[index].locator.start),
        modes: resolved.map((result) => result.mode),
      };
    }

    rows.push({
      file,
      lines: lines.length,
      distinct_quotes: byQuote.size,
      repeated_quotes: repeated.length,
      occurrences_in_repetition: colliding,
      collision_rate: lines.length ? Number((colliding / lines.length).toFixed(3)) : 0,
      worst_quote: worst ? { quote: worst[0].slice(0, 60), occurrences: worst[1].length } : null,
      identity_collapse: identityCollapses,
    });
  }
  return rows;
}

// ---------------------------------------------------------------- probe B: constraints in code

function probeConstraints() {
  const ruleItems = new Map();
  for (const [file, text] of texts) {
    const scan = scanCoverageRules({ sources: [{ id: file, kind: 'code', content: { text } }] });
    ruleItems.set(file, scan);
  }

  const results = [];
  for (const item of oracle.items) {
    const text = texts.get(item.file);
    if (!text) {
      results.push({ ...item, found: false, reason: 'file not in corpus' });
      continue;
    }
    const lines = linesOf(text);
    const line = lines.find((entry) => entry.text.includes(item.fragment));
    if (!line) {
      results.push({ ...item, found: false, reason: 'fragment not located — oracle item is wrong' });
      continue;
    }
    const items = ruleItems.get(item.file).items;
    const hit = items.find((candidate) => (candidate.spans ?? []).some((span) => span.source_id === item.file && overlaps(span.span, line)));
    results.push({
      id: item.id,
      file: item.file,
      class: item.class,
      found: Boolean(hit),
      by_kind: hit?.kind ?? null,
      by_quote: hit ? String(hit.spans[0].quote).slice(0, 70) : null,
      line: line.text.slice(0, 70),
    });
  }

  const byKind = {};
  let emitted = 0;
  for (const [, scan] of ruleItems) {
    emitted += scan.items.length;
    for (const [kind, count] of Object.entries(scan.counts)) byKind[kind] = (byKind[kind] ?? 0) + count;
  }
  const found = results.filter((result) => result.found).length;
  return {
    oracle_items: oracle.items.length,
    found,
    recall: Number((found / oracle.items.length).toFixed(3)),
    found_by_constraint_rule: results.filter((result) => result.by_kind === 'structural_constraint').length,
    emitted_items: emitted,
    emitted_by_kind: byKind,
    results,
  };
}

// ---------------------------------------------------------------- probe C: relationships (imports)

const IMPORT = /(?:import\s[^;\n]*?from\s*|require\()\s*['"](\.[^'"]+)['"]/g;

function probeRelationships() {
  const resolvePath = (fromFile, specifier) => {
    const base = fromFile.split('/').slice(0, -1);
    for (const part of specifier.split('/')) {
      if (part === '.' || part === '') continue;
      if (part === '..') base.pop();
      else base.push(part);
    }
    const joined = base.join('/');
    return corpus.files.find((file) => file === joined || file === `${joined}.js`);
  };

  const edges = [];
  const importLines = new Map();
  for (const [file, text] of texts) {
    IMPORT.lastIndex = 0;
    let match;
    while ((match = IMPORT.exec(text)) !== null) {
      const target = resolvePath(file, match[1]);
      if (!target || target === file) continue;
      edges.push({ from: file, to: target });
      if (!importLines.has(file)) importLines.set(file, []);
      importLines.get(file).push({ index: match.index, text: match[0] });
    }
  }

  let covered = 0;
  const details = [];
  for (const [file, entries] of importLines) {
    const text = texts.get(file);
    const lines = linesOf(text);
    const items = scanCoverageRules({ sources: [{ id: file, kind: 'code', content: { text } }] }).items;
    for (const entry of entries) {
      const line = lines.find((candidate) => entry.index >= candidate.rawStart && entry.index <= candidate.rawStart + candidate.text.length + 1) ?? null;
      const hit = line ? items.find((item) => (item.spans ?? []).some((span) => overlaps(span.span, line))) : null;
      if (hit) covered += 1;
      details.push({ file, import: entry.text.slice(0, 60), recorded: Boolean(hit), by_kind: hit?.kind ?? null });
    }
  }
  return {
    intra_corpus_edges: edges.length,
    edges: edges.map((edge) => `${edge.from} -> ${edge.to}`),
    import_statements: details.length,
    imports_with_any_recorded_relationship: covered,
    relationship_coverage: details.length ? Number((covered / details.length).toFixed(3)) : null,
    details,
  };
}

// ---------------------------------------------------------------- probe D: differential update

function probeUpdate() {
  const { file, symbol, replacement } = corpus.rename_target;
  const before = texts.get(file);
  const after = before.replace(new RegExp(`\\b${symbol}\\b`, 'g'), replacement);

  const idsOf = (text) => {
    const map = new Map();
    for (const line of linesOf(text)) {
      if (line.text.length < 8) continue;
      const id = anchorId({ source_id: file, quote: line.text });
      if (!map.has(id)) map.set(id, []);
      map.get(id).push(line.text);
    }
    return map;
  };

  const beforeIds = idsOf(before);
  const afterIds = idsOf(after);
  const survived = [...beforeIds.keys()].filter((id) => afterIds.has(id)).length;
  const broke = [...beforeIds.keys()].filter((id) => !afterIds.has(id));
  const brokeQuotes = broke.map((id) => beforeIds.get(id)[0].slice(0, 70));
  const allBrokeMentionSymbol = brokeQuotes.every((quote) => quote.includes(symbol));

  let dependents = 0;
  const dependentFiles = [];
  for (const [other, text] of texts) {
    if (other === file) continue;
    const count = (text.match(new RegExp(`\\b${symbol}\\b`, 'g')) ?? []).length;
    if (count) {
      dependents += count;
      dependentFiles.push({ file: other, references: count });
    }
  }

  return {
    file,
    symbol,
    anchors_before: beforeIds.size,
    anchors_survived: survived,
    anchors_broke: broke.length,
    survival_rate: Number((survived / beforeIds.size).toFixed(3)),
    every_break_mentions_the_renamed_symbol: allBrokeMentionSymbol,
    broke_examples: brokeQuotes.slice(0, 4),
    textual_dependents_in_corpus: dependents,
    dependent_files: dependentFiles,
    recorded_edges_incoming: 0,
    recorded_edges_outgoing: 0,
  };
}

// ---------------------------------------------------------------- run

const identity = probeIdentity();
const constraints = probeConstraints();
const relationships = probeRelationships();
const update = probeUpdate();
// Direction matters: propagation must reach files that *use* the changed one, so incoming edges are
// the ones a differential update would have to traverse.
update.recorded_edges_incoming = relationships.edges.filter((edge) => edge.endsWith(`-> ${update.file}`)).length;
update.recorded_edges_outgoing = relationships.edges.filter((edge) => edge.startsWith(`${update.file} ->`)).length;

const report = {
  schema: 'gca-code-stress/v1',
  at: new Date().toISOString(),
  corpus: { files: corpus.files.length, independence: corpus.independence },
  model_calls: 0,
  identity,
  constraints,
  relationships,
  update,
};

await mkdir(new URL('runs/code-stress/', ROOT), { recursive: true });
await writeFile(new URL('runs/code-stress/report.json', ROOT), `${JSON.stringify(report, null, 2)}\n`);

console.log('A identity under repetition');
for (const row of identity) {
  console.log(`  ${row.file}: ${row.occurrences_in_repetition}/${row.lines} lines share an identity (${row.collision_rate}); worst line repeats ${row.worst_quote?.occurrences ?? 0}x`);
}
const collapsed = identity.filter((row) => row.identity_collapse?.distinct_anchor_ids === 1);
console.log(`  distinct occurrences collapsing to one anchor id: ${collapsed.length}/${identity.length} files; still resolvable independently: ${identity.filter((row) => row.identity_collapse?.resolves_independently).length}/${identity.length}`);

console.log('\nB constraints in code');
console.log(`  oracle ${constraints.oracle_items} constraints, found ${constraints.found} (recall ${constraints.recall}); via the constraint rule: ${constraints.found_by_constraint_rule}`);
console.log(`  emitted ${constraints.emitted_items} items: ${JSON.stringify(constraints.emitted_by_kind)}`);

console.log('\nC relationships in code');
console.log(`  intra-corpus import edges: ${relationships.intra_corpus_edges}; import statements with any recorded item: ${relationships.imports_with_any_recorded_relationship}/${relationships.import_statements}`);

console.log('\nD differential update');
console.log(`  rename ${update.symbol}: ${update.anchors_survived}/${update.anchors_before} anchors survive; ${update.anchors_broke} break; all breaks mention the symbol: ${update.every_break_mentions_the_renamed_symbol}`);
console.log(`  textual dependents in other files: ${update.textual_dependents_in_corpus} (${update.dependent_files.map((entry) => `${entry.file} x${entry.references}`).join(', ') || 'none'})`);
console.log(`  recorded edges: incoming ${update.recorded_edges_incoming}, outgoing ${update.recorded_edges_outgoing}`);
console.log('\nwrote runs/code-stress/report.json');
