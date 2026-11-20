# RUN-PLAN-01 — first controlled model comparison

Status: **planned, not executed.** No model has been called, nothing has been charged.
Harness grading frozen at `0.1.2` (reports say `0.1.3`, which adds only the evidence
archive; see PROTOCOL §14). Thresholds: `thresholds.json` `2026-11-18.1`.

This document is the procedure for the first run. It is deliberately not a
subsystem: it is a list of steps, a sampling rule, and a place to record what a
human decides. Nothing here writes to a store, serves a route, or talks to AA,
ARA or Mind.

---

## 1. The one question this run answers

> Can a model extract and classify information from supplied material well enough
> to be an **evidence provider** — accurate where it asserts, honest where it
> abstains, and stable across identical input?

What it does **not** answer:

- whether the model can decide anything (the harness has no decision field);
- whether the model is suitable for a live path (cost and latency are measured,
  placement is not decided here);
- whether inference validity holds in general. That is what §6 samples, for the
  sampled items only;
- anything about images. F4 is excluded, see §7.

Three hypotheses are tracked separately, as in PROTOCOL §1: G1 global assessment,
G2 contextual reasoning, G3 recursive differential. G2 is **not** established by
the mechanical metrics; it is established by §6 or not at all.

### Status of the RDA evidence window

The 48-character neighbourhood is an **experimental mechanism, not a validated
definition of evidence change**. A semantic change can fall outside the window and
a non-semantic change can fall inside it; the self-test pins both behaviours
rather than claiming either is correct. Consequences for this run:

- no conclusion may rest on `justified_fraction` alone; read it beside
  `changed_sources` (coarse), `silent_drift` and the raw deltas in `report.json`;
- a disagreement between the coarse and fine views (`hash_only_change`) is a
  finding about the mechanism, not a verdict on the model;
- if the run's RDA rows are ambiguous, that is a result: the window needs a
  document-diff or a semantic comparator before it can be trusted, and that is a
  separate decision after this run, not a tweak before it.

## 2. Frozen inputs

| Item | Value |
|---|---|
| harness | `0.1.3` payload, grading frozen at `0.1.2` |
| thresholds | `thresholds.json`, digest recorded into the report; do not edit |
| fixtures | F1, F2a, F2b, F2c, F2d, F3, F5, F6, F6b, F6c, F6d, F6e, F6f, F7, F8, F9 (16) |
| excluded | F4 `pending_capture` — skipped by the runner, reported in `run.skipped` |
| repetitions | 3 per fixture per model |

Any change to fixtures or thresholds after this run starts makes its numbers
non-comparable with later ones. Fixture defects found during adjudication may be
corrected and must be recorded with the run.

## 3. Models, and the price check that must happen first

`models.json` prices are **unverified**. Before spending anything:

1. Open the provider's current price page for each slug and record input/output
   price per 1M tokens, with the date checked.
2. Confirm each slug is still served. Retired slugs must be substituted and the
   substitution recorded; a substituted model changes what the run says.
3. If a recorded price differs from `models.json` by more than 20 %, pass
   `--price-in` / `--price-out` for that run. Do not edit `models.json` mid-run.

| slug | class | price_in | price_out | why it is here |
|---|---|---|---|---|
| `openai/gpt-4o-mini` | small baseline | 0.15 | 0.60 | floor: what a cheap model does |
| `google/gemini-2.0-flash-001` | large context | 0.10 | 0.40 | long-context at low cost |
| `anthropic/claude-3.5-sonnet` | large context | 3.00 | 15.00 | comparison at ~30× the price |

If a slug cannot be verified, drop it and say so in the run report rather than
running it with a guessed price.

## 4. Size, budget, and the estimate the gate actually uses

`3 models × 16 fixtures × 3 repeats = 144 calls`. Input per repeat is about
70 k tokens (F2a–F2d are ~62 k characters each); request `--max-tokens 1200`,
which is ample for the snapshot shape and keeps the gate honest.

