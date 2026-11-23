# POC-RESULT — proof-of-concept acceptance record

**Date:** 2026-11-20 · **Subject:** `fixtures/poc-repo` (11 files, 3,238 bytes) · **Model:**
`~z-ai/glm-flash-latest` → resolved `z-ai/glm-5.3-flash` (Wafer) on every live call.
**Thresholds:** pre-registered in [EVALUATION.md](EVALUATION.md) §6, never changed after a result.

This document states what the proof of concept has **measured**, what it has only **demonstrated
mechanically**, and what it has not shown at all. It adds no new evidence: every number below is read
from a stored artifact and can be traced to
[LIVE-SCAN-01.md](LIVE-SCAN-01.md) and `examples/live*/`.

---

## 1. Verdict, in one paragraph

Under the pre-registered rule, "supported on this fixture" requires **H1–H7 all to pass in one run**.
No single run did: run 1 passed 7/8 with H2 failing (model-only facts 0/2), run 2 passed 7/8 with H4
failing (attribution 0.667). A third measurement — a QA re-check on a rebuilt pack, **not** a new scan —
reached H4's bar (0.833) after the compaction defect that caused the run-2 miss was fixed. **All eight
gates have now been observed passing at least once, but not together in one run**, and the failing gate
moved between the two live runs. The verdict therefore remains **not supported as a single-run result**;
what is supported is the narrower claim that each individual gate condition is reachable with this
pipeline on this fixture, with the H4 failure attributable to a harness defect in compaction rather than
to the model or the pack budget.

The instability is itself a result: with n=1 per run, "which gate fails" is not reproducible, so a
7/8 score is not evidence that the system is one fix away from 8/8.

---

## 2. Gate matrix across all measurements

| # | Threshold | Run 1 | Run 2 | Re-check (no scan) |
| --- | --- | --- | --- | --- |
| **H1** | 0 unresolved quotes; failure ≤ 10% | pass (20/20, 0%) | pass (21/21, 0%) | not measured |
| **H2** | line-rule 8/8; model-only ≥ 1/2 | **FAIL** (8/8; 0/2 in observations) | pass (8/8; 2/2) | not measured |
| **H3** | planted contradiction ≥ 1 | pass (1, verified) | pass (1, verified) | n/a — pack carries the stored contradiction |
| **H4** | attribution ≥ 5/6; reconstruction ≥ 5/6 | pass (0.833 / 0.833) | **FAIL** (0.667 / 0.667) | **pass** (0.833 / 0.833) |
| **H5** | trap statements = 0 | pass (0) | pass (0) | pass (0) |
| **H6** | absent facts listed in `omissions` or absent from snapshot | pass (weak clause) | pass | pass (0 omissions, 30/30 items) |
| **H7** | `preserved_identical`; unchanged rescanned 0; stale ≥ 1; invalidated ≥ 1 | pass (true; 0; 4; 1) | pass (true; 0; 6; 1) | not measured |
| **H8** | provider-reported tokens and charge, within budget, numbers reported | pass | pass | pass ($0.000180414 of $0.01) |

`not measured` is not a pass. H1 and H2 are scan metrics and no scan occurred in the re-check; H7 is a
differential metric and no delta occurred. The re-check was authorised for one QA call only.

### Why H4 failed in run 2 and passes now

Run 2's q6 answer was `not_in_pack`. Cause: `compact.js` did not carry `snapshot.contradictions` at all,
so the pack used for QA could not contain the timeout conflict **even though the snapshot had verified
it** (H3 passed in both runs). That is a compaction defect, not a retrieval or model failure.

The fix emits a `contradictions` section (`caveat: "unresolved"`, both sides cited) at priority 5. The
pack was rebuilt from the **stored** snapshot in `examples/live-approved/` — no acquisition, no scan, $0
for the rebuild — and QA re-run once:

```
pack 2,989 / 4,000 tokens · 30/30 items · 0 omissions · 1 contradiction · reconstructible
QA (model) retention 1.000 · attribution 0.833 · reconstruction 0.833 · traps 0
q6 answered and attributed to both sides (config/defaults.json + docs/ARCHITECTURE.md)
tokens 1,207 / 705 · $0.000180414 · gen-1795150276-oYP8upUiFBPuWqd4u3NR · one call
```

