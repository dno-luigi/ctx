# LIVE-RUN-01 — the first paid decision-model runs, and the inventory over real fixtures

**Date:** 2026-11-18 · **Authorisation:** the operator asked for the inventory over the real
fixtures and for live runs of `scaledown/classify-1` and the Perplexity deciders. This is the
first document in the repo that reports paid calls.

**What was spent:** 89 paid assessments ($0.02609492 measured, provider-reported) plus ~12 contract
probes (~$0.00006), **≈ $0.026** in total — 9 single calls, 45 repetitions (§6), 3 second-pass
calls (§11), and 32 snapshot-as-state calls over two fixtures (§13, §14). The three
prioritised architecture questions are recorded separately in PRIORITY-TESTS-01.md. §12 analyses the earlier records for reuse at
zero further spend. No chat model was called at any point, and none is in the path.

**Scope limit, stated first:** three fixtures, one question bank per fixture. This is a
cost-and-contract result with a sanity check on answers. It is **not** a cohort comparison and
it says nothing about conceptual completeness — §7 explains why it cannot.

---

## 1. The recorded contract was wrong in three ways

The recorded samples described the Decisions surface from documentation. Live calls falsified
parts of it. Each finding below is reproducible with `node tools/probe-decisions.js`.

| Claim in the recorded material | What the endpoint does |
| --- | --- |
| `criteria` is an array of options | **HTTP 400** — `expected record, received array`. For `choice`, criteria is a record of option → plain string; the answer's `choice` is one of its keys. |
| `locate` is a question type | **No such discriminator.** The union is `noul \| choice \| score \| box`. |
| `locate` returns text spans | **`box` is refused by both vendors** — "ScaleDown does not accept box questions", "Perplexity does not accept box questions". No engine in the cohort can return a text span. |
| `score` takes criteria like `choice` | `score` takes an **array** (a record is 400), and returns `{score, legend, probabilities, confidence}` where `legend` maps level → label. |
| `noul` field name is unverified | **Verified:** `instructions` alone is enough. If criteria is supplied it must be `{true, false}` strings. |
| cost must be computed from tokens × catalogue price | The endpoint reports its own `usage.cost`. On every run it matched `input_tokens × list price` **exactly**, so billing is straight per-token at list price with no per-question surcharge. |

Consequences, recorded rather than repaired:

- `perplexity/pplx-decider-v1.3` is **HTTP 404 — "No endpoints found"**. The only entry in the
  cohort that claimed `locate` cannot be reached, and `locate` does not exist on this endpoint
  anyway. `deciders.json` keeps the entry with `available: false` and `live_status`, so the
  recorded claim and its falsification sit side by side instead of the claim being quietly
  deleted.
- The two adapters were corrected to the wire form (`wireCriteria`), which is now the only place
  the difference between a bank's canonical option list and a vendor's wire format exists.
- `normalise.js` now prefers the provider's `cost` and keeps the catalogue product beside it as
  `catalogue_cost_usd`, so a price drift becomes visible instead of being averaged away.

`npm run selftest:decisions` grew from 39 to 40 checks: the old check asserted that v1.3 declares
locate, which is now known to be false. It was replaced by a check that a descriptor *which
serves* locate still yields a locate-capable adapter (so the handling path stays tested), plus a
check that no available engine in the verified cohort serves text evidence.

---

## 2. Every card on this path is `inferred`

Both engines answer `noul`/`choice`/`score` only. There are no spans, so:

- no card can be cited — every observation is `inferred`;
- the two bank questions that declare `evidence` produce `evidence_declared_but_uncitable` in
  the run record instead of a silent downgrade;
- two of expansion's four proposal rules (unclaimed `locate` span, cross-source shared term)
  **  cannot fire at all**, so expansion on this path can only test low-confidence and ambiguous
  answers. §11 runs the double pass live and confirms how little that leaves.

This is the architecture finding, not a harness gap: the cheap engines decide well and cite
nothing. A decision-only path can support differential assessment of *claims*, and cannot
support any claim about *provenance*.

---

## 3. Cost, measured

Provider-reported, per assessment. `chars` is the flattened state including source headers.

| Fixture | chars | questions | model | input tokens | multiplier¹ | cost | $/Mtok² | ≤ $0.002 |
| --- | ---: | ---: | --- | ---: | ---: | ---: | ---: | --- |
| F9 | 309 | 4 | scaledown/classify-1 | 1,358 | 17.41 | $0.00005432 | 0.04 | yes |
| F9 | 309 | 4 | pplx-decider-v1.2 | 363 | 4.65 | $0.00000726 | 0.02 | yes |
| F9 | 309 | 4 | pplx-decider-flash-v1.2 | 363 | 4.65 | $0.00000363 | 0.01 | yes |
| F3 | 488 | 5 | scaledown/classify-1 | 1,639 | 13.43 | $0.00006556 | 0.04 | yes |
| F3 | 488 | 5 | pplx-decider-v1.2 | 372 | 3.05 | $0.00000744 | 0.02 | yes |
| F3 | 488 | 5 | pplx-decider-flash-v1.2 | 372 | 3.05 | $0.00000372 | 0.01 | yes |
| F2a | 62,315 | 5 | scaledown/classify-1 | 61,773 | 3.97 | **$0.00247092** | 0.04 | **NO** |
| F2a | 62,315 | 5 | pplx-decider-v1.2 | 12,412 | 0.80 | $0.00024824 | 0.02 | yes |
| F2a | 62,315 | 5 | pplx-decider-flash-v1.2 | 12,412 | 0.80 | $0.00012412 | 0.01 | yes |

