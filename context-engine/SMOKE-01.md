# SMOKE-01 — the paid path, once, for pennies

**Status:** pre-registration, one authorised attempt. **This is not a benchmark and scores nothing.**
It exists because every paid claim in this repository was produced by a path that had never been
exercised from a clean tree: `BENCHMARK-01.md` is designed but has no runner, and the live scans in
this folder were taken before the spend guard existed.

## 1. What one run establishes

That the paid boundary works end to end, in this order and no other:

1. the key is read from the environment and never written into an artifact;
2. the spend guard opens **one** attempt for the run id, in a ledger that survives the process;
3. the provider reports a charge, and that charge — not a catalogue product, not an estimate — lands
   in the ledger next to the call that incurred it;
4. the pipeline writes its artifacts and its own checks pass on live output;
5. the observed price of a construction pass on `fixtures/poc-repo` is recorded, so the §8 line in
   `BENCHMARK-01.md` ("construction: 3–6 calls, ~$0.004") can be checked against a measurement
   instead of an assumption.

## 2. What one run does not establish

- No conditions, no comparison, no tasks, no task success, no cost per solved task. Those are
  `BENCHMARK-01.md` §2–§7 and none of them run here.
- The subject is the 11-file fixture, which `BENCHMARK-01.md` §3 explicitly rules out as a benchmark
  subject because it is smaller than the pack.
- One sample. Nothing about variance.

A green run here means the plumbing is wired, not that the engine is useful. The distinction is the
entire point of the file.

## 3. Design — single arm

| | |
| --- | --- |
| Subject | `fixtures/poc-repo` (11 files, 3,238 bytes, 1 partition) |
| Model | `z-ai/glm-5.3-flash` — the pinned slug, not the moving `~z-ai/glm-flash-latest` alias, so a price change cannot be mistaken for a result |
| Stages | scan → QA from the medium pack → differential scan after `fixtures/poc-delta` |
| Output cap | 8,000 tokens per call, as fixed after LIVE-SCAN-01 attempt 1 |
| Temperature | 0 |
| Retries | none; a failed call is a failed call |

Pass requires all of: the runner exits 0, every check it prints passes, total spend is within the
floor, the ledger holds exactly one `attempt_opened` row and one `attempt_closed` row for the run id,
and every `call` row carries a provider-reported `cost_usd` with `cost_source: provider` in the
instrumentation.

## 4. Spend and stopping

| Item | Calls | Estimate |
| --- | ---: | ---: |
| Scan (single partition) | 1 | ~$0.001 |
| QA from the medium pack | 1 | ~$0.001 |
| Differential rescan after the delta | 1–2 | ~$0.001 |
| **Total** | 6 | **≈ $0.03** |

The derivation is six calls at the catalogue rate: 6 × (8,000 in × $0.0399 + 8,000 out × $0.0784)/10⁶
= **$0.0057**. The enforced floor is `SMOKE-01.budget.json`'s **$0.03**, because the pre-flight gate
uses the pessimistic 3.5 chars/token and the alias ancestor in LIVE-SCAN-01 billed above the catalogue
product. `tools/bench-budget-check.js` fails if this table and that file stop agreeing.

Stop conditions, in order:

1. any non-2xx response → stop, record it verbatim, no retry under the same run id;
2. spend reaches the authorised floor → stop and report the partial run;
3. citation failure above 20% → stop; the pack is not fit to test even as a smoke run.

## 5. Authorisation

One attempt, run id `smoke-01-2026-11-23`, budget $0.03, ledger `runs/smoke-01/spend-ledger.jsonl`
(untracked). A second attempt needs a new run id and a fresh authorisation; the guard refuses a
reused one, and that refusal is the reason the run id is written here rather than chosen at the shell.

## 6. Result

See §7, written after the run. The pre-registered conditions above are not edited to fit it.

## 7. Run 1 — 2026-11-23

Attempt 1, run id `smoke-01-2026-11-23`, budget $0.03, model `z-ai/glm-5.3-flash`.

**Spend: $0.00138114 over 3 calls, every one provider-reported.**

| Call | In | Out | Charge | Generation |
| --- | ---: | ---: | ---: | --- |
| scan | 2,466 | **8,000** | $0.0007255934 | `gen-1795403784-ttUVBGW0ycrJcf5Th7Fi` |
| QA from pack | 280 | 406 | $0.0000864640 | `gen-1795403842-k2rIpBt8IGO3yQbz3tgF` |
| delta rescan | 1,420 | 6,536 | $0.0005690804 | `gen-1795403855-riTUfW6jXXcAib4E9wuH` |

