/**
 * D6 evaluation — does the declared extractor answer truthfully about relationships it can and cannot see?
 *
 * Measures, against the hand-declared oracle in pilot/d6/oracle.json:
 *   precision, recall, and unsupported relationship claims (predicted edges absent from the oracle)
 *
 * And asserts the contract's distinctions, which are not precision questions:
 *   edges_unknown (cannot answer) vs no_edges (answered none)
 *   imports_module vs references_symbol (an import is not a use)
 *   relationship identity vs extraction provenance (one edge, many proofs)
 *
 * Usage: node tools/d6-eval.js
 */

import { readFile } from 'node:fs/promises';

import { EXTRACTOR, edgeId, extractScope } from './d6-extract.js';

const ROOT = new URL('../', import.meta.url);
const oracle = JSON.parse(await readFile(new URL('pilot/d6/oracle.json', ROOT), 'utf8'));

let checks = 0;
let failed = 0;
const assert = (name, condition, detail = '') => {
  checks += 1;
  if (!condition) failed += 1;
  console.log(`  ${condition ? 'ok  ' : 'FAIL'} ${name}${condition || !detail ? '' : ` — ${detail}`}`);
};

const key = (edge) => `${edge.from}>${edge.to}`;
const round = (value) => Number(value.toFixed(3));

// ------------------------------------------------------------------ 1. real corpus: precision and recall

console.log(`\nD6 corpus — ${oracle.corpus.length} files, oracle authored ${oracle.declared_at}`);
const corpus = await extractScope({ files: oracle.corpus, type: 'imports_module' });
const expected = oracle.edges.filter((edge) => edge.type === 'imports_module');
const predicted = new Set(corpus.edges.map(key));
const declared = new Set(expected.map(key));
const hits = [...predicted].filter((entry) => declared.has(entry));
const unsupported = [...predicted].filter((entry) => !declared.has(entry));
const missed = [...declared].filter((entry) => !predicted.has(entry));

console.log(`  status=${corpus.status} coverage ${corpus.coverage.files_extracted}/${corpus.coverage.files_declared} complete=${corpus.coverage.complete}`);
console.log(`  predicted=${predicted.size} oracle=${declared.size} hits=${hits.length} precision=${round(hits.length / predicted.size)} recall=${round(hits.length / declared.size)}`);
if (unsupported.length) console.log(`  unsupported claims: ${unsupported.join(', ')}`);
if (missed.length) console.log(`  missed: ${missed.join(', ')}`);

assert('scope status is ok', corpus.status === 'ok', corpus.status);
assert('coverage is complete', corpus.coverage.complete === true);
assert('every predicted edge is in the oracle (no unsupported claims)', unsupported.length === 0, unsupported.join(', '));
assert('every oracle edge was found (recall 1.0)', missed.length === 0, missed.join(', '));
assert('precision is 1.000', hits.length === predicted.size, `${hits.length}/${predicted.size}`);
assert('edge count matches the oracle', predicted.size === declared.size, `${predicted.size} vs ${declared.size}`);
assert('external and internal edges are both represented', corpus.edges.some((edge) => edge.resolution === 'external') && corpus.edges.some((edge) => edge.resolution === 'resolved'));
assert('every edge carries extractor provenance', corpus.edges.every((edge) => edge.provenance.extractor === EXTRACTOR.name && edge.provenance.extractor_version === EXTRACTOR.version));

// ------------------------------------------------------------------ 2. synthetic fixture: use is not import

console.log('\nfixture — an import is not a use');
const fixtureEdges = await extractScope({ files: [oracle.fixture.file], type: 'imports_module' });
const reexports = await extractScope({ files: [oracle.fixture.file], type: 'reexports_symbol' });
const references = await extractScope({ files: [oracle.fixture.file], type: 'references_symbol' });
const unresolved = fixtureEdges.edges.filter((edge) => edge.resolution === 'unresolved');
console.log(`  imports=${fixtureEdges.edges.length} (unresolved ${unresolved.length}) reexports=${reexports.edges.length} references=${references.edges.map((edge) => edge.symbol).join(',')}`);