¹ reported input tokens ÷ (state chars / 4). The chars/4 figure is a pre-flight estimate and was
never used for cost. ² effective: `cost ÷ input_tokens × 10⁶`. It equals the list price in every
row, which is the *check* that the price used was the price charged.

Three things fall out of this table.

Every figure in this table was then reproduced exactly in five further calls per configuration:
`min = max = mean` on all nine, and identical `input_tokens` on all nine. Cost is deterministic
here even where the answers are not (§6), which makes it a safe planning number.

**Billing shape, not price, is what costs money.** ScaleDown counts the state **once per
question**: 12,412 × 5 = 62,060 ≈ 61,773 reported, and the measured cost ratio against
Perplexity is exactly `2 × 4.98 = 9.96`, matching the 2× list price times the ~5× token count.
Perplexity answers a group of questions for **one** pass over the state. With one question
ScaleDown's disadvantage would be only the 2× price; with five it is ~10×, and it grows with the
bank.

**The pre-registered interactive ceiling fails at moderate size on ScaleDown.**
`interactive_cost_per_pass_max_usd` is $0.002. F2a costs $0.00247 — the first paid run in this
repo to breach it. From the measured rate, a 5-question assessment exceeds $0.002 at roughly
50 kB of state (≈10,000 tokens per question), which is well inside its advertised 1M context.
Extrapolating arithmetically (not measured): a 1M-token state at 5 questions is
1M × 5 × $0.04/M = **$0.20** per assessment for ScaleDown. The $0.01–0.04/M input figure is
correct and, on its own, misleading: the multiplier is what an assessment actually costs.

**At 62 kB, cost per assessment is $0.0025 / $0.00025 / $0.00012.** Perplexity is 10× cheaper
than ScaleDown and flash 20× cheaper.

---

## 4. What the models answered

42 answers (14 questions × 3 engines), none malformed. `problems: []` on every run — the
adapters were not sent anything they had to repair.

- **F9** (offset / retry duration): all three answered `88113` and `7 seconds`, and agreed the
  offset is identical at both timestamps. ScaleDown was markedly less certain (`P=0.818` on the
  repeated offset, `0.748` on the single batch write) than Perplexity (`≥0.965`).
- **F3** (30 days vs 90 days): all three read both periods, selected `disagree`, and said
  **neither document is identified as governing** — the correct reading, and the one a
  least-effort system usually gets wrong by picking the newer revision.
- **F2a** (control A-17): all three gave `14 days` and `cold storage`, and all three correctly
  answered that no other numbered control appears.

Checked post hoc against the sources: **42/42 consistent**. That is decision accuracy on
questions that were asked. It is **not** completeness, because the bank decides what can be
answered — §7.

One harness observation, recorded not fixed: `assembleSnapshot` turns any `noul` below
`abstain_below` into an **abstention**, so Perplexity's `P(yes)=0.000` ("no other control is
named") is discarded as uncertainty rather than kept as a confident negative. The assembler
conflates *no evidence* with *evidence of absence*. Changing that is a decision-path semantics
change and needs its own pre-registration, so it is reported here instead.

---

## 5. The frozen grader cannot see these snapshots

`gradeFixture` matches required items through a card's `refs`. This path has no `refs`, so:

| Fixture | required coverage | cited cards | evidence kinds |
| --- | ---: | ---: | --- |
| F9 | 0.00 (r1, r2 missing) | 0 of 4 | 4 inferred |
| F3 | 0.00 (r1, r2 missing) | 0 of 5 | 5 inferred |
| F2a | 0.00 (r1 missing) | 0 of 4 | 4 inferred |

Every forbidden-claim check passes (0 hits), every snapshot passes the frozen validator, and the
cost fields populate. Coverage zero is **not attributable to the model**: it is the direct
arithmetic of "no engine can return a span". `runs/live/summary.json` carries
`attributable_to_model: false` on each of these grades so the number cannot be quoted out of
context.

The practical consequence: **a decision-only path cannot be graded by the v0.1.3 harness at
all.** Either the path gains an evidence mechanism (none exists in this cohort) or grading needs a
second, explicitly separate route that maps a decision answer to a required item without a span —
which is a new instrument, and therefore a new pre-registration.

---

## 6. Repeat stability — five calls per configuration

Each configuration was called five times with an identical body, no caching and no retry on
failure. 45 calls, **$0.01492605**, 45/45 HTTP 200, `problems: []` on every one.

