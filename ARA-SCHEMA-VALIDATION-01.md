# ARA-SCHEMA-VALIDATION-01 — do the acceptance criteria actually hold?

**Date:** 2026-11-18 · **Cost:** $0, no model calls, deterministic.
**Subject:** `ARA-SCHEMA-01.md`, **unchanged** — SHA-256 `968a8142c2f86dd0fb330fc8b6ec2314666d3ef253fb0ae7df5fbf255e908d27`
at the time of validation. The schema is not amended by this record; findings that would amend it are
listed in §7 and require a separate decision.
**Instrument:** `tools/schema-acceptance.js` — an in-memory **reference model of the contract**, not of ARA.

**Result: 39/39 assertions pass, all seven criteria hold in the reference model.** That establishes the
contract is internally consistent and satisfiable. It does not establish that any store implements it,
and it does not close D1/D3/D6.

---

## 1. Method

A small `ReferenceStore` implements the six records, the five event ops, the four question queries and
the sufficiency split, with the schema's preconditions enforced as refusals. Every mutation goes through
`emit()`; the projection is derived from the log. Seven criteria are tested against it, including two
that reuse **real corpus files** (`tools/score-transcript.js`, `src/spans.js`) rather than synthetic text.

The reference model is deliberately not a candidate implementation: one process, one map per record,
no storage, no migrations, no concurrency.

## 2. Results

| AC | What it asserts | Checks | Result |
| --- | --- | ---: | --- |
| **AC-1** | replay from the event log reproduces the projection byte for byte; no event deletes; retract keeps the record; supersede keeps both; resolve records its basis | 5 | **pass** |
| **AC-2** | a claim without an anchor, a relationship without an extractor, and an anchor without an occurrence ordinal are all refused; a refused write emits no event; two extractors agreeing produce **one** edge with **two** proofs | 6 | **pass** |
| **AC-3** | the four answer sets share no field; truth is not in the information set; completeness is not in the reliability set; provenance carries no claim text; a second model's assessment does not overwrite the first; a reused claim keeps one identity; disagreements persist unresolved | 7 | **pass** |
| **AC-4** | instrument/domain mismatch is reported as mismatch and produces no number; absent instrument is `absent`; sufficiency names `instrument`; zero coverage names `coverage` not `support`; no zero is substituted | 6 | **pass** |
| **AC-5** | three occurrences of one line get three distinct anchor ids, resolve to their own offsets, and content-only ids would collapse to one; a real corpus line repeating 3× gets 3 ids | 6 | **pass** |
| **AC-6** | occurrence-aware anchors outnumber distinct quotes; **94/96** distinct quotes survive the `locate` → `locateSpan` rename while **99/101** occurrences survive; exactly 2 break and both mention the symbol | 5 | **pass** |
| **AC-7** | no declared extractor yields `edges_unknown`; a declared extractor that found nothing yields `no_edges`; the statuses differ; `edges_unknown` reports no count | 4 | **pass** |

## 3. The three properties you asked to protect

| Property | Assertion | Status |
| --- | --- | --- |
| **Relationship identity vs proof identity** | two extractors asserting the same edge produce `relationships.size === 1` and `provenance.length === 2` | **verified** |
| **Assessment independence** | a claim reused by a second model keeps one `claim_id`, gains a second `assessment_id`, and both probabilities (0.98, 0.71) coexist with no resolution | **verified** |
| **Unknown vs absent** | `edges_unknown ≠ no_edges`; `instrument: absent` produces `measured: null` and sufficiency `side: instrument`; nothing renders as `0` | **verified** |

The first two are exactly what a "one row per decision" design would have destroyed: merging proofs
makes extractor disagreement invisible, and one confidence column makes a second opinion an overwrite.

## 4. Two defects in the tests themselves, recorded

Both looked like schema failures and were not:

1. **AC-5 locator construction.** The probe stepped `index * 5` through the text, so all three locators
   pointed at the first occurrence — and the disambiguator then correctly resolved all three to it,
   reporting `[13, 13, 13]`. The model was right; the probe was wrong. Fixed by enumerating real offsets,
   and the probe now asserts it found three occurrences before testing resolution.
2. **AC-6 unit confusion.** The test compared occurrence-aware anchors (101) against the content-id
   figure published in `CODE-STRESS-01` (96 distinct quotes). Both numbers are correct and measure
   different things, because five quotes repeat. The test now asserts both units: **94/96** distinct
   quotes and **99/101** occurrences. This is worth keeping in the results vocabulary — a survival rate
   quoted without its unit is ambiguous.

## 5. What this establishes

- The contract is **satisfiable**: all seven criteria hold simultaneously in one reference model, with
  preconditions enforced rather than documented.
- **Append-only works**: replay of a mixed log (append, supersede, conflict, resolve, retract) reproduces
  the projection exactly, and no operation removed a record.
- **Provenance is enforceable**, not advisory: unanchored claims and unprovenanced edges are refused
  before any event is written.
- **The four questions are separable** as declared, including the two collapses the project has already
  been burned by (truth vs completeness, claim vs verdict).
- **Occurrence identity behaves on real code**: the A1 requirement is met, and its cost is visible —
  101 anchors where content-only identity would have produced 96.
- The **measured numbers reproduce inside the schema**: 94/96 quotes surviving the rename, 2/2 breaks on
  the symbol lines — the same figures `CODE-STRESS-01` reported, now through the schema's own keys.

## 6. What this does not establish

| Not established | Why it matters |
| --- | --- |
| Physical separation of the four answer sets | AC-3 audits **declared field sets**, not columns; a table may still store truth and completeness together |
| Replay at volume | AC-1 ran on a 12-event log; ordering, compaction and snapshotting are untested |
| Occurrence stability under insertion | D3 remains open: inserting an identical line above shifts the ordinal. `needs_reattribution` is defined but **not tested** |
| Multi-store behaviour | D8: how ARA learns of AA's claims without inheriting verdicts is unexercised — the single reference store cannot show it |
| Any real extractor | D6: `code.imports` is a declared name only, so only the `edges_unknown` and `no_edges` paths were exercised, never a populated graph |
| Concurrency | single-threaded reference model; no two writers, no interleaving |
| Retention policy | D7 untested: assessments accumulate without a window |

## 7. Findings that would amend the schema (not amended here)

1. **`needs_reattribution` needs a test before it is trusted.** It is the one state in §3.2 that exists to
   absorb the A1 residual risk and has no probe. D3's options should be decided by building that probe,
   not by argument.
2. **`edges_unknown` should probably be scope-level, not per-claim.** AC-7 tests it per claim because the
   reference model has no scope object; in production the absence of an extractor is a property of the
   scope, and repeating it per claim would be noise.
3. **AC-3 needs a storage-level companion** before migration: a check that no physical column is read by
   two of the four queries. It cannot be satisfied by declaring field sets.

None of these blocks validation; each blocks *implementation* of the affected part.

## 8. Gate status

| Gate | Status |
| --- | --- |
| Schema contract validated in a reference model | **yes** — 39/39 |
| `ARA-SCHEMA-01.md` amended | no, deliberately unchanged (digest above) |
| Implementation authorised | **no** — D1, D3, D6 open; §7 items unresolved |
| Migration prepared | **no** — nothing written outside the workspace |

## 9. Verification

```
node tools/schema-acceptance.js     → 39/39 checks passed, exit 0
sha256sum ARA-SCHEMA-01.md          → 968a8142… (unchanged during validation)
node tools/freeze-verify.js         → 27/27 artifacts match, freeze intact
```