assert('fixture import edges match the oracle', new Set(fixtureEdges.edges.map(key)).size === oracle.fixture.edges.filter((edge) => edge.type === 'imports_module').length);
assert('the unresolved specifier is retained, not dropped', unresolved.length === 1 && unresolved[0].resolution_reason === 'specifier_not_found');
assert('the re-export is a different relationship type', reexports.edges.length === 1 && reexports.edges[0].type === 'reexports_symbol');
assert('the re-export resolves to a real file', reexports.edges[0].resolution === 'resolved' && reexports.edges[0].to === 'src/canonical.js');
assert('only the used binding produces a reference edge', references.edges.length === 1 && references.edges[0].symbol === 'join');
assert('an imported but unused symbol produces no reference edge', !references.edges.some((edge) => edge.symbol === 'readFile'));
assert('a symbol named only in a comment or string is not a reference', !references.edges.some((edge) => edge.symbol === 'readFile'));
assert('an import of a missing module produces no reference edge', !references.edges.some((edge) => edge.symbol === 'locate'));

// ------------------------------------------------------------------ 3. status discipline

console.log('\nstatus discipline — cannot answer vs answered none');
const unsupportedType = await extractScope({ files: oracle.corpus, type: 'depends_on' });
const noEdges = await extractScope({ files: ['pilot/d6/fixtures/no-imports.js'], type: 'imports_module' });
const coverageGap = await extractScope({ files: ['pilot/d6/fixtures/unsupported.ts'], type: 'imports_module' });
const mixedGap = await extractScope({ files: ['pilot/d6/fixtures/no-imports.js', 'pilot/d6/fixtures/unsupported.ts'], type: 'imports_module' });
console.log(`  depends_on=${unsupportedType.status} (${unsupportedType.reason}) no_imports=${noEdges.status} coverage_gap=${coverageGap.status} mixed=${mixedGap.status}`);

assert('an undeclared capability yields edges_unknown, not no_edges', unsupportedType.status === 'edges_unknown' && unsupportedType.reason.includes('capability_unsupported'));
assert('semantic dependency is not claimed from import evidence', unsupportedType.edges.length === 0);
assert('a file that genuinely has no imports yields no_edges', noEdges.status === 'no_edges');
assert('no_edges still reports coverage', noEdges.coverage.complete === true && noEdges.coverage.files_extracted === 1);
assert('an unsupported language yields edges_unknown, not no_edges', coverageGap.status === 'edges_unknown' && coverageGap.reason === 'coverage_incomplete');
assert('one unsupported file keeps the whole scope unknown rather than empty', mixedGap.status === 'edges_unknown' && mixedGap.coverage.complete === false);
assert('the coverage gap names the file and the reason', mixedGap.coverage.files_outside_capability.some((entry) => entry.file.endsWith('.ts') && entry.reason.includes('language_not_declared')));

// ------------------------------------------------------------------ 4. identity vs provenance

console.log('\nidentity vs provenance');
const mergeEdges = (edges) => {
  const merged = new Map();
  for (const edge of edges) {
    const existing = merged.get(edge.relationship_id);
    if (!existing) merged.set(edge.relationship_id, { ...edge, provenance: [edge.provenance] });
    else if (!existing.provenance.some((proof) => proof.extractor === edge.provenance.extractor && proof.extractor_version === edge.provenance.extractor_version)) existing.provenance.push(edge.provenance);
  }
  return merged;
};

const [sample] = corpus.edges;
const imitation = { ...sample, relationship_id: edgeId(sample.type, sample.from, sample.to), evidence: { line: 999, specifier: 'imitation', form: 'named' }, provenance: { extractor: 'code.esm.ast', extractor_version: '2.0.0', method: 'ast' } };
const merged = mergeEdges([sample, imitation]);
console.log(`  edges=${merged.size} proofs=${[...merged.values()][0].provenance.length}`);

assert('two extractors reporting one relationship share one identity', merged.size === 1);
assert('the shared identity keeps both independent proofs', [...merged.values()][0].provenance.length === 2);
assert('provenance is not part of the identity: different evidence, same id', sample.relationship_id === imitation.relationship_id);
assert('symbol references include the symbol in their identity', edgeId('references_symbol', sample.from, sample.to, 'a') !== edgeId('references_symbol', sample.from, sample.to, 'b'));
assert('an import edge is not identifiable with a reference edge', edgeId('imports_module', sample.from, sample.to) !== edgeId('references_symbol', sample.from, sample.to, 'a'));

// ------------------------------------------------------------------ summary

console.log(`\nD6 evaluation: ${checks - failed}/${checks} checks passed`);
process.exit(failed === 0 ? 0 : 1);