Two levels are reported, because they answer different questions. **Same decision** means every
repetition selected the same option, or landed on the same side of the 0.5 abstain threshold —
what a caller consumes. **Byte-identical** means the normalised answer matched exactly, including
the probability — what a claim about determinism needs.

| Fixture | Model | reps | same decision | byte-identical | largest confidence/probability range |
| --- | --- | ---: | ---: | ---: | --- |
| F9 | classify-1 | 5 | 4/4 | 1/4 | 0.145 (`retry_duration` 0.709–0.854) |
| F9 | pplx-decider-v1.2 | 5 | 4/4 | 0/4 | 0.000057 |
| F9 | flash | 5 | 4/4 | 4/4 | 0 |
| F3 | classify-1 | 5 | 5/5 | 4/5 | 0.231 (`governing_document` 0.489–0.720) |
| F3 | pplx-decider-v1.2 | 5 | 5/5 | 0/5 | 0.000045 |
| F3 | flash | 5 | 5/5 | 5/5 | 0 |
| F2a | classify-1 | 5 | 5/5 | 1/5 | 0.160 (`other_controls_named` 0.171–0.332) |
| F2a | pplx-decider-v1.2 | 5 | 5/5 | 0/5 | 0.000053 |
| F2a | flash | 5 | 5/5 | 5/5 | 0 |
| **total** | | **45** | **42/42** | 6/14 classify-1 · 0/14 v1.2 · 14/14 flash | |

**1. The decisions are stable, so §4 is not a lucky sample.** Every repetition of every
configuration chose the same option and landed on the same side of the threshold: **42/42**. The
answers reported in §4 can be treated as this engine's answer on this material. This is a floor
result on 14 questions with generous margins, not a claim about close calls.

**2. Determinism is a vendor property, not a model-class property.** `flash` returned
byte-identical answers — probabilities included — in **14/14** question-instances. `v1.2` never did
(**0/14**), though its drift is numerically irrelevant (≤ 6×10⁻⁵, e.g. 0.999783 vs 0.999792).
ScaleDown varies materially: on F2a `other_controls_named` moved **0.171 → 0.332**, a 1.9× relative
swing on a question whose decision did not change, and on F3 `governing_document` confidence
crossed 0.5 in one repetition out of five (0.489 vs 0.720).

**3. The frozen consistency metric cannot see any of this — a metric gap, not a model gap.**
`gradeFixture`'s `consistency.jaccard_mean` and `claim_stability` return **1.000 for all nine
configurations**, including the one whose probability moved by 0.16, because both compare claim
text (with `{choice}` substituted) and ignore confidence. A configuration the v0.1.3 harness calls
perfectly consistent can hide a 2× relative swing in the number a differential assessment would
read. Text-level consistency is therefore necessary and not sufficient.

**4. Consequence for RDA.** Probability-level comparison needs repeats and a reported dispersion;
a single pass cannot distinguish a real delta from this noise. With the drift observed here
(±0.08 on a mid-range question), any question whose probability sits within ~0.1 of a decision
threshold will oscillate across repetitions — which is exactly where expansion's provisional
0.6/0.4 bands live. That band remains unauthorised, and this measurement is the argument for
treating it as a repeat-based quantity rather than a single number.

**5. Latency is long-tailed.** p50 525 ms, p95 **2,597 ms**, max **5,661 ms** (226–5,661 over 45
calls; three calls exceeded 2 s). The pre-registered p95 ceiling of 8,000 ms was not breached, and
5.7 s out of 45 calls is well inside it — but the tail is 25× the median, so a wall-clock budget
based on the median would be wrong by an order of magnitude.

## 7. The inventory over the real fixtures

`npm run inventory:run` → `runs/inventory/inventory-run.json`. All 16 text fixtures were scanned
(F4 is image-only and is skipped, correctly). 333 items, **every span re-derived exactly** by the
frozen resolver, no truncation.

| | |
| --- | --- |
| fixtures scanned | 16 (F4 skipped: no text) |
| characters | 252,656 |
| items | 333 |
| span failures | 0 |
| required items (post hoc) | 26 |
| covered by any overlapping item | 19 (0.731) |
| covered by a **point-scoped** item | 18 (0.692) |
| covered by whole-sentence spans only | 1 |
| items per required item | 12.81 |
| precision | **unmeasured** |

Yield by rule: `shared_sentence` 45.3%, `repeated_phrase` 37.8%, `qualified_identifier` 6.3%,
`version_literal` 3.0%, and five rules at ≤1.2% each. By kind: entity 163, relationship 152,
`unresolved_proposition` 4, `contradiction_candidate` 4, `unclaimed_span` 4,
`missing_connection` 4, `cross_source_reference` 2.

The 0.69 point-scoped figure needed measuring carefully, because a relationship item's primary
span is the **whole sentence** and therefore overlaps almost any quote inside it. Counting bare
overlap gave 0.731; excluding sentence-scoped rules gives 0.692. The honest number is ~0.69, and
it is the one to quote.

