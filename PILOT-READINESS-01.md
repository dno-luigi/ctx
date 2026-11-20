# PILOT-READINESS-01 — what is frozen, what is validated, what is still missing

**Date:** 2026-11-18 · **Cost:** $0 (no model calls; patch validation runs local suites only).
**Status:** preparation only. No pilot result exists, and none may be reported from this document.

## 1. CARD-GEN-01 frozen

`runs/frozen/card-gen-01/` — 13 artifacts plus `manifest.json` with SHA-256 per file and the oracle
digest `7c7913b1cf933cca…`. Code, artifacts, oracle and results are frozen; no retroactive
corrections. `required-items.json` remains immutable and is the oracle for any later card-generation
work.

## 2. H1 fixtures — four of five validated

Five controlled changes were authored as deterministic mutation specs in `pilot/patches/`, each with
its own gold set. `tools/patch-check.js --apply` applies each patch in memory, runs the declared
oracle, and restores the file, verifying restoration by hash.

| Patch | Class | Applicable | Oracle fails when patched | Status |
| --- | --- | --- | --- | --- |
| **C1** | shared interface (criteria key) | yes | **no — exit 0** | **withdrawn (S3)** |
| **C2** | dependency (`items` → `records`) | yes | yes — suite + tool both fail | validated |
| **C3** | configuration (`consistency_min` rename) | yes | yes — selftest fails | validated |
| **C4** | widely used function (`occurrencesOf` rename) | yes | yes — selftest fails | validated |
| **C5** | injected regression (off-by-one) | yes | yes — selftest fails | validated |

**What C1 taught us, and it is a real finding:** renaming the request field that both adapters emit
does not fail `selftest:decisions`. The frozen decision suite does not assert the shape of the built
request body, so it cannot detect a wire-contract change. That makes it a weaker oracle for interface
changes than the pilot assumed, and it means C1 cannot be used as specified. Replacing it needs either
a different interface change whose breakage the suite does observe, or an explicit request-shape
assertion as a separate test instrument. **H1 is one fixture short of its declared five.**

Restoration was verified for all five; the working tree is intact and all three suites pass.

## 3. H2 fixtures — complete

| File | Contents |
| --- | --- |
| `pilot/compaction/plants-H2.json` | 14 planted working-state items: 5 constraints, 3 decisions, 2 rejected alternatives, 4 facts. **12 of 14 have mechanical checks** in the final diff; 2 are adjudicated. |
| `pilot/compaction/checkpoints.json` | 3 checkpoints for the staged identity refactor, each with state at cut, open threads and remaining work, plus the boundary-event requirement. |
| `pilot/compaction/gold-edges.json` | 8 dependency edges, independent of H1's gold sets, with two declared non-edges and the must-not-break list. |

Independence is explicit: no fixture, symbol list or edge is shared with `GCA-RDA-CODING-PILOT.md`.

## 4. Mechanical scorer — validated against known cases

`tools/score-transcript.js` computes the six declared measurements from a transcript and a gold set.
Self-test on three hand-computed cases: **17/17 checks pass.**

| Case | What it pins down |
| --- | --- |
| perfect | full recall, zero repeated work, zero unsupported assumptions, oracle pass |
| missed_and_unsupported | recall 0.5, symbol recall 0.333, one missed edge, one unsupported claim |
| repeated_work | duplicate read + duplicate command counted as 2, recall unaffected |

`repeated_work` deliberately resets on an edit: re-running a suite after changing a file is not
repeated work, and a scorer that counted it would penalise thorough agents.

## 5. Pre-registration audit — every measurement and its denominator

| Declared measurement | Denominator | Harness support | Gap |
| --- | --- | --- | --- |
| Relevant information retrieved | gold impacted files | mechanical | — |
| Dependency recall | gold edges | mechanical | — |
| Missed dependencies | gold edges | mechanical | — |
| Change-impact accuracy | Jaccard vs gold | mechanical | — |
| Repeated work | events | mechanical | — |
| Tokens consumed | agent-reported | **none** | not verifiable in this harness |
| Time to correct | turns + wall clock | partial | needs transcript timestamps |
| Unsupported assumptions | claims | **needs blind adjudicator** | not mechanised |
| H2 retention of plants | 14 plants | mechanical for 12, adjudicated for 2 | 2 need a reviewer |
| H2 tokens to reconstruct | agent-reported | **none** | not verifiable here |

Two declared measurements have **no** mechanical denominator: agent token counts and blind
adjudication of unsupported claims. Both are core to the pass criteria (P2, P4, Q2, Q5). Until they
are instrumented, a pilot verdict would rest partly on unverified self-report.

## 6. The instrumentation dry run — what could and could not be done

The recommendation was a small dry run, one fixture per arm, before 160 runs. In this environment the
agent arms cannot be executed: there is no budgeted agent harness that produces the transcripts the
scorer consumes.

**Validated here (harness mechanics that do not need an agent):**

- patch applicability, oracle failure and clean restoration — done for all five;
- mechanical scoring on known positive and negative cases — 17/17;
- fixture independence (H1 vs H2) — structural, verified by inspection;
- freeze integrity with digests — done.

**Not validated, and not claimable:**

- that compaction actually occurs at the checkpoint;
- that the pre-boundary transcript is genuinely inaccessible afterwards;
- that recovery budgets are enforced equally across arms;
- that file-access restrictions hold in the treatment arm;
- that arm blinding survives the adjudication step.

These five are exactly the checks the dry run was meant to establish, and each requires a live agent
run. Claiming any of them from this document would be claiming a test that was not performed.

## 7. Remaining work before either pilot can run

1. **Replace C1** with an interface change the suite observes, or add a request-shape assertion —
   H1 needs five fixtures and currently has four.
2. **Instrument token accounting** for both arms, or drop P2/Q2 to secondary and state the change
   *before* seeing results.
3. **Name the blind adjudicator** for unsupported assumptions, or pre-register a mechanical proxy and
   accept its weakness.
4. **Run the five-step dry run** on one fixture per arm: compaction occurs, context inaccessible,
   budgets enforced, file access restricted, scoring correct.

## 8. What is established and what is not

**Established:** the bridge experiment's result is frozen; four H1 fixtures are validated with
mechanical oracles and clean application; H2's fixtures are complete and independent; the scorer
reproduces hand-computed numbers on three cases; the gates both pass on their declared thresholds.

**Not established:** that either pilot will produce a positive result; that any of the five dry-run
properties hold; that the metrics with no mechanical denominator can be trusted; that C2–C5 are
representative of real repository work rather than convenient mutations.

## 9. Verification

```
node tools/patch-check.js --apply        → 5 applicable, 4 oracles fail, all restored
node tools/score-transcript.js --selftest → 17/17
npm run selftest / selftest:decisions / selftest:inventory → 52/52, 40/40, 39/39
```

Artifacts: `runs/frozen/card-gen-01/manifest.json`, `pilot/patches/{C1..C5}.json`,
`pilot/patches/results.json`, `pilot/compaction/{plants-H2,checkpoints,gold-edges}.json`.
