# DECISION-MODEL-PROPOSAL-01 — correcting the experimental hypothesis

Status: **proposal only.** No protocol, threshold, fixture, schema or model file was
modified to produce this document, and no model was called. Nothing was charged,
deployed or connected to AA, ARA, Mind or any production Worker.

The only network request made while preparing this was a **free, unauthenticated
GET** to `https://openrouter.ai/api/v1/models?output_modalities=all` to read the
public catalogue, plus two public documentation pages. No API key was used.

This file is the proposal; the protocol and artifacts it would change are untouched
until the decisions in §9 are made.

---

## 0. The correction, restated in one line

Not "which LLM summarises best", but: **can a $0.01–0.04/M decision model ingest an
extremely large body of material in one request and return a comprehensive,
evidence-addressed, probability-bearing snapshot that supports later verification
and differential assessment?**

Three consequences run through everything below:

1. The cohort is decision models, and general-purpose chat models are **optional
   reference data, never a requirement**. Nothing in the plan may depend on Gemini.
2. A decision model **cannot emit `gca-snapshot/v1`**. It answers typed questions
   with probabilities. Either the output contract changes or the models cannot be
   measured at all.
3. Cost is a primary result, and the cost structure is **not yet known**: the two
   vendors bill the state differently when several questions share it (§7).

---

## 1. Verified model facts

Source: OpenRouter public catalogue, `GET /api/v1/models?output_modalities=all`,
fetched **2026-11-18**; vendor docs. Prices are USD per 1M tokens.

| id | vendor | context | input | output | modality (in → out) | endpoint |
|---|---|---|---|---|---|---|
| `scaledown/classify-1` | ScaleDown | 1,000,000 | 0.04 | 0 | text+image+file → decisions | `/api/alpha/decisions` |
| `perplexity/pplx-decider-v1.2` | Perplexity | 262,144 | 0.02 | 0 | text+image → decisions | `/api/alpha/decisions` |
| `perplexity/pplx-decider-flash-v1.2` | Perplexity | 262,144 | 0.01 | 0 | text+image → decisions | `/api/alpha/decisions` |
| `perplexity/pplx-decider-v1.3:free` | Perplexity | 262,144 | 0 (free tier) | 0 | text+image → decisions | `/api/alpha/decisions`, `/api/alpha/extractions` |
| `perplexity/pplx-decider-flash-v1.3:free` | Perplexity | 262,144 | 0 (free tier) | 0 | text+image → decisions | `/api/alpha/decisions`, `/api/alpha/extractions` |
| `typesafe/jev-1.14` (reference, optional) | TypeSafe | 262,144 | 0.042 | 0 | text+image → decisions | `/api/alpha/decisions` |

Perplexity documents `pplx-decider-v1.3` at **$0.02/M** and
`pplx-decider-flash-v1.3` at **$0.01/M** input, output free. OpenRouter currently
lists the v1.3 entries under `:free` ids; the paid v1.3 ids were not present in the
listing on the fetch date. Treat v1.3 pricing as documented, not as listed.

**The listing trap.** `/api/v1/models` returned 478 models and **zero** matches for
`decider` or `classify-1`. With `?output_modalities=all` it returned 740, including
all six decision ids. Decision models declare `output_modalities: ["decisions"]` and
are filtered out by default. Any earlier statement that these models "do not exist"
would have been an artifact of the query.

### Contract, verified from vendor docs

Shared shape (Jev-compatible): `POST`, body `{ model, state, questions }`, where
`state` is the material and `questions` is a **map of caller-named questions**, each
`choice`, `noul`, `score`, or (Perplexity v1.3 only) `locate`.

- `noul` → one probability, P(yes).
- `choice` → selected option + confidence + full probability distribution; up to 255 options.
- `score` → ordered levels (1–10; use ≥2), expected value + confidence + per-level probabilities.
- `locate` → spans as `{ start, end, text, score }`, **offsets in Unicode characters**,
  verbatim substrings of `state`; requires v1.3; string `state`, no images, ≤128 questions.
  Trained on ≤8k-token inputs, evaluated on ≤32k; longer inputs accepted but
  **span quality is not measured by the vendor**.

Limits and semantics that matter:

| fact | value | consequence |
|---|---|---|
| Perplexity context | 262,144 tokens | Decider **cannot** test "millions of tokens" |
| Perplexity per-question ceiling | state + any one question under 256K tokens | practical input ceiling ≈ 250K; overflow is answered in groups |
| Per-group billing | "each group counts the `state` again" | cost ≥ state × number of groups |
| ScaleDown billing | "`usage` is the sum of every internal call's tokens"; each question becomes its own internal classify call | cost ≈ state × questions |
| ScaleDown state | only `state.text` / `state.document` are read (not arbitrary multi-field state) | sources must be flattened into one text, provenance carried by markers |
| Tunable parameters | `supported_parameters: []` for the whole cohort | no `temperature`, `seed`, `max_tokens`, `response_format` |
| Determinism | not controllable | the "temperature 0 ⇒ repeats must agree" premise is void |
| Unknown top-level field | 400 | the adapter must send exactly the decisions shape |

**The single most important capability fact:** `locate` returns spans **with the
text**, and `choice`/`noul` return calibrated probabilities. Requirement 8 of GCA
(confidence and uncertainty) becomes measurable for the first time — with real
numbers, not a model's self-report.

---

## 2. What currently assumes a conventional generative model

Verified by inspection, with locations.

| # | Assumption | Where | Effect on the decision cohort |
|---|---|---|---|
| A1 | Endpoint is Chat Completions | `models.json` `endpoint`, [src/providers.js:194](src/providers.js#L194) | Decisions live at `/api/alpha/decisions`; every call would 404 |
| A2 | Request body is `{messages, temperature, max_tokens, response_format}` | [src/providers.js:219-232](src/providers.js#L219) | Unknown fields → 400; no messages, no temperature, no max_tokens |
| A3 | Output is prose that may contain JSON, needing lenient parsing | `buildPrompt`, `parseJson`, [src/providers.js:44](src/providers.js#L44), [src/providers.js:63](src/providers.js#L68) | Answers are typed objects keyed by question; prose parsing is dead code |
| A4 | The model authors claims, kinds, refs and abstentions | `SHAPE`, `RULES`, prompt | The model authors **answers**, not observations; the harness must assemble |
| A5 | One call = one prompt over all sources, output ≤ `max_tokens` | `callModel`, budget estimate | Cost scales with questions × state, not with output tokens |
| A6 | Usage arrives as `prompt_tokens` / `completion_tokens` | [src/providers.js:239-240](src/providers.js#L239) | Decisions return `input_tokens` / `output_tokens` → the harness silently falls back to `chars/4` and **under-counts by the question multiplier** |
| A7 | Output tokens are a cost driver | `price_out`, estimate formula | Output is free; `max_tokens` in the estimate inflates the gate 2–10× |
| A8 | A model can be emulated by `stub` or called by one `provider` string | `providers.js` branch | Needs a per-model interface descriptor, not a vendor branch |
| A9 | Images arrive as OpenAI `image_url` parts in a chat message | [src/providers.js:203](src/providers.js#L203) | Decisions take images inside `state`, ≤8 per question |
| A10 | Temperature 0 makes repeats comparable | `run.js` default, `snapshot.run.model.temperature` | Not settable; consistency must be interpreted as model variance |
| A11 | A paid run requires a positive budget | [src/providers.js:197](src/providers.js#L198) | `$0` free cohort ids are refused |

Not assumptions, and reusable as-is: the five invariants, the snapshot schema as a
*normalised* target, span/ambiguity resolution, the three evidence layers, RDA, the
adjudication procedure, the fixture authoring gate, and the self-test discipline.

---

## 3. What must change for decision interfaces

Proposed as discrete changes, each with its experimental consequence. None applied.

**D1 — Interface descriptor per model, not a provider branch.**
`{ endpoint, questionTypes, maxQuestions, contextTokens, perQuestionStateCeiling,
stateFormats, modalities, hasLocate, pricing{input, output, perRequestMin}, determinism }`
loaded from a new `deciders.json`; `models.json` untouched as reference data.
*Consequence:* cost and capability become data, so a run cannot silently use a
model outside its measured limits.

**D2 — A question bank per fixture (`gca-questions.v1`).**
The cohort cannot choose what to say, so the harness must ask. A bank is a set of
named questions per fixture: `noul` for presence/contradiction, `choice` over
candidate evidence (including traps), `score` for completeness/severity, `locate`
for provenance.
*Consequence, and the main risk:* **comprehensiveness becomes a property of the
bank, not only the model.** A bank written from the ground truth would make coverage
trivially high and the experiment worthless. The bank must therefore be authored
from the *question the operator would ask*, not from the answer key, and every bank
must be published with the run. This is the single largest validity threat in the
decision-model design and it needs an explicit rule before the first run.

**D3 — An answer→snapshot assembler, versioned.**
Answers become `gca-snapshot/v1` observations: `claim` derives from the question's
affirmative reading, `refs` from `locate` spans, `kind` from the question type,
`confidence.extraction` from span score, `confidence.interpretation` from the
answer probability. No decision field is added; the invariants hold unchanged.
*Consequence:* the claim text is **harness-authored**, so GCA's "can it write a
conceptual snapshot" is replaced by "can it answer a comprehensive bank correctly".
That is a different — and for verification, better — hypothesis, and the run must
say so. Assembler version is part of comparability: change it, and old numbers die.

**D4 — Per-call usage capture and per-question cost accounting.**
Read `input_tokens`/`output_tokens`, record questions per request, compute
`cost = input_tokens × price_in / 1e6` and report both billed tokens and state
tokens. (§7.)

**D5 — Scale ladder fixtures (§4) and a verified-input measurement.**
Advertised context is not processed context; the ladder measures the difference.

**D6 — Determinism handling.**
Repeats are still run, but consistency is reported as *observed variance* with the
parameter situation stated (no temperature, no seed). No threshold is edited.

**D7 — Injection as a paired-state differential.**
Decisions emit no claims to inspect, so F6's phrase test has no analogue. Replace
with: same question, `state` with and without the injected text; measure ΔP and
choice flips. Reuses the RDA machinery and is a stronger test.
*Consequence:* F6a–F6f as written stop being meaningful for this cohort.

**D8 — A `choice`-over-evidence form of the F8 trap.**
Options include the supporting clause and the trap clauses. Picking a trap is a
relevance failure with a probability attached — a cleaner instrument than the
current "did it cite a trap quote".

**D9 — Grading the fields that are currently ungraded.**
`domains`, `checks`, `gaps`, `confidence` are in the schema and are **never scored**
(§5). Adding metrics for them is required for the hypothesis and is a grading
change, so it needs your authorisation and a re-baselined self-test.

---

## 4. Fixtures: valid, adaptable, or invalid

### What survives unchanged

F1, F2a–F2d, F3, F5, F7, F8, F9 all test model-agnostic behaviour *provided* the
answers are assembled into the snapshot schema. F4 stays pending; both vendors read
images (Perplexity: ≤8 per question inside `state`; ScaleDown: `state.document`),
so F4 becomes *possible* rather than blocked by interface.

Per-fixture adaptation, and what changes:

| fixture | status | adaptation | note |
|---|---|---|---|
| F1 | valid | bank: 3 presence questions + 1 approval `noul` | the non-approval trap survives |
| F2a–d | valid, **scale-insufficient** | `locate` for the needle at depth; F2d as `choice` between 14/30 days | 15.5k tokens vs 262k/1M windows |
| F3 | valid | two `choice` questions (one per source) + contradiction `noul` | resolving is still detectable |
| F4 | pending capture | image `state`; redaction unchanged | no claim until captured |
| F5 | valid | `locate` with nothing to find must return `[]`; low `noul` | abstention becomes measurable, not just declared |
| F6a–f | **invalid as written** | paired-state ΔP (D7) | no claims exist to inspect |
| F7 | valid | bank over the page export | unchanged semantics |
| F8 | valid, **best fit** | `choice` including traps (D8) | strongest relevance instrument in the set |
| F9 | valid | `locate` on a repeated sentence | a silent single-span answer is the failure |

### What GCA requires, versus what is graded today

Grep of `src/grade.js`, `src/diff.js`, `src/evidence.js`: `domains` appears **0**
times, `confidence` **0**, `gaps` **0**, and the snapshot's `checks` array **0** (the
six `checks` in `grade.js` are the harness's own pass/fail map, which shadows the
name).

| # | GCA requirement | measured today | gap |
|---|---|---|---|
| 1 | what is present and explicitly stated | required coverage | ok |
| 2 | where information originates | `refs` + authenticity | provenance only as `source_id`; no section/offset provenance metric |
| 3 | relationships between components, claims, concepts | **nothing** | `domains` ungraded |
| 4 | dependencies and structural relationships | **nothing** | no fixture, no metric |
| 5 | contradictions | F3 pass rate | one fixture, pass/fail only |
| 6 | missing information and unresolved questions | abstention flag only | `gaps` ungraded |
| 7 | evidence per observation | authenticity + relevance | ok |
| 8 | confidence and uncertainty | **nothing** | `confidence` ungraded |
| 9 | what would resolve uncertainty | **nothing** | `checks` ungraded |

**Four of the nine requirements are unmeasured, and one more is only partially
measured.** The harness today tests extraction accuracy and honesty, not
conceptual coverage. That is the substantive mismatch with the corrected hypothesis,
and it is independent of the model cohort: generative models would fail the same
gap.

### Fixtures to add

- **Scale ladder** (§4.1) — the hypothesis's core.
- **Structure fixture** — a corpus with an explicit dependency chain (A requires B
  requires C) and a cross-reference 300k characters apart; grades `domains` and
  relationships.
- **Codebase corpus** — a small repository with a module graph and one defect reachable
  only by following the graph; the application the brief names.
- **Collection fixture** — five related documents where the answer requires two of
  them and one contradicts a third.
- **Gap/checks fixture** — ground truth declares the expected `gaps` and the
  question that would settle each; grades requirement 9.
- **Calibration fixture** — many `noul` questions with known truth, to test whether
  the returned probabilities are calibrated (Brier score / reliability bins), which
  is the one thing decision models offer that chat models cannot.

### 4.1 Scale ladder

Rungs chosen from measured ceilings, not from marketing:

| rung | target input | models able to attempt | purpose |
|---|---|---|---|
| L0 | ~8k tokens | all | contract and assembler sanity |
| L1 | ~32k | all | the vendor's stated `locate` evaluation ceiling |
| L2 | ~128k | all | beyond `locate`'s measured range |
| L3 | ~250k | all | Perplexity's practical ceiling (262K ctx, 256K per question) |
| L4 | ~500k | ScaleDown only | first rung beyond any Decider |
| L5 | ~1M | ScaleDown only | the advertised ceiling |

Every rung carries the same content contract: six needled facts at 5/20/50/80/95/99 %
depth, one contradiction split across two distant sections, one dependency chain,
one declared gap, one relationship set.

**Content must not be repeated filler.** F2's cyclic filler is a fine instrument at
62k characters and a shortcut risk at 1M: a model can answer from the part it kept.
The ladder needs a coherent synthetic corpus — generated prose with real internal
structure, unique sentences, and a document map.

Measured per rung: provider-reported input tokens, needle recall by depth (silent
truncation is visible as a depth-dependent cliff), output completeness, latency,
cost, and whether the provider split the request into groups.

**Verified maximum** = the largest rung with full needle recall *and* usage that
matches the intended state size. Nothing above that is claimed.

---

## 5. Comparing structured decision outputs fairly

Six rules, proposed:

1. **One state serialisation, one question bank, one assembler for every model.**
   Otherwise a difference is a harness difference.
2. **Two-level scoring.** L0 *conformance*: did every question get an answer, was
   anything coerced or dropped, did the provider split the request. L1 *substance*:
   coverage, span precision, abstention, trap selection, consistency, cost.
   A model that fails L0 is reported as unusable, not as low-scoring.
3. **Normalisation loss is a metric.** Fraction of answers that needed coercion or
   that were dropped. A model with 30 % loss cannot be compared on substance.
4. **Do not compare across interfaces as if they were one quantity.** A decision
   model's `choice` accuracy and a chat model's claim coverage are different
   measurements. Report them in separate columns labelled by interface; share only
   fixture, required coverage, authenticity, abstention, consistency and cost.
5. **The model's output is never ground truth.** The assembler produces data; the
   operator's adjudication is the reference for inference (existing procedure,
   unchanged).
6. **Publish the bank and the assembler version with the run.** A bank is part of
   the instrument; hiding it makes the result unreproducible and the coverage number
   meaningless.

Recommended run matrix, once authorised: the four decision ids × the current fixture
set (assembled) × 3 repeats, then the scale ladder on the two models that can reach
it. Chat models: only if explicitly requested as reference, never as baselines.

---

## 6. Cost without rounded estimates

Current state: the harness reads `usage.prompt_tokens`; decisions return
`input_tokens`. The fallback is `chars/4`, so for this cohort cost would be
**estimated and wrong by the question multiplier** without any warning. That is a
measurable defect, not a rounding issue.

Proposed cost record, per call: model, endpoint, state characters, questions asked,
provider-reported `input_tokens`/`output_tokens`, price snapshot used, HTTP status,
latency, and whether the provider reported grouping.

Proposed reported quantities, separately — never averaged into one number:

| quantity | definition | why it is needed |
|---|---|---|
| billed input tokens | provider `input_tokens` | the thing actually charged |
| state tokens | tokens of the material, once | the thing the hypothesis is about |
| question multiplier | billed ÷ state | exposes per-question billing |
| input cost | billed × price_in | the real charge |
| output cost | tokens × price_out | zero for this cohort, stated not assumed |
| $/snapshot | cost per assembled snapshot | the economic proposition |
| $/1M state tokens | cost ÷ state tokens | comparability across question counts |
| latency p50/p95 | wall clock per request | interactive viability |
| reconciliation delta | computed total vs the provider's usage page | catches silent mispricing |

The two vendors bill the shared state differently — ScaleDown sums every internal
call's tokens (cost ≈ state × questions), Perplexity counts the state again per
group of questions that did not fit. **Which is which, and by how much, is itself an
experimental result**, and the first run should measure it rather than assume it.

Illustrative arithmetic, to be replaced by measurements: 1M-token state at $0.04/M
with 8 questions ≈ $0.32 per snapshot under per-question billing, versus ≈ $0.04
under per-group billing; a 250k state at $0.02/M with 8 questions ≈ $0.04 versus
≈ $0.005. For comparison, a $3/M chat model reading 250k tokens once costs ≈ $0.75
before output. The economic proposition is plausible; it is not yet measured.

`--budget-usd` must remain mandatory for any paid call. The `$0` free v1.3 ids are
useful for L0 conformance smoke tests only; free-tier behaviour is not paid-tier
behaviour, and no result from a free tier may appear in a comparison.

---

## 7. Can the current harness test the hypothesis?

**No.** Ranked blockers, hardest first:

1. **Interface.** Nothing in the cohort can be called: wrong endpoint, wrong body,
   wrong response shape (A1–A3).
2. **No question-bank layer.** Even with a working call, the answers cannot become a
   snapshot, and comprehensiveness would be unmeasurable (D2, D3).
3. **No scale.** The largest fixture is 62,250 characters ≈ 15.5k tokens — 1.5 % of
   ScaleDown's window and 6 % of Decider's. The hypothesis is about extremes, and
   the harness has never run beyond 15.5k tokens (§4.1).
4. **Conceptual coverage is ungraded.** Four of nine GCA requirements have no metric
   at all; this is true for every cohort (§4).
5. **Cost is mis-measured for this cohort** (A6, A7, §6), so the economic result —
   the point of the exercise — would be an estimate dressed as a measurement.
6. **Determinism premise is void** (A10): no temperature, no seed.

What is genuinely reusable and worth keeping exactly as it is: the five invariants,
the snapshot schema as the normalised target, `locate`-style verbatim checking with
ambiguity rejection, the three evidence layers kept separate, the RDA machinery
(with the 48-character window retained as *experimental*), the adjudication
procedure, the fixture authoring gate, and the 52-check self-test discipline.

Estimated work, if you approve the direction: D1–D5 is roughly a day of focused
change to `providers.js`/`run.js` plus a new assembler and question-bank schema;
§4.1 ladder generation is another day; D9 (grading `domains`/`checks`/`gaps`/
`confidence`) is a grading change that re-baselines the self-test. None of it
requires a paid call to develop — the stub can cover the interface with recorded
fixtures.

---

## 8. What this proposal deliberately does not do

- Does not edit `PROTOCOL.md`, `thresholds.json`, `models.json`, `RUN-PLAN-01.md` or
  any fixture.
- Does not delete or rewrite the generative cohort; it demotes it to optional
  reference.
- Does not declare the 48-character window validated, nor fix it.
- Does not change a metric, a threshold or a historical decision record.
- Does not call a model, spend money, deploy, or connect to any production system.

---

## 9. Decisions needed before any code

1. **Cohort.** Confirm `scaledown/classify-1` + `pplx-decider-v1.2` +
   `pplx-decider-flash-v1.2` as the primary set, with v1.3 as the preferred
   Perplexity version once its paid ids are confirmed. Keep TypeSafe Jev as an
   optional fourth (same contract, $0.042/M).
2. **Question-bank validity rule.** Accept the requirement that a bank is authored
   from the operator's question, not the answer key, and published per run? Without
   this rule the coverage number is not admissible.
3. **Assembled-snapshot claim text is harness-authored.** Accept that this changes
   the hypothesis from "writes a snapshot" to "answers a comprehensive bank", or
   specify a hybrid.
4. **Grading the ungraded fields** (`domains`, `checks`, `gaps`, `confidence`) —
   authorise a grading change and a self-test re-baseline.
5. **Scale ladder rungs** and the acceptance rule for "verified maximum".
6. **Chat models:** reference-only, or excluded entirely from the first run?
7. **Budget ceiling** for the first decision-model run, once the interface exists.
   At $0.01–0.04/M the whole matrix above is likely under $5, but the cap is yours
   to set and it stays mandatory.