### What the run exposed about the instrument

1. **Item count is not sensitive to scale.** F2a–F2d are 62,250 characters each and yield **66
   items each** — the same 66, because the fixture is eight paragraphs repeated and the scanner
   deduplicates by entity key. A 62 kB context and a 2 kB context are indistinguishable in this
   instrument's output. A denominator that does not move with context size cannot be the
   denominator for a large-context claim, which is what D0 was waiting on.
2. **It is blind to key–value records.** F6b scores **0/3** required items: `status: in review`,
   `assignee: R. Okonjo`, and a prose sentence with no proper noun. There is no rule for field
   lines, and `proper_noun_phrase` does not match `R. Okonjo`.
3. **It is blind to a unique numeric fact.** F9 scores 1/2: the retry line (`retry of batch 512
   completed after 7 seconds`) contains no capitalised name, no identifier and no repeated
   bigram, so nothing fires on it. The offset line is found only because "committed offset" and
   "consumer group" recur.
4. **Its high-yield rules are combinatorial, not structural.** 83% of all items come from
   `shared_sentence` and `repeated_phrase`. Both scale with the *number of names per sentence*
   and with *repetition*, so a document that repeats itself looks richer than a dense one.
5. **`shared_context_unpaired` behaves as predicted** (4 items, 1.2%) — it did not become the
   noise source that the calibration feared, but F2a–F2d suppress it by repetition, so this is
   not evidence that it is quiet on real varied prose.
6. **Precision is still unmeasured, and that now matters more.** 0.69 recall on the answer key
   with 12.8 items per required item is uninterpretable without knowing how many of the other
   307 items are noise.

Verdict for D0, stated as an observation and not a decision: the inventory is **independently
reproducible** (every span re-derives, byte-exact, on every fixture) and **partially useful**
(0.69 point-scoped recall on human-adjudicated items), but it is **not yet a usable denominator**
for a large-context completeness claim, because its output volume does not respond to context
size and it has structural blind spots for records and unique numeric facts. Precision remains
unmeasured. The owner's condition — "after the inventory demonstrates that it supplies a useful,
independently reproducible denominator" — is met on reproducibility and only half met on
usefulness.

---

## 8. What this run does not establish

- Nothing about conceptual completeness. The bank defines the ceiling; §7 exists because that ceiling is exactly what the inventory is meant to challenge.
- Nothing about citation integrity, provenance, or evidence authenticity: no engine can emit a
  span.
- Nothing comparative between ScaleDown and Perplexity beyond cost, latency and answer values on
  14 questions. Answering "consistent with the sources" 42 times is a floor test, not a result.
- Nothing statistical about repetition stability. Five repetitions bound a sample, not a
distribution: no confidence interval is claimed, no variance component is estimated, and no
question was deliberately placed near a threshold to test flipping. A question at P≈0.5 with the
drift seen on F2a would be expected to oscillate, but that was not measured.
- Nothing about `flash` beyond its determinism: byte-identical answers across five calls is
strong evidence of a fixed decoding path, not evidence that the answer is right.
- Nothing about `typesafe/jev-1.14` (declared, not probed) or images (F4 is still uncaptured).

## 9. Reproduction

```
node tools/inventory-run.js                                   # R-a over every text fixture
node tools/probe-decisions.js                                 # contract probes, ~$0.00002
node tools/live-decisions.js --fixture F9 --model scaledown/classify-1 --bank banks/F9.json --dry
node tools/live-decisions.js --fixture F9 --model scaledown/classify-1 --bank banks/F9.json --repeat 5
node tools/live-report.js                                     # runs/live/summary.json (schema v2)
```

Each repetition writes its own record — `runs/live/<model>/<fixture>.r<k>.json` — and the report
groups them by configuration. Nothing is cached and no non-2xx is retried, because a retry would
silently change the sample.

Banks live in `banks/` and were authored from each fixture's task question and its sources **before
the answer key was read**; every bank records `grounded_in_answer_key: false` and states its
`authored_from`. The answer-key comparison in §7 is post hoc, on a frozen scan result.

`--max-usd` (default $0.10) refuses a call whose worst-case pre-flight exceeds the ceiling, and
`--dry` prints the request without sending it.

## 10. Verification

```
npm run selftest           → 52/52, exit 0   (unchanged)
npm run selftest:decisions → 40/40, exit 0   (39 → 40: the falsified locate claim was replaced)
npm run selftest:inventory → 39/39, exit 0   (unchanged)
npm run inventory:run      → exit 0, 0 span failures
npm run live:report        → exit 0, 45 runs / 9 configurations, 0 HTTP failures
node tools/live-expansion.js --fixture F3 --model scaledown/classify-1  → exit 0
node tools/live-expansion.js --fixture F3 --model perplexity/pplx-decider-flash-v1.2 \
  --bank-from scaledown/classify-1                                      → exit 0, same bank
node tools/reuse-report.js                                              → exit 0, 0 calls
node tools/snapshot-state-test.js --fixture F2a \
  --snapshot-from perplexity/pplx-decider-flash-v1.2                     → exit 0, 16 calls
node tools/snapshot-state-test.js --fixture F3 \
  --snapshot-from perplexity/pplx-decider-flash-v1.2                     → exit 0, 16 calls
```

