# D6-EXTRACTION-02 — held-out validation

**Date:** 2026-11-18 · **Cost:** $0, offline.
**Subject:** does the declared capability contract survive code it was not written around?
**Instruments:** `tools/d6-heldout.js` (33/33), `pilot/d6/heldout-oracle.json`, `pilot/d6/heldout/` fixtures.
**Increment:** extractor `code.esm.lexical` **v1.0.0 → v1.1.0**. `D6-EXTRACTION-01.md` is preserved unchanged.

**Result: the contract survived, and the run found a real defect in v1.0.0 that the declared limits did
not mention.** Held-out precision and recall are 1.000 on 8 edges; the value of the exercise is the
defect, not the score.

---

## 1. Held-out corpus

Selected by directory rule (`inventory/` and `adapters/decision/`), not by convenience: 10 files, none of
which was open while the extractor was written. Expected edges were transcribed with `grep -rn` — a
different instrument from the extractor's parser — then read line by line.

| Metric | Value |
| --- | --- |
| predicted / oracle edges | 8 / 8 |
| precision | **1.000** |
| recall | **1.000** |
| unsupported relationship claims | **0** |
| coverage | 10/10, complete |

## 2. The defect v1.0.0 shipped

v1.0.0 parsed line-leading declarations. A multiline import:

```js
import {
  readFile,
  writeFile,
} from 'node:fs/promises';
```

produced **no edge at all**, and the scope reported `no_edges` — an extraction failure presented as an
absence of relationships, which is precisely the confusion D6 exists to prevent. The failure mode was
**not** in v1.0.0's declared limits: it was found by measurement, not anticipated.

v1.1.0 joins declaration units across lines and blanks every consumed continuation line before counting
references. The fixture now asserts extraction and both bindings.

A second defect surfaced with the same root cause: reference counting blanked **every** line beginning
with `export`, so `export const full = pathJoin('a', 'b')` vanished from the reference text. Two of the
six shapes failed on that alone. Both are recorded here because an extractor that silently under-reports
is indistinguishable from an empty repository.

## 3. The six shapes

| Shape | Result |
| --- | --- |
| **aliased import** | module edge to `node:path`; reference identity carries `join`, the alias `pathJoin` is not treated as a symbol |
| **shadowed identifier** | import edge present, **no** reference edge; a `gap` records `shadowed_binding (parameter)`; reference coverage `complete=false`; with no other edges the scope answers `edges_unknown` |
| **multiline import** | extracted (v1.0.0 would have said `no_edges`); both bindings produce reference edges |
| **re-export chain** | A→B and B→C reported; **A→C not claimed** — transitive reach is not direct evidence |
| **cyclic dependency** | both directed edges, distinct identities, no duplication, no traversal |
| **unresolved specifier** | retained with `resolution: unresolved`, `specifier_not_found`; not promoted |
| **mixed file types** | `.js` + `.ts` in one scope → `edges_unknown` / `coverage_incomplete`; with some edges present → `ok` with `complete=false` and the excluded file named |

Shadowing is the shape worth dwelling on: the contract cannot resolve bindings, so it **abstains**. It
does not emit a reference it cannot establish, and it does not fall silent — the gap is reported and
makes coverage incomplete.

## 4. What changed in the contract (v1.1.0)

1. Declaration units may span lines; continuation lines are consumed, not scanned.
2. Only parsed declaration lines are excluded from reference counting.
3. A local binding redeclared in the same file (const/let/var, function, parameter) yields a **gap**,
   never a reference edge.
4. `coverage.gaps` is part of the scope answer, so abstention is visible at the same level as
   `no_edges`.

Declared limits now include the shadowing rule and the chain rule.

## 5. Re-measurement of the v1 contract suite

`D6-EXTRACTION-01.md` reports 28/28 measured on **v1.0.0**. That suite was re-run unchanged against
v1.1.0 and still passes **28/28**; the numbers in 01 remain its own (v1.0.0) record, and this document
does not retroactively rewrite them.

## 6. Remaining weakness

- The held-out set is still small: 10 files, 8 edges, one repository. 1.000 here does not generalise.
- The six fixtures are authored by this investigation, so they test the contract's **logic**, not its
  behaviour on unfamiliar idioms.
- No CommonJS, TypeScript, JSX, alias/tsconfig resolution → `edges_unknown`, by declaration.
- Re-export chains are deliberately not flattened; a consumer wanting transitive reach must compose hops
  and own the inference.
- Symbol references remain lexical; shadowing is the one case now detected, not the only case that
  exists (property access, destructuring aliases, eval, dynamic scope are unmodelled).

## 7. Gate state

| Gate | Status |
| --- | --- |
| D6 extraction contract | **survives held-out contact**; defects found and revised, v1.1.0 |
| D1 storage-level AC-3 companion | open |
| D8 cross-store exchange | open |
| replay/projection volume + compaction | open |
| implementation | **closed** |

D6 remains outside the frozen baseline: `node tools/ara-freeze.js --verify` reports 12/12 intact, because
these are additions, not edits to frozen artifacts.

## 8. Verification

```
node tools/d6-heldout.js         → 33/33; held-out precision 1.000, recall 1.000, 0 unsupported claims
node tools/d6-eval.js            → 28/28 under v1.1.0 (v1.0.0 numbers preserved in D6-EXTRACTION-01)
node tools/ara-freeze.js --verify → 12/12 baseline artifacts
node tools/schema-acceptance-v2.js → 52/52
node tools/selftest.js           → 52/52
```
