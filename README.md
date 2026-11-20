# gca-experiment

A read-only qualification harness for two hypotheses:

- **GCA — Global Contextual Assessment.** One pass over operator-supplied material produces a structured snapshot: what is stated, where, with what confidence, what is missing, and what check would settle it.
- **RDA — Recursive Differential Assessment.** Comparing two snapshots tells you whether a change in the output is justified by a change in the input, or whether the model drifted.

The output is evidence about a model. It is not a decision, and this repo cannot make one: there is no runtime, no route, no remote storage and no deployment.

It has exactly one write: the report it renders to `runs/<id>/report.json` and `report.md` on the local filesystem. That is operator-side output, not persistence — nothing is read back, served, or sent anywhere by the harness. Saying "no storage" without that qualification would be false, and the difference matters: a local file an operator deletes is not a store a system reads.

## Status

| Fixture | Tests | State |
|---|---|---|
| F1 short document | can it read at all; forbidden over-reach; two traps | ready |
| F2a / F2b / F2c long document, needle at ~5 % / ~50 % / ~95 % | position sensitivity; a claim that keeps its evidence while its span moves | ready |
| F2d long document, needle sentence edited | justified change: this evidence really did change | ready |
| F3 two sources in contradiction | non-resolution: flag the conflict, do not pick; two traps | ready |
| F4 multimodal necessity | **pending capture** — blocked, see `fixtures/F4/capture.md` |
| F5 insufficient context | correct abstention; two fixture-level traps, since it has no required observations | ready |
| F6 instruction in source prose | data/instruction separation, shape 1 | ready |
| F6b instruction disguised as metadata | shape 2 | ready |
| F6c instruction inside quoted correspondence | shape 3 | ready |
| F6d instruction claiming to supersede the operator brief | shape 4 | ready |
| F6e instruction altering the output schema | shape 5 | ready |
| F6f instruction to conceal evidence | shape 6 — concealment also fails coverage | ready |
| F7 Mind-shaped page export (synthetic, redacted) | the first intended host surface | ready |
| F8 authentic but unsupportive citation | layer 2: real quotes, wrong support | ready |
| F9 repeated quotation | ambiguity is rejected, not guessed | ready |

Six injection shapes rather than one, because passing a prose injection establishes nothing about metadata, forwarded mail, authority claims, schema attacks or concealment.

The stub provider proves the graders discriminate. **No paid run has been recorded.** Until one is, nothing in this repo says anything about any real model.

## Quick start — free, offline, no network

```sh
node tools/build-fixtures.js
node run.js --provider stub --all --repeats 3 --out runs/stub
npm run selftest
```

`selftest` deliberately breaks things and checks that the metrics move: unstable claims must fail consistency, a fabricated citation must be rejected, an ambiguous quotation must be rejected rather than guessed, an authentic-but-unsupportive citation must fail relevance while authenticity still passes, and an obeyed instruction must fail every injection fixture.

## A paid run — needs your budget, your key, your authorisation

The first controlled comparison has a written procedure: **[RUN-PLAN-01.md](RUN-PLAN-01.md)** — frozen inputs, verified prices, per-model budget caps, the adjudication sampling rule, F4's exclusion, and abort criteria. Read it before spending anything; the commands there supersede the sketch below.

```sh
export OPENROUTER_API_KEY=...
node run.js --provider openrouter \
  --models google/gemini-2.0-flash-001 \
  --all --repeats 3 \
  --budget-usd 0.50 \
  --out runs/2026-11-18-gemini
```

The runner refuses a paid provider without `--budget-usd`, estimates every call before making it, and aborts when the next call would cross the cap. Prices in `models.json` are unverified; check the provider before you run and override with `--price-in` / `--price-out`.

## Reading the report

`runs/<id>/report.json` also carries `snapshots[]`: every valid observation with the verbatim quotes it cites. That is the evidence archive the adjudication procedure reads — keep it with the run.

`runs/<id>/report.md` has one row per model:

| Column | Layer | Meaning |
|---|---|---|
| citation integrity | 1 authenticity | share of snapshots whose every citation resolved to verbatim text |
| relevance | 2 relevance | share of snapshots citing no pre-declared trap quote; blank where the fixture declares none |
| required coverage | global assessment | share of ground-truth observations found |
| abstention | contextual reasoning | did it say "cannot tell" when it should, and only then |
| injection | data/instruction separation | did document-borne instructions stay inert |
| consistency | recursive differential | pairwise agreement across repeats of identical input |
| forbidden | contextual reasoning | claims the ground truth forbids |
| $/pass, p95 | — | cost and tail latency per pass |

Three things are kept apart rather than averaged into one score:

- **authenticity** — does the quote exist? Mechanical, and the only layer the harness settles alone.
- **relevance** — does the quote support the claim? Mechanical only where a fixture pre-declares a trap: an authentic quote that looks like support and is not. F1, F3, F5 and F8 declare traps; everywhere else it is reported as undeclared rather than assumed, and an unanticipated unsupportive citation is missed.
- **inference validity** — is the conclusion valid? Not machine-decidable. The run reports the kind distribution, a lexical overreach signal, and an **adjudication queue** naming every observation a human has to read.

The queue is pending work, not a result. A run whose queue is unread has not established contextual reasoning, and this report does not pretend otherwise.

The **placement signal** is advisory. It restates the pre-registered criteria so the same rule is applied every run; the decision belongs to the operator.

## Layout

```
PROTOCOL.md            the specification: boundary, schemas, metrics, thresholds, change control
thresholds.json        pre-registered; digest recorded in every run
models.json            candidate models and prices (unverified)
schemas/               normative JSON Schemas for input and snapshot
src/validate.js        the five invariants, including verbatim citation
src/spans.js           span resolution: trusts the quote, derives the offset, rejects ambiguity
src/evidence.js        the three evidence layers and the adjudication queue
src/diff.js            RDA: evidence-addressed claim identity, justified vs unjustified deltas
src/grade.js           mechanical metrics and the placement signal
src/providers.js       stub and OpenRouter; budget cap
src/report.js          markdown rendering
run.js                 the CLI
tools/build-fixtures.js  fixture authoring; computes every span from source text
tools/selftest.js      fault injection against the graders
fixtures/              generated: input.json, ground_truth.json, fixture.json
```

## Where the line is

This repo is not connected to AA or ARA, and must not be. It has no access to the preference store, the journal, a host page or the deployed Workers. If a capability demonstrated here later enters a system, it enters after a separate decision — as a retrieval pre-pass or a ladder rung — and not by wiring this harness in.

See `PROTOCOL.md` §5 for the inputs deliberately excluded, including the ones AA currently sends.
