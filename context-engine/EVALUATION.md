# Evaluation

**State:** methodology fixed, offline harness verified, **first live scan run 2026-11-20.** Thresholds in §6
are pre-registered and unchanged; results are in [LIVE-SCAN-01.md](LIVE-SCAN-01.md) and the consolidated
gate matrix is [POC-RESULT.md](POC-RESULT.md). **H2 failed in run 1** (model-only facts 0/2 in observations)
and **H4 failed in run 2** (attribution 0.667); H1, H3, H5–H8 passed in both. After the compaction defect
was fixed, a QA re-check on a pack rebuilt from the stored snapshot — not a new scan — **passed H4** at
0.833 attribution. No single run passed all eight gates, so the hypothesis remains not supported on this
fixture under the rule as written; all eight conditions have now been observed passing at least once.

---

## 1. Why this run exists

The claim under test is narrow and falsifiable:

> A cheap model, pointed at the **complete** source rather than a prior summary, can produce a context pack
> that lets an agent answer cross-file questions about current state, while every material claim remains
> traceable to a verbatim quote — and a later scan can update that pack by rescanning only what changed.

It fails if: quotes cannot be verified, the pack omits facts the questions need, answers contain material
the source does not support, or a differential scan loses unchanged context or keeps stale conclusions.

It is not testing whether the model is "good at summarising". No summary is produced.

## 2. Conditions compared

| Condition | Provider | Purpose |
| --- | --- | --- |
| **Stub baseline** | `stub-rule-scanner` | Deterministic, $0. Proves the pipeline and the harness; establishes the floor a model must beat on model-only facts |
| **Live** | GLM Flash Latest (`~z-ai/glm-flash-latest`) | The actual claim |
| **QA — retrieval** | none (deterministic) | Measures whether the pack *contains* the evidence, without a model in the loop |
| **QA — model** | same or another cheap model | Measures whether a model can answer from the pack alone |

Stub numbers are never reported as model evidence. The stub's misses are kept in the ground truth (the two
`model_only` facts and the contradiction), so the harness can show what it failed to find.

## 3. Fixture and ground truth

`fixtures/poc-repo` — 11 files, 3,238 bytes: README with invariants, architecture with components and a
dependency chain, decisions with rationale and a rejected alternative, a runbook with a known failure, a
config file, four source modules, one test, one superseded note.

`fixtures/poc-repo.ground-truth.json`, authored before any scan:

- **8 facts** with required phrases and sources (invariant, dependency, decisions, outstanding, risk).
- **2 model-only facts** (the configured timeout; the timeout contradiction between docs and config).
- **6 questions**, each needing information from a different file or a relationship between files.
- **3 traps** — statements the source does not support (wrong retention, the contradictory timeout,
  "backfill already implemented").
- **Relationship gold**: `ingest → store`, `store → retention`, `scheduler → ingest`.
- **Contradiction gold**: architecture says 30 s, config says 5 s.

The delta is declared in `fixtures/poc-delta/changes.json`: config timeout 5 → 15, retention 30 → 45, the
backfill TODO replaced by an import, `src/backfill.js` added, the superseded note deleted. Applied to a
temporary copy; the fixture is never modified.

## 4. Metrics

| Metric | Definition | Collected by |
| --- | --- | --- |
| **Fact retention** | ground-truth facts whose phrases appear in the snapshot's observations, with a resolved citation | deterministic phrase check |
| **Citation fidelity** | findings with `citation_verified` ÷ findings with any citation | verification record |
| **Fabrication rate** | citations that name a missing source or a quote absent from the bytes | verification flags |
| **Attribution** | questions whose expected source appears in the pack's source index and cited items | deterministic set check |
| **Relationship preservation** | gold edges present in `architecture.relationships`, and cross-partition edges not lost | set comparison |
| **Contradiction detection** | gold contradictions present in `snapshot.contradictions` | set comparison |
| **Omission rate** | items dropped from the pack, and ground-truth facts missing from both pack and omissions | pack coverage + omissions |
| **Reconstruction accuracy** | questions answerable from the pack alone (all required phrases **and** sources) | QA scoring |
| **Factual errors** | answers containing a trap statement | trap match |
| **Differential correctness** | `preserved_identical`, `unchanged_sources_rescanned == 0`, stale ≥ 1, invalidated ≥ 1 | delta verification |
| **Compaction quality** | tokens, items included/omitted, `reconstructible`, and whether any required fact is absent without being listed | pack artifact |
| **Cost and latency** | tokens, provider charge, catalogue comparison, wall time, per call | instrumentation |

"Phrases appear" is a deliberately mechanical test. It can be satisfied by a finding that quotes the right
line for the wrong reason; it is a lower bound on retention, not a comprehension score.

## 5. Procedure

1. Acquire and hash the subject; record every skip.
2. Resolve the budget for the selected model (ceiling 400k) and report the derivation.
3. Scan; verify every citation; aggregate; build the snapshot.
4. Build small / medium / large packs; record omissions.
5. Answer the six questions using **only** the pack: retrieval mode offline, model mode live.
6. Score answers and facts against the ground truth; count traps.
7. Copy the subject, apply the declared change set, acquire again.
8. Differential scan: rescan changed files only; carry forward the rest; revalidate carried quotes.
9. Verify unchanged context is byte-identical and stale/invalidated items are retained but excluded from
   conclusions.
10. Report measured tokens, resolved model, upstream provider, generation ids, provider charge, latency.

