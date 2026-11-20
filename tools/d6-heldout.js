/**
 * D6 held-out evaluation — does the declared capability contract survive unfamiliar code?
 *
 * Two independent blocks:
 *   1. a held-out corpus (inventory/ + adapters/decision/) whose expected edges were transcribed with a
 *      different instrument than the extractor's parser
 *   2. authored fixtures for the six shapes named before the run: aliasing, shadowing, multiline
 *      imports, re-export chains, cycles, unresolved and mixed file types
 *
 * The fixtures encode truth by construction. A failing assertion here is a finding about the contract,
 * not a number to adjust.
 *
 * Usage: node tools/d6-heldout.js
 */

import { readFile } from 'node:fs/promises';

import { EXTRACTOR, edgeId, extractScope } from './d6-extract.js';

const ROOT = new URL('../', import.meta.url);
const oracle = JSON.parse(await readFile(new URL('pilot/d6/heldout-oracle.json', ROOT), 'utf8'));

let checks = 0;
let failed = 0;
const assert = (name, condition, detail = '') => {
  checks += 1;
  if (!condition) failed += 1;
  console.log(`  ${condition ? 'ok  ' : 'FAIL'} ${name}${condition || !detail ? '' : ` — ${detail}`}`);
};
const key = (edge) => `${edge.from}>${edge.to}`;
const round = (value) => Number(value.toFixed(3));

// ------------------------------------------------------------------ 1. held-out corpus

console.log(`\nheld-out corpus — ${oracle.heldout_corpus.length} files not used while writing the extractor`);
const scope = await extractScope({ files: oracle.heldout_corpus, type: 'imports_module' });
const expected = new Set(oracle.heldout_edges.map(key));
const predicted = new Set(scope.edges.map(key));
const hits = [...predicted].filter((entry) => expected.has(entry));
const unsupported = [...predicted].filter((entry) => !expected.has(entry));
const missed = [...expected].filter((entry) => !predicted.has(entry));
console.log(`  status=${scope.status} coverage ${scope.coverage.files_extracted}/${scope.coverage.files_declared} complete=${scope.coverage.complete}`);
console.log(`  predicted=${predicted.size} oracle=${expected.size} hits=${hits.length} precision=${round(hits.length / predicted.size)} recall=${round(hits.length / expected.size)}`);
if (unsupported.length) console.log(`  unsupported: ${unsupported.join(', ')}`);
if (missed.length) console.log(`  missed: ${missed.join(', ')}`);

assert('held-out scope status is ok', scope.status === 'ok', scope.status);
assert('held-out coverage is complete', scope.coverage.complete === true);
assert('no unsupported relationship claims on held-out code', unsupported.length === 0, unsupported.join(', '));
assert('every held-out oracle edge was found', missed.length === 0, missed.join(', '));
assert('held-out precision is 1.000', hits.length === predicted.size, `${hits.length}/${predicted.size}`);
assert('held-out edge count matches the oracle', predicted.size === expected.size, `${predicted.size} vs ${expected.size}`);

const heldoutRefs = await extractScope({ files: oracle.heldout_corpus, type: 'references_symbol' });
assert('held-out reference extraction reports no gaps', heldoutRefs.coverage.gaps.length === 0, JSON.stringify(heldoutRefs.coverage.gaps));
assert('held-out reference extraction finds uses', heldoutRefs.edges.length > 0, String(heldoutRefs.edges.length));

// ------------------------------------------------------------------ 2. aliasing

console.log('\nfixtures — six shapes declared before the run');
const aliased = await extractScope({ files: oracle.fixtures.aliased.files, type: 'references_symbol' });
const aliasedImport = await extractScope({ files: oracle.fixtures.aliased.files, type: 'imports_module' });
assert('aliased import produces the module edge', aliasedImport.edges.length === 1 && aliasedImport.edges[0].to === 'external:node:path');
assert('reference identity carries the imported name, not the alias', aliased.edges.length === 1 && aliased.edges[0].symbol === 'join');
assert('the alias is not mistaken for a symbol', !aliased.edges.some((edge) => edge.symbol === 'pathJoin'));

// ------------------------------------------------------------------ 3. shadowing

