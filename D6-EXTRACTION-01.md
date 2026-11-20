# D6-EXTRACTION-01 — extraction contract

**Date:** 2026-11-18 · **Cost:** $0, offline, no model calls.
**Scope:** an isolated extraction-contract investigation. **It does not modify the frozen baseline**
(`ARA-FREEZE-01`, 12 artifacts, `78d98b58…`) and does not implement ARA.
**Instruments:** `tools/d6-extract.js` (declared extractor), `tools/d6-eval.js` (28/28), `pilot/d6/oracle.json`.

**Result: the contract can separate "I cannot answer" from "there are no relationships", and it refuses
to derive semantic dependency from import evidence.** Precision and recall are 1.000 on a small declared
corpus, which is **not** evidence of general accuracy — see §6.

---

## 1. The contract, independent of any store

The extractor returns edges, evidence and a capability/coverage report. It has no knowledge of ARA
records, identity hashing beyond the relationship id, retrieval, or persistence.

**Declared capability** (`EXTRACTOR.capabilities`):

| Relation type | Capability | Meaning |
| --- | --- | --- |
| `imports_module` | supported | file A has a static import of module B |
| `reexports_symbol` | supported | A re-exports a symbol from B |
| `references_symbol` | supported | A uses a locally bound imported name (lexical) |
| `depends_on` | **unsupported** | semantic necessity — not derivable from imports |
| `calls_symbol` | **unsupported** | requires binding resolution, not lexical matching |

Anything not declared is `edges_unknown` with `capability_not_declared` — never `no_edges`. That is the
whole point: an extractor's limits must not be reported as the world's emptiness.

## 2. Status algebra

| Status | Condition |
| --- | --- |
| `ok` | ≥1 edge, coverage complete |
| `ok` (partial) | ≥1 edge, some declared files outside capability (`coverage.complete = false`) |
| `no_edges` | ran over complete coverage and found nothing |
| `edges_unknown` | cannot answer: `capability_not_declared`, `capability_unsupported`, `coverage_incomplete` |

An unresolved relative specifier is **retained** as an edge with `resolution: 'unresolved'` and
`resolution_reason: 'specifier_not_found'`. It is not dropped (which would look like absence) and not
promoted to a resolved dependency (which would look like knowledge).

## 3. Identity versus provenance

```
relationship_id = H(type, from, to, symbol?)     stable, extractor-independent
provenance      = { extractor, extractor_version, method }   one per independent proof
evidence        = { line, specifier, form }                   where this proof saw it
```

Two extractors reporting the same relationship produce **one** identity with **two** provenance entries.
Different extractor versions do not fork the edge; they accumulate proofs. Provenance is never part of
`relationship_id` — otherwise the same relationship discovered twice would become two relationships.

## 4. Measured — precedence, recall, unsupported claims

Corpus: 8 declared files, oracle hand-transcribed from their import statements before the extractor ran.

| Metric | Value |
| --- | --- |
| predicted edges | 22 |
| oracle edges | 22 |
| precision | **1.000** |
| recall | **1.000** |
| unsupported relationship claims | **0** |
| coverage | 8/8, complete |

## 5. Measured — the distinctions that are not precision

The synthetic fixture (`pilot/d6/fixtures/edge-cases.js`) exists because the real corpus has **no**
unused import: every imported symbol in the 8 files is referenced. So the negative case is authored:

| Claim | Result |
| --- | --- |
| import ≠ use | `readFile` imported, never called → import edge only, no reference edge |
| comment/string ≠ reference | `readFile` named in a comment and in a string → still no reference edge |
| used import | `join` called once → one `references_symbol` edge |
| unresolved ≠ absent | `./missing-module.js` retained with `resolution: unresolved` |
| re-export is its own type | `export { digest } from …` → `reexports_symbol`, resolved |
| import of a missing module ≠ reference | `locate` never used → no reference edge |

Status discipline:

| Scope | Status |
| --- | --- |
| `depends_on` over the corpus | `edges_unknown` / `capability_unsupported` |
| `pilot/d6/fixtures/no-imports.js` | `no_edges`, coverage complete |
| `pilot/d6/fixtures/unsupported.ts` | `edges_unknown` / `coverage_incomplete` |
| `.js` with no imports + `.ts` together | `edges_unknown` / `coverage_incomplete` — **not** `no_edges` |

That last row is the one that matters most: one file outside capability makes the scope's answer unknown,
because reporting `no_edges` there would assert a fact the extractor did not establish.

## 6. Why 22/22 is a weak result

- The extractor was written against the same 8 files the oracle describes. There is **no held-out
  sample**; 1.000 precision says the two transcriptions agree, not that the parser generalises.
- 22 edges is a small denominator, and every one is a line-leading static import. Multi-line imports,
  aliasing, dynamic imports in loops and CommonJS are untested.
- Symbol references are **lexical identifier occurrences**, not binding resolution. A shadowed local
  name is counted as a reference; that limit is declared in `EXTRACTOR.limits`, not discovered later.
- No `.ts`, no `require()`, no alias/tsconfig resolution → those are `edges_unknown`, by design.

## 7. What this settles for the gate

| Question | Answer |
| --- | --- |
| Can ARA distinguish extraction failure from absence? | **yes**, as an explicit status algebra |
| Is an import the same relationship as a use? | **no** — different type, different identity |
| Is an import a semantic dependency? | **no** — `depends_on` is declared unsupported, so no edge is emitted |
| Is provenance folded into relationship identity? | **no** — one edge, many proofs |

`depends_on` remaining unsupported is deliberate: it means any claim of the form "X depends on Y" cannot
be produced by this extractor at all, rather than being produced with import-level evidence.

## 8. Gate state

| Gate | Status |
| --- | --- |
| D6 extraction contract | **contract + instrument exist**, 28/28; accuracy not yet generalised |
| D1 storage-level AC-3 companion | open |
| D8 cross-store exchange | open |
| replay/projection volume + compaction | open |
| implementation | **closed** |

D6 work sits **outside** the frozen baseline. `node tools/ara-freeze.js --verify` still reports 12/12.

## 9. Verification

```
node tools/d6-eval.js             → 28/28 checks; precision 1.000, recall 1.000, 0 unsupported claims
node tools/d6-extract.js          → imports_module ok (11 edges), references_symbol ok (13), depends_on edges_unknown
node tools/ara-freeze.js --verify → 12/12 baseline artifacts
node tools/schema-acceptance-v2.js → 52/52
node tools/selftest.js            → 52/52
```