## 6. Pre-registered acceptance thresholds (first live scan)

| # | Threshold | Kind |
| --- | --- | --- |
| **H1** | accepted findings with an unresolved quote = **0**; citation failure rate ≤ **10%** | mechanical |
| **H2** | line-rule facts **8/8**; model-only facts **≥ 1/2** | phrase check |
| **H3** | planted timeout contradiction detected **≥ 1** | set check |
| **H4** | attribution **≥ 5/6**; reconstruction **≥ 5/6** | QA scoring |
| **H5** | trap statements in answers = **0** | trap match |
| **H6** | every ground-truth fact absent from the pack is listed in `omissions` or absent from the snapshot | mechanical |
| **H7** | `preserved_identical = true`; `unchanged_sources_rescanned = 0`; stale ≥ 1; invalidated ≥ 1 | mechanical |
| **H8** | every call has provider-reported tokens; charge recorded with its source; total ≤ the authorised budget; numbers reported as-is | instrumentation |

**Stop rules.** Abort and report failure — do not re-run to fish — if citation failure exceeds 20%, if the
resolved model is not a GLM Flash family member, or if actual spend reaches the budget cap before all
calls complete.

**Verdict rule.** All of H1–H7 must pass for "supported on this fixture". H2 or H3 or H4 failing is a fail,
not a partial. H8 is a reporting requirement, not a quality threshold.

**Pre-registration for a future run, not retroactive.** Two metric clarifications are recorded in
[POC-RESULT.md](POC-RESULT.md) §5: H2 will score model-only facts across observations **and**
contradictions, and q3 attribution will accept any of the three sources that state the fact. They apply to
future measurements only; every result in this document and in [LIVE-SCAN-01.md](LIVE-SCAN-01.md) keeps the
rules as written here. [POC-RESULT.md](POC-RESULT.md) also lists what the PoC does not establish.

## 7. Offline baseline (measured, $0)

Current stub run, reproducible with `node context-engine/poc/run-poc.js`:

```
files 11 · bytes 3,238 · partitions 1 · strategy single_pass (fallback 60,000)
findings 30 · citation verified 30 · failed 0
conclusions 29 · inferences 1 · questions 1 · contradictions 0
packs: small ~1,195 tokens (15/40 items) · medium ~3,242 (40/40) · large ~3,242
QA retrieval-from-pack: retention 0.50 · attribution 0.83 · reconstruction 0.50 · traps 0
planted facts 8/8 · model-only facts 0/2
delta: +1 source · 3 changed · 1 removed · preserved 26 · stale 1 · invalidated 2 · added 1 · updated 1
differential checks: preserved_identical true · unchanged rescanned 0
```

Two findings that belong in the record:

- **A small pack can be larger than its source.** The medium pack is ~3,242 estimated tokens against ~810
  tokens of source. Per-item JSON with repeated source references costs more than the prose it replaces at
  this scale. Compaction pays off when the source greatly exceeds the working set, which an 11-file fixture
  cannot demonstrate.
- **Retrieval QA is capped at four items per question.** That cap, not the pack, is why two questions fail
  offline. A model reading the whole pack is not subject to it, which is one reason H4 must be measured
  live rather than inferred from the stub.

## 8. Cost accounting

- Model: `models.json`, verified against the OpenRouter catalogue on 2026-11-20. Default is the moving alias
  `~z-ai/glm-flash-latest` ($0.0399/M in, $0.0784/M out, 1.05M context).
- Every call records `requested_model`, `resolved_model`, `upstream_provider`, `generation_id`.
- `cost_source = provider` means the response reported a charge. `catalogue` means it did not and the
  product of reported tokens and the registry price was used — visible, not hidden.
- A missing usage field stays `null`; the summary says how many calls were unmeasured.
- The pre-flight estimate is `ceil(chars/4)` and exists only to refuse oversized calls.
- Authorised budget for the first live run: **$0.05**, ceiling 400k tokens per call, output ≤ 3,000 tokens
  (pre-registered).
- **Disclosed deviation:** the first call was truncated at 3,000 output tokens, producing an unparseable
  payload. The cap was raised to 8,000 as a harness fix and the run repeated; both attempts and their spend
  are recorded in [LIVE-SCAN-01.md](LIVE-SCAN-01.md) §1 and §6. No quality threshold was changed.

## 9. Threats to validity

| Threat | Effect | Mitigation in this design |
| --- | --- | --- |
| One small fixture, authored by the same person who wrote the fixtures | thresholds may be easy | ground truth, traps and model-only facts fixed before the run; stub baseline exposes obvious gaps |
| Mechanical phrase matching | overstates retention | reported as a lower bound; live QA adds source attribution |
| Stub recall is low by construction | offline numbers look weak | stub is labelled; the live run is the evidence |
| Moving alias | model may change under the same id | `resolved_model` recorded per call |
| Token estimates | budget may be conservative or optimistic | used only for partitioning; cost from reported usage |
| Single writer, no transport hardening | results are not production behaviour | stated; not measured |

## 10. Reporting

A live result must report, at minimum: mode, requested and resolved model, upstream, generation ids,
partitions and budget source, input/output tokens, provider charge with source, latency, H1–H8 with the
observed value, the six question outcomes, the contradiction outcome, delta verification, and every
limitation observed. Results go to `examples/poc-report.json` and a companion note; they are not folded into
the frozen GCA/RDA baseline.