Raw responses are kept verbatim in `runs/live/<model>/<fixture>.r<k>.json` (git-ignored, like all
of `runs/`), so nothing here depends on a re-run. The stability arithmetic is reproducible from
those files without spending anything: `npm run live:report` re-reads them and recomputes every
figure in §6.

## 11. The double-pass sample (one additional pass, as designed)

Added after §1–10, at the operator's direction, once the stability check in §6 showed the
decisions hold. Method: pass 1 is **read from disk** (already paid for, no re-charge), the harness
derives proposals from the native answers, and `planSecondPass` asks one additional pass over the
same state. Run with `node tools/live-expansion.js`; the records are in
`runs/live/expansion/<model>/<fixture>.json`.

### What the pass could expand on

Offline, before spending: **8 of 9 configurations derive zero proposals**, so there is no second
pass at all.

| Fixture | classify-1 | pplx-decider-v1.2 | flash |
| --- | --- | --- | --- |
| F9 | 0 | 0 | 0 |
| F3 | **1** (`low_confidence_choice`) | 0 | 0 |
| F2a | 0 | 0 | 0 |

The reason is structural, not statistical. Rule 1 (unclaimed `locate` span) and rule 4
(cross-source shared term) need `refs`, which no engine in this cohort can produce. That leaves
rule 2 (a choice with confidence inside 0.35–0.7) and rule 3 (a `noul` inside 0.4–0.6). Fourteen
confident answers produce **one** proposal.

And that one proposal is an artefact of the drift measured in §6: it exists because ScaleDown
answered `governing_document` at confidence **0.489** in this repetition. In the other four it
answered **0.720** — outside the band — and there would be no proposal at all. The entire
double-pass sample rests on a confidence that is not reproducible.

### One proposal, three engines, three verdicts

The proposal bank is harness-owned and engine-independent, so the identical pass-2 question was
sent to all three engines, with pass 1 seeded from ScaleDown in every case:

> *Is the classification "neither is identified as governing" for `governing_document` certain
> enough to rely on?*

| Engine | pass-2 cost | input tokens | P(yes) | verdict |
| --- | ---: | ---: | ---: | --- |
| classify-1 | $0.00001244 | 311 | 0.4825 | **indeterminate** |
| pplx-decider-v1.2 | $0.00000408 | 204 | 0.8558 | supported |
| flash | $0.00000204 | 204 | 0.7411 | supported |

`0.6 / 0.4` are the provisional, **unauthorised** bands baked into `evaluateSecondPass`; every
record carries `verdict_bands.authorised: false`. A decision-path threshold needs its own
pre-registration (R5) before any of these verdicts is quoted as a result.

Four things this shows.

**1. The verdict is engine-dependent, and the proposing engine is the one that cannot confirm its
own proposal.** ScaleDown lands at 0.4825 — dead centre of the dead zone — while both cheaper
engines say supported, at 3× and 6× less for the adjudication. So "is this proposal supported?" is
not a property of the snapshot alone; it is a property of the snapshot *and* the engine asked.

**2. The double pass produced zero additional cards.** The single supported item is an
`unresolved_question`, not a `claim` or a `relationship`, so `additional_cards: 0` and
`incremental_cost_per_supported_card: null` — null for the right reason, because there is no card
to price. Additional questions: **1**. Total two-tier cost on F3: **$0.000078** ($0.00006556 +
$0.00001244).

**3. The billing model is confirmed a third time.** Pass 2 sent one question instead of five, and
ScaleDown charged 311 tokens against 1,639 — the state counted once per question, again. So a
second pass over the same full state adds ≈19% for ScaleDown (311/1,639) and ≈55% for Perplexity
(204/372).

**4. `incremental_completeness` stays null**, because there is still no model-independent
denominator. The proposal set cannot measure what the pass-1 bank never asked about.

### What this means for the general snapshot

Expansion as specified is a **confidence-repair** mechanism, not a coverage mechanism. It can only
ask about something the bank already touched and the engine was unsure of. It cannot discover that
a document contains a retention conflict, a key–value record, or a numeric fact nobody asked
about — that needs either evidence (refused by every engine here) or a model-independent inventory
of what the corpus contains, which is D0, still the owner's decision.

So the gap between where we are and a general snapshot is precise, and it is not a model-quality
gap: **the bank defines the snapshot's ceiling, and the inventory is the only instrument that can
raise it.** With three engines answering 42/42 stably and cheaply, the decision layer is not the
bottleneck. Coverage is.

On reuse — "one keeper makes the others cheaper" — the mechanism exists and this section exercises
it: the proposal bank is engine-independent, so pass 1 runs once and adjudication runs anywhere,
and the cheap engines were both more decisive and 3–6× cheaper at it. But note what is *not* saved:
both passes send the **full state**, so a two-tier run costs more than a one-tier run, not less.
Real context savings would need the snapshot rendered *as* the state for later questions — a
different experiment, not measured here, and the one worth running next.

