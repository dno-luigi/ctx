# D1-STORAGE-01 — physical storage model

**Date:** 2026-11-18 · **Cost:** $0, offline.
**Subject:** do the logical distinctions in `ARA-SCHEMA-02.md` (A1′) survive physical persistence?
**Instruments:** `tools/ara-storage.js` (SQLite via `node:sqlite`, no new dependency), `tools/storage-acceptance.js` — **58/58**.
**Baseline:** `ARA-FREEZE-01` untouched (12/12); D1 is an addition, not an edit.

**Result: the distinctions survive, and the database enforced three of them more strictly than the
in-memory reference model did.** Two modelling errors surfaced only in contact with a real store.

---

## 1. Tables and where each invariant is enforced

| Distinction | Physical enforcement |
| --- | --- |
| anchor identity ≠ locator | `anchors` keyed by `(claim_id, anchor_id)`; trigger refuses UPDATE of `anchor_id`, `quote`, `claim_id`, `context_fingerprint`; locator columns remain mutable |
| anchors are never deleted | trigger refuses DELETE on `anchors` |
| assessment ≠ assessment | `assessments.assessment_id` PK — a second model cannot overwrite the first |
| relationship ≠ proof | `relationships.relationship_id` PK vs `relationship_provenance` PK `(relationship_id, extractor, extractor_version)` |
| unknown ≠ zero | `coverage` CHECK: measured columns must be `NULL` unless `instrument_fit = 'fit'` |
| unknown ≠ absent (edges) | `extractor_declarations` decides `edges_unknown` vs `no_edges` |
| history is append-only | triggers refuse UPDATE and DELETE on `events` |
| every claim has provenance | write API refuses; `invariants()` reports any orphan row |
| referential integrity | `PRAGMA foreign_keys = ON`, FKs on every reference |

Schema version marker: `ara-sqlite/v1`.

## 2. Storage-level acceptance

| AC | Check | Result |
| --- | --- | --- |
| AC-1 | replay reproduces the projection byte for byte, including coverage and declarations; events immutable | **pass** |
| AC-2 | unanchored claim, anchor without birth context, relationship without extractor all refused; no orphan relationships | **pass** |
| AC-3 | column sets of the four answer sets disjoint *as returned by SQL*; two models' assessments coexist; claim identity single | **pass** |
| AC-4 | mismatch stores NULL, not 0; database refuses numbers with a non-fit instrument; sufficiency names the instrument side | **pass** |
| AC-5 | distinct contexts persist as distinct anchors; identical contexts collapse to one row; two claims may cite one occurrence | **pass** |
| AC-6 | status changeable; identity, quote and birth context immutable; locator movable; invalid status rejected | **pass** |
| AC-7 | `edges_unknown` and `no_edges` are different stored answers; undeclared extractor is unknown | **pass** |

## 3. What only a physical store revealed

**3.1 An anchor row is a citation, not the occurrence.** The first schema made `anchor_id` the primary
key. Two extractors asserting the same anchor for the same claim then violated it — a legitimate,
idempotent re-assertion. The correct key is `(claim_id, anchor_id)`: the occurrence has one identity, but
each claim holds its own citation of it. Two claims citing one occurrence is normal; one claim holding
two rows for one identity is not.

**3.2 Coverage and extractor declarations were outside the log.** Replay lost them, because
`writeCoverage` and `declareExtractor` wrote rows directly. Anything written outside the event log is
state the log cannot rebuild — exactly what replay is for. Both are now events (`coverage`, `declare`),
and replay reproduces them.

**3.3 Identity hashes are not orderings.** Assessment ids are content hashes, so
`ORDER BY assessment_id` is neither chronological nor meaningful. Ordering must use `assessed_at`.
The acceptance check for assessment independence therefore asserts the set of probabilities, not their
row order — a test defect that looked like a storage defect.

## 4. What this model does not establish

- **Single process, single file.** No concurrency, no WAL behaviour, no multi-writer contention. SQLite
  here proves the constraints, not throughput.
- **No migration story.** `ara-sqlite/v1` is a marker, not a migration system; schema evolution beyond
  this revision is unaddressed.
- **No compaction.** Replay is deterministic over the full log; a compacted log has not been tested
  against it. That is the third gate, still open.
- **No performance claim.** No indices beyond primary keys, no volume measurement.
- **Trigger-based immutability is application-level hygiene**, not tamper-proofing: anyone with the file
  can drop the trigger. It prevents accidental corruption, not a hostile writer.

## 5. Gate state

| Gate | Status |
| --- | --- |
| D1 storage model preserves AC-1–AC-7 | **met at model level** (58/58) |
| D8 cross-store exchange | open — next |
| replay / compaction | replay **met**; compaction open |
| AA schema | not started |
| combined freeze (ARA-03, AA-01, shared contract) | not yet |
| implementation | **closed** |

## 6. Verification

```
node tools/storage-acceptance.js    → 58/58 checks
node tools/ara-storage.js           → smoke run: projection + invariants all zero
node tools/ara-freeze.js --verify   → 12/12 baseline artifacts
node tools/schema-acceptance-v2.js  → 52/52
node tools/d6-heldout.js            → 33/33
node tools/selftest.js              → 52/52
```