**q3 is still the only miss:** the answer is correct (the backfill work is outstanding), but it cites
`README.md` and `docs/ARCHITECTURE.md` while the ground truth names `src/ingest.js`. Neither the answer
nor the ground truth was edited. See §5 P2.

---

## 3. What was delivered

| Deliverable | State | Evidence |
| --- | --- | --- |
| Read-only acquisition with hashed sources and recorded skips | done | `src/source.js`, `poc-report.json` |
| Budget derivation, operator ceiling, clamp reported | done | `tests/budget.test.js` 16/16; `partition_budget_notes` |
| Seven-section snapshot with content digest | done | `SCHEMA.md` §5; both snapshots |
| Quote verification against the bytes, quarantining failures | done | run 1 20/20, run 2 21/21 verified, 0 failed |
| Contradiction detection, retained unmerged | done | H3 both runs |
| Budgeted packs with full omission accounting | done | `SCHEMA.md` §7; 0/25 omissions consistent with coverage |
| Compaction carrying contradictions, both sides cited | done (new) | `tests/compaction.test.js` 11/11; `pack-medium-contradictions.*` |
| Differential update rescanning only changed files | done | H7 both runs; `delta-poc-repo.json` |
| QA from the pack alone, two modes | done | `qa-recheck.json`; retrieval mode run at $0 |
| Per-call instrumentation: resolved model, generation id, cost source | done | `instrumentation.jsonl`; H8 |
| Pre-registered gates, unchanged after results | done | `EVALUATION.md` §6 |
| Run ids, attempts and charges fixed in an append-only ledger | done (new) | `src/guard.js`, `tests/guard.test.js` 21/21 |
| Identical inputs produce identical snapshot and delta ids | done (new) | `tests/determinism.test.js` 15/15 |
| Support beyond quote existence, measured | measured (new) | `examples/live-approved/support-check-poc-repo.json` |
| Token estimate calibrated against provider usage | measured (new) | `examples/live-approved/token-calibration.json` |
| Downstream utility benchmark | designed and pre-registered, **not run** | [BENCHMARK-01.md](BENCHMARK-01.md) |
| Multi-partition live path | **not exercised** | see §4 |
| Generalisation beyond one small fixture | **not shown** | see §4 |

Offline verification, re-run for this record ($0):

```
node context-engine/tests/budget.test.js       16/16
node context-engine/tests/compaction.test.js   11/11
node context-engine/poc/run-poc.js             25/25
```

---

## 4. Not established by this PoC

These are deliverables the evidence does not cover. They are listed rather than quietly dropped.

1. **Multi-partition behaviour.** The subject used 3,238 of a 400,000-token budget; every live scan took
   the `single_pass` path. Splitting an oversized file and joining cross-partition references are tested
   only through code paths, never against a model. Closing this needs a subject large enough to partition.
2. **Generalisation.** One fixture authored alongside its ground truth, one model, one run per condition.
   The two runs also disagree about which gate fails, so per-gate pass rates are not estimable from them.
3. **Comprehension.** Retention and reconstruction are phrase-and-citation checks. They show the pack
   carried the evidence; they do not show that reasoning over it was correct.
4. **Long-horizon use.** One compaction boundary. Nothing here measures repeated compaction where the
   working set is itself already derived.
5. **H6 is a weak clause.** "Absent from the snapshot" passes without checking that the subject really
   lacks the fact; the clause should tighten to per-fact inspection before it is trusted.
6. **Retrieval-mode scoring has a known false positive.** On the contradiction pack it scores 0.667 with
   one trap match, because a keyword answer cannot distinguish a disputed value from a current one. The
   model does distinguish them. The deterministic scorer is the limitation.
7. **Economy at this scale is negative.** The medium pack is ~3,242 estimated tokens against ~810 tokens
   of source. Per-item JSON costs more than the prose it replaces on an 11-file fixture; whether
   compaction pays at realistic scale is unmeasured.

---

## 5. Pre-registration for the next measurement (not applied retroactively)