## 12. How much of the second pass is actually reusable

`node tools/reuse-report.js` → `runs/live/reuse.json`. **Zero spend**: it recomputes proposals from
the 45 pass-1 records and reads the 3 pass-2 records already on disk.

"One snapshot makes the other models cheaper" is four claims stacked on each other, and they
resolve in opposite directions.

| Layer | Question it answers | Measured | Reusable? |
| --- | --- | --- | --- |
| Cards across engines | would a second engine's pass 1 add anything? | **14/14** questions identical across 3 engines | **yes**, 100% on this material |
| Second-pass questions | is the proposal bank reusable as written? | **byte-identical** across all three engines | **yes**, 100%, and free |
| Proposal derivation | must a later model re-derive the agenda? | harness-owned, deterministic, $0 | **yes**, 100% |
| The state | is any context cached between passes or engines? | none — full state re-sent every call | **no**, 0% |
| Second-pass agenda over time | would re-taking the snapshot ask the same things? | 1 proposal in **1 of 5** repetitions | **no**, not reproducible |
| Second-pass verdicts | can one engine's verdict be inherited? | pairwise agreement **0.333**; inheritance error **0.667** (n = 1) | **no** |

### The decisive asymmetry

**Everything free is reusable; everything paid is not.** The proposal bank, the question wording
and the derivation are all reusable at 100% and cost nothing — reusing them saves $0, because they
were never charged. The only component worth money in the second pass is the **verdict**, and it is
the least reusable thing in the system: the same proposal, same state, same wording produced
0.4825 / 0.7411 / 0.8558 and two different verdicts.

So "reuse the second pass to save money" is not available. You can reuse its *questions* for free,
but you must buy every answer, and the answers are where the engines disagree.

### The agenda is an event, not an artifact

Proposals are derived from pass-1 confidences, and those are not reproducible (§6). On F3,
ScaleDown produced the proposal in **rep 1 only** — 0.489 in that draw, 0.720 in the other four,
which is outside the 0.35–0.7 band. Reps 2–5 generate an **empty** second pass. So a snapshot stored
today would usually ask nothing tomorrow: the second pass cannot be cached as a stable artifact, it
is a side effect of one particular confidence draw. Freezing the snapshot fixes the cards; it does
not make the agenda recur.

### The reuse that does pay

The card-level agreement is the one layer that saves real money: three engines produced **14/14
identical decisions**, so on this material one snapshot was substitutable for all three, and
**95.6% of cohort spend was avoidable** by keeping only the cheapest engine
($0.00013147 of $0.00298521). That is the operator's keeper hypothesis, measured — with the
condition attached in the record: it is valid only if one engine's decisions are accepted as
authoritative for every consumer, which 14/14 agreement on easy, confident fixtures makes plausible
and does not prove.

For scale, the second pass costs **15.9%** of a two-tier run on ScaleDown (pass 2 = +19.0% over
pass 1) and **35.4%** on Perplexity (+54.8%), with the full state re-sent both times. Perplexity's
second-pass share is higher precisely because its pass 1 is cheap — the state dominates either way.

### Limits of this measurement

- **n = 1** shared proposal. The verdict-agreement figure is an anecdote with arithmetic attached,
  not a rate. A real inheritance estimate needs a bank designed to produce many mid-band
  proposals, which is a different experiment.
- Agreement was measured on three fixtures whose answers were confident and correct. Questions
  near a boundary are exactly where engines would diverge, and none were asked.
- Reuse is not correctness: 14/14 agreement does not make the shared snapshot right.

## 13. The snapshot-as-state test — substitution fails, differential assessment works

`node tools/snapshot-state-test.js --fixture F2a --snapshot-from perplexity/pplx-decider-flash-v1.2`
→ `runs/live/state-test/summary.json`. 16 calls, **$0.0076506**. The snapshot is flash's F2a pass 1
rendered faithfully: **883 characters, 4 cards**, against a **62,315-character** source — 1.4% of
the original.

The obvious version of this test is circular: ask a snapshot the questions it was built from and
you learn only that it contains its own cards. So two banks were authored that the snapshot was
**never** built from, and the reference is the same engine's answer against the full source, so no
answer key had to be invented.

- **held-out** — 8 questions about source content the pass-1 bank never asked: rebalance lag,
  queue-depth interval, backfill overrun, offset ordering, unrecoverable failure, coordinator
  state, cold-shard scheduling.
- **delta** — a synthetic change notice amending A-17's export window (14 → 30 days) and the
  heartbeat window (→ 45 s), with 3 questions about what changed. This is the RDA shape: the
  snapshot is the prior state and the question is whether new evidence moves it.

### Substitution fails

| Engine | held-out matches | confidently wrong |
| --- | ---: | ---: |
| classify-1 | 1/8 | 5 |
| pplx-decider-v1.2 | 5/8 | 3 |
| flash | 1/8 | 5 |
| typesafe/jev-1.14 | 2/8 | 5 |

