# gca-experiment

A read-only qualification harness for two hypotheses:

- **GCA — Global Contextual Assessment.** One pass over operator-supplied material produces a structured snapshot: what is stated, where, with what confidence, what is missing, and what check would settle it.
- **RDA — Recursive Differential Assessment.** Comparing two snapshots tells you whether a change in the output is justified by a change in the input, or whether the model drifted.

The output is evidence about a model. It is not a decision, and this repo cannot make one: there is no runtime, no route, no storage, no deployment, and no write path anywhere in it.

## Status

| Fixture | State |
|---|---|
| F1 short document | ready |
| F2a / F2b / F2c long document, needle at ~5 % / ~50 % / ~95 % | ready |
| F3 two sources in contradiction | ready |
| F4 multimodal necessity | **pending capture** — blocked, see `fixtures/F4/capture.md` |
| F5 insufficient context | ready |
| F6 instruction embedded in source text | ready |
| F7 Mind-shaped page export (synthetic, redacted) | ready |

The stub provider proves the graders discriminate. **No paid run has been recorded.** Until one is, nothing in this repo says anything about any real model.

## Quick start — free, offline, no network

```sh
node tools/build-fixtures.js
node run.js --provider stub --all --repeats 3 --out runs/stub
npm run selftest
```

`selftest` deliberately breaks things and checks that the metrics move: unstable claims must fail consistency, a fabricated citation must be rejected, an obeyed instruction must fail the injection fixture.

## A paid run — needs your budget, your key, your authorisation

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

`runs/<id>/report.md` has one row per model:

| Column | Meaning |
|---|---|
| citation integrity | share of snapshots whose every citation resolved to verbatim text |
| required coverage | share of ground-truth observations found |
| abstention | did it say "cannot tell" when it should, and only then |
| injection | did document-borne instructions stay inert |
| consistency | pairwise agreement across repeats of identical input |
| forbidden | claims the ground truth forbids |
| $/pass, p95 | cost and tail latency per pass |

The **placement signal** is advisory. It restates the pre-registered criteria so the same rule is applied every run; the decision belongs to the operator.

## Layout

```
PROTOCOL.md            the specification: boundary, schemas, metrics, thresholds, change control
thresholds.json        pre-registered; digest recorded in every run
models.json            candidate models and prices (unverified)
schemas/               normative JSON Schemas for input and snapshot
src/validate.js        the five invariants, including verbatim citation
src/spans.js           span resolution (trusts the quote, derives the offset)
src/diff.js            RDA: claim identity, justified vs unjustified deltas
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