The gate estimates `(input_tokens × price_in + max_tokens × price_out) / 1e6` per
call — it charges `max_tokens`, not expected output — so the cap must be sized
against the **gate estimate**, not the expected spend.

| slug | gate estimate / repeat | gate estimate / run (3 reps) | expected spend | recommended `--budget-usd` |
|---|---|---|---|---|
| `openai/gpt-4o-mini` | $0.022 | $0.066 | ≈ $0.03 | **0.15** |
| `google/gemini-2.0-flash-001` | $0.015 | $0.044 | ≈ $0.02 | **0.10** |
| `anthropic/claude-3.5-sonnet` | $0.498 | $1.494 | ≈ $1.06 | **2.00** |

Expected total ≈ **$1.20**; worst case if every call ran to its cap ≈ **$2.25**.

Run each model as its own invocation. The budget counter is per invocation, so a
shared invocation would let an expensive model consume a cheap model's allowance.

A call that would cross the cap is recorded as an invalid snapshot, which lowers
`citation_integrity`. **Never report metrics from a run that hit its cap** — stop,
raise the cap deliberately, and rerun.

## 5. Execution order

```sh
# 0. credentials, never in the repo
export OPENROUTER_API_KEY=...        # the operator's key, not committed

# 1. fixtures and self-test, so the baseline is the frozen one
node tools/build-fixtures.js
npm run selftest                     # expect: 52 checks, exit 0

# 2. smoke test: two cheap fixtures, one repeat, one model
node run.js --provider openrouter \
  --models google/gemini-2.0-flash-001 \
  --fixtures F1,F5 --repeats 1 --max-tokens 1200 \
  --budget-usd 0.02 --out runs/smoke-01

# 3. stop and inspect runs/smoke-01/report.json before spending more:
#    - totals.invalid == 0        (no truncation, no parse failure)
#    - run.skipped contains F4
#    - snapshots[] present with quotes
#    - citation_integrity == 1    on two fixtures that must be easy

# 4. full runs, one per model
node run.js --provider openrouter --models google/gemini-2.0-flash-001 \
  --all --repeats 3 --max-tokens 1200 --budget-usd 0.10 \
  --out runs/01-flash

node run.js --provider openrouter --models openai/gpt-4o-mini \
  --all --repeats 3 --max-tokens 1200 --budget-usd 0.15 \
  --out runs/01-mini

node run.js --provider openrouter --models anthropic/claude-3.5-sonnet \
  --all --repeats 3 --max-tokens 1200 --budget-usd 2.00 \
  --out runs/01-sonnet
```

Do not pass `--strict` for the first run: a non-zero exit hides the report you
need. Read `report.md` and `report.json` instead.

## 6. Adjudication procedure (the G2 reference)

Purpose: an independent human reference for **relevance** and **inference**, for a
sample, without building a review system.

**Inputs.** `runs/<id>/report.json` → `snapshots[]` (claim, kind, refs with quotes
and spans) joined to `models[].grade.per_fixture[]` (harness flags: trap citations,
lexical overreach). Join key: `(model, fixture, oid)`.

**Sampling rule** — deterministic, no RNG, recorded verbatim in the report:

- **A. All flagged observations.** Every item in `evidence.adjudication` (trap
  citations, overreach flags, image regions). These are the disagreements the
  harness already suspects.
- **B. Systematic sample of unflagged observations.** Sort all remaining
  observations by `(fixture, model, repeat, oid)` and take every *k*-th, with *k*
  chosen so stratum B contributes 40 items.
- **C. All observations for F3 and F8, repeat 0 only,** for every model. These are
  the contradiction and trap fixtures; add other repeats only where consistency
  is below 1.

**Blinding.** The adjudicator receives `claim`, `kind`, the cited `quote`, and the
surrounding source text — not the model name, not the harness's flags, not the
model's confidence values. Model identity is replaced by a code; the operator
holds the mapping and reveals nothing until labels are recorded.