The failures are not abstentions. Asked how often queue depth is reported, three engines answered
**"every five minutes"** — from a state containing nothing about queue depth. Asked what happens to
an overrunning backfill, three answered **"resumed in the next window"**, the exact opposite of the
source. Neither can be exposed, because no engine in this cohort cites.

Two of the apparent passes need discounting, and this is the part a match rate hides:

- `h_unrecoverable` "matched" in **all four** engines because the option list itself gives it away
  ("a silent gap" against "a duplicate delivery"). That is lexical association, not retention.
- `pplx-decider-v1.2`'s 5/8 includes matches whose confidence collapsed from 1.000 to **0.588,
  0.638 and 0.683**. They agree with the full-source answer only because the threshold is 0.5; at
  any stricter band they would not count. Its 3 wrong answers are wrong in the same way as the
  others.

### Differential assessment works

| Engine | delta matches | full-source answer | snapshot answer |
| --- | ---: | --- | --- |
| classify-1 | **3/3** | P=0.699 conflict | P=0.843 conflict |
| pplx-decider-v1.2 | **3/3** | P=1.000 | P=1.000 |
| flash | **3/3** | P=0.998 | P=0.994 |
| typesafe/jev-1.14 | **3/3** | P=0.990 | P=0.980 |

All four engines detected that the notice conflicts with the prior state, reported the amended
30-day window, and picked up the new 45-second heartbeat. ScaleDown was *more* confident from
snapshot + notice (0.843) than from the 62 kB source + notice (0.699) — the card states 14 days
plainly, so the conflict is easier to see than inside a repeated 62 kB document.

### Cost

| Test | Engine | full source | snapshot | ratio |
| --- | --- | ---: | ---: | ---: |
| held-out (8 q) | classify-1 | $0.0039532 | $0.00017272 | **22.9×** |
| held-out (8 q) | pplx-decider-v1.2 | $0.0002511 | $0.00001482 | 16.9× |
| held-out (8 q) | flash | $0.00012555 | $0.00000741 | 16.9× |
| held-out (8 q) | jev-1.14 | $0.000549234 | $0.000040446 | 13.6× |
| delta (3 q) | classify-1 | $0.00149328 | $0.0000756 | 19.8× |
| delta (3 q) | pplx-decider-v1.2 | $0.00024822 | $0.00001194 | 20.8× |
| delta (3 q) | flash | $0.00012411 | $0.00000597 | 20.8× |
| delta (3 q) | jev-1.14 | $0.000542892 | $0.000034104 | 15.9× |

ScaleDown's tokens for the held-out bank fell from **98,830 to 4,318**. Saving is 92.6–95.6% in
every configuration.

**Incidentally, this is the first live probe of `typesafe/jev-1.14`**: 16/16 HTTP 200, accepts the
criteria record, and charges the state once per group like Perplexity — `deciders.json` is updated
from "not probed".

### The answer to the hypothesis

The snapshot is **not a general-context substitute** and **is** a differential-assessment
substrate. Those are different claims and only the second survives measurement.

- *"One snapshot answers everything more cheaply"* — **false here.** 17–23× cheaper, and it does
  not know what it was never told: 1/8 held-out fidelity on three of four engines, with confident
  fabrication instead of abstention.
- *"One snapshot makes later delta work cheaper"* — **true here.** 3/3 on all four engines at
  ~95% less cost, including on the engine that generated the snapshot.

This is the framing the harness was built for, and it sharpens the coverage argument rather than
weakening it: a snapshot knows exactly its cards. If the cards are bank-scoped, the snapshot's
competence is bank-scoped too — which is why "general contextual awareness" cannot come from a
better engine, only from a bank (or inventory) that asks about more of the corpus. And the failure
mode is not silence: given an impoverished state, these engines still answer, confidently and
wrongly, with nothing in the output to reveal it.

> **Correction, after §14.** The confidently-wrong answers above were partly induced by the bank:
> three of them were `choice` questions with no "cannot be determined" option, so the engine had to
> select something. On F3, where the absent facts were asked as `noul`, all four engines returned
> 0.055–0.36 instead — correct abstention, no fabrication. The silent-loss finding stands; the
> fabrication finding is a property of forced choice, not of the engines.

## 14. Replication on varied prose — F3, and a correction

Added after §13, which ran on F2a. F2a repeats eight paragraphs, so its substitution failure could
have been an artefact of the text rather than a property of bank-scoped snapshots. F3 is 402
characters of **varied** prose across two documents (a platform handbook at revision 12 and a
support playbook at revision 4) that disagree about retention, with no repetition at all.

`node tools/snapshot-state-test.js --fixture F3 --snapshot-from perplexity/pplx-decider-flash-v1.2`
→ `runs/live/state-test/F3.json`. 16 calls, **$0.0005145**. Same design: 6 held-out questions the
pass-1 bank never asked, and a 3-question delta against a synthetic 45-day directive.