Both items below change **only future scoring**. Run 1, run 2 and the re-check keep the numbers in §2,
and no stored result is rescored. They are recorded here because §2 identified them, which is also why
they are weak: a rule chosen after seeing a miss is not independent of that miss.

**P1 — H2 counts evidence-bearing sections, not observations alone.** The run-1 timeout fact existed and
was verified inside a `contradiction`. Scoring only `sections.observations` reported 0/2 for a fact the
snapshot held. For future runs, H2 will score model-only facts across `observations` **and**
`contradictions`, with the per-fact location reported.

**P2 — Attribution accepts any source that states the fact.** For q3, the outstanding backfill work is
stated in `README.md`, `docs/ARCHITECTURE.md` and `src/ingest.js`; the ground truth names only the code
file. For future runs the question's accepted sources will be that set of three, listed per question in
the ground truth before the run. Run 2's 0.667 and the re-check's 0.833 both keep the single-source
expectation and stand as measured.

Neither item changes the verdict rule in `EVALUATION.md` §6: H1–H7 must still all pass in one run.

---

## 6. Spend ledger

| Measurement | Calls | Provider-reported charge |
| --- | ---: | ---: |
| Run 1 (attempt 1 truncated + attempt 2) | 6 | $0.002415848 |
| Run 2 (single attempt) | 3 | $0.001364930 |
| QA re-check (one call, pack rebuilt at $0) | 1 | $0.000180414 |
| **Total** | **10** | **$0.003961192** |

All ten calls carry `cost_source: provider`. Reported charges run about 1.7–2× the catalogue product of
the same tokens; both figures are recorded per call and never averaged. The ≈$0.0272 spent earlier
belongs to the separate GCA/RDA decision pilot and is excluded here.

No paid call has been made since the re-check, and none will be without a fresh, explicit authorisation.
Run 1's attempt 2 was started without authorisation; that is recorded as a process failure in
[LIVE-SCAN-01.md](LIVE-SCAN-01.md) §6, not as an accepted practice.

---

## 7. Artifacts

```
examples/live/                              run 1: snapshot, packs, QA, rescore, delta, report, log
examples/live-approved/                     run 2: same set, single attempt
examples/live-approved/pack-medium-contradictions.json / .md   rebuilt pack carrying the contradiction
examples/live-approved/qa-recheck.json      re-check: pack digest, one call, per-question scoring
examples/live-approved/instrumentation.jsonl run 2 per-call rows
examples/live-approved/token-calibration.json  rebuilt prompts vs provider-reported tokens
examples/live-approved/support-check-poc-repo.json  support checks over the stored snapshot
```

## 8. Integrity additions after this record (2026-11-20)

Four things were added after the measurements above, all $0 and none of which changes a number in §2:

1. **Spend guard.** A paid provider cannot be constructed without one, and one run id admits one attempt.
   The ledger (`spend-ledger.jsonl`, written by the guard) makes a retry a refusal that a fresh process
   cannot bypass, instead of a paragraph a harness can ignore. This is the execution-layer answer to the
   unauthorised attempt recorded in §6.
2. **Determinism.** The digest had been covering `subject.acquired_at` and `scan.latency_ms`, so two
   identical scans produced different ids. Content-only digests are now tested by scripted replay. Existing
   artifacts keep the ids they were published with; future snapshots get stable ones.
3. **Token calibration.** The estimator was optimistic by 13.2% on the scan prompt and 4.5% on the QA
   prompt. The spend pre-flight now uses 3.5 chars/token; artifact estimates deliberately stay at 4 so that
   the pack sizes quoted here are not restated. `BENCHMARK-01.md` requires reporting both figures.
4. **Support checks.** 18 of 21 observation findings, 13 of 15 verified conclusions and the single
   contradiction pass a stronger mechanical test than "the quote exists". Two of the flagged findings are
   true but under-cited: the figure they state sits in a different line than the one quoted. The check is a
   metric, not a gate, and does not demote them.

The verdict in §1 is unchanged by all four. What changed is whether a future measurement can be trusted:
its spend is enforced, its ids are reproducible, its budget is calibrated, and its evidence has a second
check that does not depend on the model that produced it.