The ledger holds one `attempt_opened`, three `call` rows and one `attempt_closed` with
`spent_usd: 0.0013811378`. §1's five plumbing claims held: the key stayed out of every artifact, the
guard opened one attempt, charges were provider-reported, artifacts were written, and the run exited 0.

**The scan itself failed, and the harness did not notice.** The scan call consumed exactly 8,000 output
tokens — the cap — and produced **0 findings, 0 conclusions, 0 contradictions**, a 9-token pack with
0 items, and QA at **0/6** on every metric. The planted facts scored 0/8 and 0/2. This is LIVE-SCAN-01
attempt 1 recurring: JSON cut at the cap parses to nothing, and the pipeline reported that as the
material saying nothing. The provider had recorded `output_truncated`; `poc/run-poc.js` never read call
problems, so the run printed **25/25 checks, exit 0** over an empty snapshot.

Fixed after the result was recorded, not before: `run-poc.js` now fails when any scan or delta call
reports `output_truncated`, `payload_unparseable` or `call_failed`. Run 1's artifacts are not re-scored
— under the added check it is a **failed run**, and that is what it stays.

### 7.1 Amendment for the next attempt (not retroactive)

§3's pass condition — "every check it prints passes" — was satisfiable while the pipeline produced
nothing. From attempt 2 onward the pass condition additionally requires a non-empty snapshot: at least
one citation-verified finding, and at least one pack item. Also, the 8,000-token cap is too small for
this prompt on this model: attempt 2 runs at 12,000, which is the only pre-registered change.

What run 1 does establish, and what §8's derivation can now cite: a construction pass on this fixture
costs **$0.0014** at three calls, below the ~$0.004 line and far below the $0.03 floor. Stopping here
was correct; the remaining question is whether attempt 2 is worth ~$0.002 to get a non-empty scan.

## 8. Run 2 — attempt 2, 2026-11-23

Run id `smoke-01-2026-11-23-a2`. The only change from run 1 is §7.1's 12,000-token cap.

**Spend: $0.00144816 over 3 calls, all provider-reported.**

| Call | In | Out | Charge | Generation |
| --- | ---: | ---: | ---: | --- |
| scan | 2,466 | 9,529 | $0.0008454670 | `gen-1795404105-QZbwXAcwPZPN91BCRBkM` |
| QA from pack | 1,314 | 1,075 | $0.0001367086 | `gen-1795404176-tO9QJDmzf55wAZVP2Wat` |
| delta rescan | 1,420 | 5,221 | $0.0004659844 | `gen-1795404188-9nulwXbCbZ4FXAyHhfdk` |

**The amended pass condition holds.** 23 findings, **22 citation-verified, 1 failed (4.3%, inside the
20% stop condition)**; 16 verified conclusions, 7 inferences, 1 contradiction, 5 questions; medium
pack 32 of 36 items at ~3,246 tokens; **27/27 checks, exit 0**. Run 1's 8,000-token truncation was the
cap, not the model: at 9,529 output tokens the same model produced a full scan.

Delta behaved as designed: 1 source added, 3 changed, 1 removed; 16 findings preserved byte-identical,
6 stale, 1 invalidated, 4 files rescanned.

### 8.1 What run 2 still does not show

Recorded so it cannot be read as a result:

- **Model-only facts 0/2** — the same two facts LIVE-SCAN-01 missed (the configured timeout and its
  contradiction). The contradiction *is* present; the standalone `state` finding is not.
- **QA 1/1/1 with 1 factual error** — the known compaction defect: packs drop contradictions, so a
  question about the timeout/configuration conflict cannot be answered from the pack.
- Nothing about conditions, tasks or cost per solved task. §2 stands unchanged.

### 8.2 Cumulative spend

$0.00138114 (run 1) + $0.00144816 (run 2) = **$0.00282930 of the $0.03 floor**, across two attempts and
six calls. Both attempts are in the ledger under distinct run ids; neither was a retry of the other.

### 8.3 The truncation gate is proved, not assumed

The check added after run 1 only matters if it fails on the condition it names. `tools/poc-truncation-check.js`
drives the runner twice with a scripted provider — no key, no budget, no network — and is in `npm run verify`
as `poc truncation gate`:

- a call reporting `output_truncated` → the runner exits 1, the gate is the failing check, and the
  failure names `output_truncated`;
- a healthy payload → the same gate is green, so it is not red unconditionally.

4/4 checks pass. Before this, the only evidence the gate worked was an argument about the code.