### Substitution failure replicates — but for a different reason

| Engine | held-out matches | of which genuinely retained |
| --- | ---: | ---: |
| classify-1 | 4/6 | 1 |
| pplx-decider-v1.2 | 4/6 | 1 |
| flash | 4/6 | 1 |
| typesafe/jev-1.14 | 4/6 | 1 |

Identical across all four engines, which is itself the interesting part: the 4/6 is not four
independent measurements, it is one bank behaving the same way in four engines. Breaking the four
"matches" down:

- `h_scope` — **genuinely derivable**: the cards name "customer event logs", so the question can be
  answered from the snapshot. Confidence ~0.75–0.96 in both states.
- `h_control_owner` — **a control, not retention**: the source never names an owning team, so the
  correct answer is "not stated" and the snapshot can give it. Both states said no (0.01–0.38).
- `h_revisions` — **a 50/50 guess**. No revision number appears in the snapshot's cards; the engine
  picked "the platform handbook (revision 12)" anyway and happened to match.
- `h_why_90` — **a lexical artefact of the option list**, exactly like `h_unrecoverable` in §13: the
  investigative-sounding option is the obvious choice for a multiple-choice "why" question whether
  or not the state supports it.

So genuine retention of held-out content is **1/6**, consistent with §13's 1/8 and 2/8. The
conclusion holds: a bank-scoped snapshot does not substitute for the source, independent of
repetition.

### The correction: forced choice, not fabrication

On F2a the engines answered *confidently wrong* ("every five minutes", "resumed in the next
window"). On F3 the same two facts — exports on request, automatic deletion — were asked as `noul`,
and all four engines returned **0.055–0.36**, i.e. correctly said "no such statement", matching
neither the source nor a fabrication.

The difference is the question type, not the engine:

- a `noul` question about absent content **degrades gracefully** — confidence collapses to 0.05–0.36;
- a `choice` question about absent content **has no abstention to offer**, so the engine must select
  an option and selects one with high confidence.

Three of F2a's five "confidently wrong" answers were `choice` questions whose criteria had no
"cannot be determined" entry, and `h_why_90` here shows the same mechanism even when the guess
happens to land. **That is a defect in my banks, not a finding about the models.** Any future bank
must either give every `choice` an explicit "cannot be determined" option or ask absent-content
questions as `noul`, or the results will contain selections that look like knowledge and are not.

§13 now carries this correction inline rather than being quietly rewritten.

### The cost advantage inverts at small scale

| Engine | test | full source | snapshot | ratio |
| --- | --- | ---: | ---: | ---: |
| classify-1 | held-out | $0.00007988 | $0.00012884 | **0.62×** (i.e. 1.6× *more*) |
| pplx-decider-v1.2 | held-out | $0.00000892 | $0.000013 | 0.69× |
| flash | held-out | $0.00000446 | $0.0000065 | 0.69× |
| jev-1.14 | held-out | $0.00002709 | $0.000035952 | 0.75× |
| classify-1 | delta | $0.00004904 | $0.00007352 | 0.67× |
| flash | delta | $0.00000378 | $0.00000582 | 0.65× |

On F3 the snapshot is **917 characters against a 488-character source**. The harness renders each
card as a full sentence plus confidence annotations, so a 5-card rendering costs more than a short
document. Every engine therefore paid **1.3–1.6× more** from the snapshot than from the source, and
the finding is general: the rendered snapshot carries roughly **180 characters per card** of
overhead, so "cheaper" holds only once the source is comfortably larger than that. On F2a the same
rendering was 1.4% of the source and saved 93–96%; here it is 188% of the source and costs more.

So the cost claim needs a condition attached, and now has one: **the snapshot pays only when the
source exceeds roughly 180 characters per card it produces** — that is, when compression actually
happens. A snapshot of a small document is an expansion.

### Delta detection replicates

| Engine | delta matches | full source | snapshot |
| --- | ---: | --- | --- |
| classify-1 | **3/3** | P=0.838 new window | P=0.852 |
| pplx-decider-v1.2 | **3/3** | P=1.000 | P=0.999 |
| flash | **3/3** | P=0.998 | P=0.997 |
| jev-1.14 | **3/3** | P=0.970 | P=0.970 |

All four detected the 45-day override and that it withdraws the playbook's longer window, on a
different fixture with a different amendment. With §13 that is **6/6 delta questions across two
fixtures and four engines**, at probabilities within 0.02 of the full-source answer in seven of
eight engine-fixture pairs. Differential assessment from a snapshot is the one capability that
replicates cleanly.

### Record keeping

The first version of this tool wrote a single `summary.json`, which the F3 run overwrote before the
path was fixed. F2a's measurements survive in §13; its JSON artefact does not, and it is not
regenerated because a fresh run would not reproduce the same probabilities and would put the record
at odds with the table. The tool now writes one file per fixture (`F2a.json`, `F3.json`) and the F3
artefact was preserved by renaming. This is a small defect, and it is recorded rather than papered
over.