console.log('\nshadowing — a lexical count is not a binding');
const shadowed = await extractScope({ files: oracle.fixtures.shadowed.files, type: 'references_symbol' });
const shadowedImport = await extractScope({ files: oracle.fixtures.shadowed.files, type: 'imports_module' });
assert('the shadowed import still produces a module edge', shadowedImport.edges.length === 1);
assert('no reference edge is claimed for a shadowed binding', shadowed.edges.length === 0, shadowed.edges.map((edge) => edge.symbol).join(','));
assert('the gap is reported, not dropped', shadowed.coverage.gaps.length === 1 && shadowed.coverage.gaps[0].reason.includes('shadowed_binding'));
assert('the gap makes reference coverage incomplete', shadowed.coverage.complete === false);
assert('with no edges and a gap the answer is edges_unknown, not no_edges', shadowed.status === 'edges_unknown' && shadowed.reason === 'coverage_incomplete');

// ------------------------------------------------------------------ 4. multiline

console.log('\nmultiline — a line-start parser would call this no_edges');
const multilineImport = await extractScope({ files: oracle.fixtures.multiline.files, type: 'imports_module' });
const multilineRefs = await extractScope({ files: oracle.fixtures.multiline.files, type: 'references_symbol' });
assert('multiline import is extracted', multilineImport.status === 'ok' && multilineImport.edges.length === 1);
assert('multiline import resolves its specifier', multilineImport.edges[0].to === 'external:node:fs/promises');
assert('both multiline bindings are seen as references', new Set(multilineRefs.edges.map((edge) => edge.symbol)).size === 2, multilineRefs.edges.map((edge) => edge.symbol).join(','));

// ------------------------------------------------------------------ 5. re-export chain

console.log('\nre-export chain — one hop with evidence, never the transitive claim');
const chain = await extractScope({ files: oracle.fixtures.chain.files, type: 'reexports_symbol' });
const chainKeys = new Set(chain.edges.map(key));
assert('both direct hops are reported', oracle.fixtures.chain.reexports.every((edge) => chainKeys.has(key(edge))), [...chainKeys].join(','));
assert('the transitive hop is not claimed', !chainKeys.has(key(oracle.fixtures.chain.forbidden[0])));
assert('chain extraction covers all three files', chain.coverage.files_declared === 3 && chain.coverage.complete === true);

// ------------------------------------------------------------------ 6. cycles and unresolved

console.log('\ncycles and unresolved specifiers');
const cyclic = await extractScope({ files: oracle.fixtures.cyclic.files, type: 'imports_module' });
assert('a cycle produces both directed edges', cyclic.edges.length === 2, String(cyclic.edges.length));
assert('cyclic edges are distinct identities', new Set(cyclic.edges.map((edge) => edge.relationship_id)).size === 2);
assert('the cycle does not duplicate edges', new Set(cyclic.edges.map(key)).size === 2);

const unresolved = await extractScope({ files: oracle.fixtures.unresolved.files, type: 'imports_module' });
assert('an unresolved specifier is retained as an edge', unresolved.edges.length === 1);
assert('it is marked unresolved with a reason', unresolved.edges[0].resolution === 'unresolved' && unresolved.edges[0].resolution_reason === 'specifier_not_found');
assert('it is not promoted to a resolved dependency', unresolved.edges[0].resolution !== 'resolved');

// ------------------------------------------------------------------ 7. mixed file types

console.log('\nmixed types — one unsupported file keeps the scope unknown');
const mixed = await extractScope({ files: oracle.fixtures.mixed.files, type: 'imports_module' });
const mixedEdges = await extractScope({ files: ['pilot/d6/heldout/unresolved.js', 'pilot/d6/heldout/unsupported.ts'], type: 'imports_module' });
assert('a scope with only a plain .js and an unsupported type is edges_unknown', mixed.status === oracle.fixtures.mixed.expect_status && mixed.reason === oracle.fixtures.mixed.expect_reason, `${mixed.status}/${mixed.reason}`);
assert('a scope with some edges and one unsupported file is partial, not complete', mixedEdges.status === 'ok' && mixedEdges.coverage.complete === false);
assert('partial results still name the excluded file', mixedEdges.coverage.files_outside_capability.some((entry) => entry.file.endsWith('.ts')));

// ------------------------------------------------------------------ 8. extractor declaration

assert('the extractor declares its limits in-band', EXTRACTOR.limits.length >= 5 && EXTRACTOR.capabilities.depends_on === 'unsupported');
assert('identity is independent of version and evidence', edgeId('imports_module', 'a.js', 'b.js') === edgeId('imports_module', 'a.js', 'b.js'));

console.log(`\nD6 held-out evaluation: ${checks - failed}/${checks} checks passed`);
process.exit(failed === 0 ? 0 : 1);