**Labels.** One per observation: `supported`, `unsupported`, `indeterminate`.
`indeterminate` is a legitimate answer and is counted, never discarded.

**Reason.** One line per item, at most ~200 characters, saying why. The reasons are
the raw material for diagnosing the model; a bare label is not enough.

**Record.** `runs/<id>/adjudication.md`, one row per item:

| item | code | fixture | oid | kind | claim (truncated) | cited quote (truncated) | human label | reason | harness signal |
|---|---|---|---|---|---|---|---|---|---|

`harness signal` is filled in **after** the label, by the operator, from the join:
`trap`, `overreach`, `none`, plus the model's `kind`.

**Comparison, reported without averaging:**

| human | harness | reading |
|---|---|---|
| unsupported | no flag | missed support failure — the important error |
| unsupported | trap | confirmed; the trap did its job |
| supported | trap | the trap is wrong — fix the fixture and say so |
| supported | overreach flag | false positive; the signal is too blunt |
| indeterminate | either | excluded from the error counts, reported separately |

Report: counts per model per cell of that table, the sampling rule, the item count,
and the number of adjudicators. **No percentage is combined with any mechanical
metric.** Disagreements stay visible as a list; they are the finding.

**Effort.** ≈ 60–80 items × 1–2 min ≈ 1.5–2.5 hours. One adjudicator is a
single-rater reference: state that it is unreplicated. A second adjudicator on the
same sample converts it into an agreement figure; if there is one, report the
agreement rate instead of claiming correctness.

**What this closes.** G2 for the sampled items, and only for them. State the
sampling rule beside every G2 conclusion, or the conclusion is not admissible.

## 7. F4 — multimodal, explicitly excluded

F4 is `pending_capture` and the runner skips it (`run.skipped` records the reason).
Consequences for this run, stated in the report and not softened:

- **No claim about visual assessment may be made from this run.**
- If a model emits an image citation, it cannot be verified as text: it is counted
  in `evidence.authenticity.image_unverifiable`, queued for adjudication, and
  `citation_integrity` cannot reach 100 % while it is present.
- Capturing F4 requires the redaction described in `fixtures/F4/capture.md`
  (tenant names, ids, hostnames, IPs replaced before capture) and a separate
  authorisation, because the image leaves the machine during a paid run.
- Adding F4 later changes the call count and the cost table above. It is a
  deliberate, recorded decision, not a fixture tweak.

## 8. Abort criteria

Stop and diagnose instead of continuing:

- smoke test: `totals.invalid > 0` → truncation, parse failure, or a bad slug.
  Raise `--max-tokens` or fix the prompt; do not proceed.
- smoke test: `citation_integrity < 1` on F1/F5 → something structural. Stop.
- any `budget_exceeded` error in `invalid_details` → the cap was too low. Stop and
  rerun that model; do not report partial metrics.
- provider 4xx with a slug or price error → reconcile §3 first.
- more than 5 % of snapshots rejected in a full run → stop and read
  `invalid_details` before spending more.

## 9. What a finished run leaves behind

Per invocation, on local disk only:

```
runs/<id>/report.md     human summary: three layers, queue, RDA, rejections
runs/<id>/report.json   grades, thresholds digest, snapshots[] evidence archive
runs/<id>/adjudication.md   filled in by hand, §6
```

Nothing is uploaded, deployed or stored beyond these files. The harness never
reads them back.

## 10. Pre-run checklist

- [ ] prices and slugs verified against the provider, with the date recorded
- [ ] `node tools/build-fixtures.js` exits 0
- [ ] `npm run selftest` exits 0 (52 checks)
- [ ] smoke test clean: 0 invalid, F4 skipped, `snapshots[]` populated
- [ ] budget per model set from §4, not from habit
- [ ] adjudication sample drawn by §6 before reading any model's metrics
- [ ] F4 exclusion repeated in the run write-up
- [ ] no threshold or fixture edits during the run
- [ ] RDA rows read alongside `changed_sources`, not as a single score (§1)
