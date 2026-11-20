# GCA-RDA-CODING-PILOT — specification

**Status:** specification only. Nothing in this document has been run.
**Author of the rule:** this document is pre-registered — thresholds, fixtures and pass criteria
below are fixed before any pilot data exists, and may not be revised after seeing results.
**Supersedes:** nothing. Depends on `LIVE-RUN-01.md`, `PRIORITY-TESTS-01.md`, `CARD-ID-01.md`.

---

## 1. What this pilot is for

Three questions have been established separately and must now be answered together, on a real
codebase:

| Question | Where it stands |
| --- | --- |
| **Technical validity** — does GCA/RDA preserve useful context while reducing repeated analysis? | Partly established on synthetic fixtures: decisions are stable (42/42), propagation loses nothing (0 silent losses, 16/16 delta agreement), and reuse is real but conditional. |
| **Operational value** — does it help a coding agent decide better when a codebase changes? | **Untested.** This is the pilot's job. |
| **Commercial differentiation** — is it distinct enough to pay for? | **Out of scope.** Deliberately deferred until the pilot produces a measurable effect, or fails to. |

The pilot is not a demo and not a product. It is a controlled comparison with a pre-registered
outcome, designed so that **it can fail**.

## 2. Hypothesis

> When a codebase changes, giving a coding agent an RDA context pack — stable card ids, provenance
> anchors, dependent items and a preserved/changed/superseded/unknown classification of the affected
> region — produces the same or better change outcomes as conventional repository exploration, using
> fewer tokens and missing fewer dependencies.

Falsified if, on the pre-registered fixture set, the GCA arm is worse on outcome (P1) and no better
on efficiency or dependency recall (P2, P3).

## 3. Prior evidence, stated honestly before the pilot

Nothing here is favourable by default, and three of these numbers bound what the pilot can show.

**Established:**
- Decision stability: 42/42 identical decisions across five repetitions, four engines.
- RDA propagation: **0 silent losses** in four configurations; amendment landed 3/3 everywhere.
- Identity: 207 cards → 25 distinct ids; **engine identity agreement 1.000**; 20 anchors re-resolve
  after a global offset shift.
- Cost: $0.000124 per assessment on flash at 62 kB; $0.0025 on ScaleDown (which breaches the
  $0.002 interactive ceiling at ~50 kB).

**Known limits, which the pilot must carry as covariates:**
- **Classification coverage is low.** Under a controlled edit, F3 yielded 1 preserved, 1 changed,
  0 superseded and **3 unknown** cards; F9 yielded 2 preserved, **2 unknown**. The system could
  establish a state for **40%** of cards. `unknown` is the unanchored set.
- **Deletion is invisible.** The one clause deleted in the controlled edit was covered by an
  unanchored card (`nothing_deleted_early`), so the edit produced no state change anywhere.
- **Edits to non-anchored occurrences are invisible.** Changing the second occurrence of F9's
  repeated log line produced zero state changes, because every anchor points at the first.
- **Omission is not yet detectable at item level.** Inventory item ids are positional (`inv_00NN`),
  so an in-place text change keeps its id: the controlled edit produced 13 → 13 items and 0 newly
  uncovered items.

**Consequence for the pilot:** a null result is uninterpretable unless classification coverage is
reported per change. Section 11 makes that a stop rule.

## 4. Pilot repository and baseline

**Repository:** this one — `Ai-Nspired/gca-experiment`, the branch this work sits on. Node ESM, no
build step, no database, no external services.

**Why it is a valid pilot target:**
- It has a **frozen oracle that does not involve GCA**: `npm run selftest` (52), `selftest:decisions`
  (40), `selftest:inventory` (39). A change is "correct" when the relevant suite passes and the
  intended checks change — decided by the repo, not by us.
- It has real architectural coupling: `src/spans.js → src/validate.js → src/grade.js → adapters/*`,
  and `inventory/scan.js → {completeness, identity, card-id-experiment}`. Changing a shared function
  genuinely breaks dependents.
- Its size is small enough that a control agent can read everything, which makes the control arm
  strong rather than handicapped. **If the GCA arm only wins because the control cannot fit the repo,
  the pilot is worthless** — this repo denies that confound by construction.

**Baseline:** one commit SHA, tagged `pilot-baseline`, recorded in `pilot/baseline.json` with the
three suite results. All runs start from this SHA with a clean working tree.

## 5. The five controlled changes

Each is a small diff, authored as a patch under `pilot/patches/`, with a developer-style task prompt
and an objective oracle. Patches are authored **from the diff**, never from the GCA context, and are
frozen before any run.

| # | Change | Files touched | Task prompt (abbreviated) | Oracle |
| --- | --- | --- | --- | --- |
| **C1** | Shared interface change | `adapters/decision/interface.js` (+ adapters, `validate.js`) | "The decision request contract now requires a `criteria_shape` field. Update the contract and everything that builds or validates a request." | `selftest:decisions` 40/40; `selftest` 52/52; a new assertion that a request without `criteria_shape` is rejected |
| **C2** | Dependency modification | `inventory/scan.js` (+ `completeness.js`, `cards/identity.js`, `tools/card-id-experiment.js`) | "`scanInventory` now returns `{items, survey}` instead of an array. Update all callers." | `selftest:inventory` 39/39; `card-id` exits 0; `completeness` exits 0 |
| **C3** | Configuration change | `thresholds.json` (+ `src/grade.js`, `src/validate.js`) | "`abstain_below` moves to 0.25 and the consistency bands tighten. Make the code and the documentation agree." | `selftest` 52/52 **and** a deliberate check that a 0.30-confidence `noul` now abstains |
| **C4** | Widely used function | `src/spans.js` `locate()` | "`locate()` should return `{ok:true, ambiguous:true, candidates}` for repeated quotes instead of failing. Update callers that treat `ok:false` as 'not found'." | `selftest` 52/52; `rda` exits 0; `identity-states` still classifies F3 as it does today |
| **C5** | Injected regression | `src/spans.js` `normalizeSpan` | "Three self-test checks are failing after a merge. Find and fix the cause." | `selftest` 52/52, with the specific failing checks named in `pilot/C5.expected.json` |

**Gold sets.** For each change, before any run, a human authors `pilot/gold/C<n>.json`:
`impacted_symbols`, `impacted_files`, `must_not_break`, `dependency_edges`. Authored from the patch,
not from any agent output and not from GCA.

## 6. The two context arms

Both arms run the **same agent, same model, same tools, same task prompt, same starting SHA**. Only
the initial context differs.

**Arm A — conventional (control).** Full repository access: file tree, search, read. No context pack.
This is what a competent coding agent has today.

**Arm B — GCA/RDA context (treatment).** The agent receives a context pack and **file access limited
to the anchors in it**. The pack is generated from the diff by the pipeline under test and contains:

```json
{
  "changed_items":  [{"item_id":"...","source_id":"src/spans.js","locator":{"start":412,"end":455},"quote":"..."}],
  "cards":          [{"card_id":"crd_...","claim":"...","state":"changed|preserved|superseded|unknown","anchors":[
                      {"anchor_id":"anc_...","item_id":"...","locator":{"start":120,"end":184}}]}],
  "dependents":     [{"anchor_id":"anc_...","cards_sharing":["crd_..."],"questions":["..."]}],
  "unknowns":       ["crd_..."],
  "classification_coverage": 0.40
}
```

**Design rules for Arm B, so the test is fair and is a real test:**
1. **Anchors, not prose.** The pack gives locators and quotes, never a summary that could substitute
   for reading the code. If the pack were a summary, the pilot would test summarisation.
2. **No model-generated relationships.** Ids and locators come from assembly (`cards/identity.js`);
   the decision models only supply claim text and states.
3. **Unknown cards are listed explicitly.** Withholding them would inflate the arm.
4. **File access is restricted, not removed.** The agent may read any file an anchor points to,
   including files not in the diff. This is the provenance claim being tested: an anchor should lead
   somewhere useful.

## 7. Controls

- **Blind adjudication.** The oracle is mechanical (the repo's suites), so it cannot be biased. Where
  a judgement is unavoidable (unsupported-assumption counting), the adjudicator sees a transcript with
  the arm label stripped and in randomised order.
- **Repetition.** 10 runs per (change × arm) = **100 runs**. Temperature/sampling fixed per arm and
  recorded.
- **Order balance.** Run order is interleaved (A,B,B,A…) to remove warm-cache and time-of-day effects.
- **No contamination.** Each run starts from a fresh worktree at `pilot-baseline`. Arm B runs never
  see a prior transcript or a prior pack.
- **Frozen inputs.** Patches, gold sets, prompts and this document are committed before the first run;
  any later change invalidates prior runs and must be recorded as a deviation.
- **One deviation log**, `pilot/deviations.md`. A deviation does not fail the pilot but must be
  reported with every result.

## 8. Measurements

Per run, all recorded to `pilot/runs/<change>/<arm>/<n>.json`:

| Metric | Definition | Collection |
| --- | --- | --- |
| **Relevant information retrieved** | precision and recall of files read and symbols named, against the gold `impacted_*` sets | transcript parse + gold set |
| **Incorrect assumptions** | assertions in the agent's plan not supported by any file it could read; counted by a blinded adjudicator | manual, blind |
| **Missed dependencies** | gold `dependency_edges` absent from the agent's final change or explanation | diff + gold set |
| **Change-impact accuracy** | Jaccard of impacted symbols the agent actually changed/named vs the gold set | diff + gold set |
| **Outcome (primary)** | the oracle passes, and `must_not_break` still passes | mechanical |
| **Tokens consumed** | agent-reported input+output tokens for the whole run, plus GCA's own measured cost for Arm B | agent usage + `runs/` record |
| **Time to correct** | agent turns and wall-clock until the oracle first passes | transcript |

**GCA cost is reported separately from agent tokens** and never merged into a single dollar figure.
The pilot's cost claim is "context construction costs X, agent tokens are Y", not "we saved Z".

## 9. Pass / fail criteria (pre-registered)

Let `pA`, `pB` be oracle pass rates over 50 runs per arm; `tA`, `tB` median tokens; `rA`, `rB` median
dependency recall.

| # | Criterion | Threshold |
| --- | --- | --- |
| **P1** | Outcome non-inferiority | `pB ≥ pA − 0.10` |
| **P2** | Token efficiency | `tB ≤ 0.80 × tA` |
| **P3** | Dependency recall | `rB ≥ rA` (one-sided) |
| **P4** | Unsupported assumptions | `uB ≤ uA` |
| **P5** | No catastrophic miss | in at most 1 of 5 changes does B miss a gold dependency that A catches |

**PASS** requires **P1 ∧ P4 ∧ P5 ∧ (P2 ∨ P3)**.
**FAIL** is everything else. There is no partial credit, and no re-running with a different threshold.

**Reported regardless of verdict:** per-change results, classification coverage, the deviation log,
and the cost split. A verdict without per-change detail is not a result.

## 10. Attribution rule on failure

If the pilot fails, the failure is assigned to exactly one component, using pre-declared evidence:

| Component | Evidence that assigns blame |
| --- | --- |
| **Snapshot representation** | Arm B's anchors point at the right files, but the pack omits the dependency the agent needed; `unknown` cards sit on the impacted region |
| **Inventory** | The impacted symbol has **no inventory item at all** (the `retry_duration` pattern) — the pack could not have contained it |
| **Assessment model** | The item exists, the anchor exists, but the card's claim or state is wrong or missing |
| **Agent, not GCA** | The correct anchor was in the pack and the agent did not read it |

Every failed run gets one of these four labels. "Inconclusive" is allowed only when the transcript is
unavailable, and is counted as a failure of the harness.

## 11. Stop rules

Pre-registered, applied before interpretation:

- **S1 — coverage floor.** If mean `classification_coverage` on the pilot's own changes is **below
  0.50**, the pilot **does not test GCA** and must be reported as *not run*, with the inventory
  expanded first. Today's measured value on F3 is **0.40**, so this is a live risk, not a formality.
- **S2 — pack size.** If the pack for any change exceeds the diff plus 4× the changed files' size,
  the arm is leaking a summary and the run is void.
- **S3 — oracle ambiguity.** If a change's oracle can pass without doing the work (e.g. a suite that
  does not cover the changed path), the change is withdrawn and replaced by another of the same class.

## 12. Budget

| Item | Estimate | Basis |
| --- | --- | --- |
| GCA context per change (flash) | ≈ $0.0002 | measured $0.000124 at 62 kB |
| GCA context per change (ScaleDown) | ≈ $0.0025 — **over the interactive ceiling** | measured F2a |
| Context build, 100 runs | **≤ $0.30** | 5 changes × 10 × 2 arms, one engine |
| Agent tokens | outside this harness; reported, not budgeted here | agent usage |

The pilot is cheap in GCA terms. Its cost is **agent time and adjudication time**, which is why n=10
per cell and not n=50.

## 13. Out of scope

- No commercial interface, pricing page, UI, or hosted endpoint.
- No Aura, AA, Truth Engine or ARA integration.
- No change to frozen graders, protocol, thresholds or historical records.
- No new model providers; the pilot uses the engines already declared in `deciders.json`.
- No claim about coding assistants in general. The pilot speaks about **this agent on these five
  changes**, and any generalisation is stated as extrapolation.

## 14. Deliverables of the pilot

1. `pilot/baseline.json` — SHA, suite results, environment.
2. `pilot/patches/C1…C5.patch` and `pilot/gold/C1…C5.json` — frozen inputs.
3. `pilot/runs/**` — 100 run records.
4. `pilot/deviations.md` — every deviation, dated.
5. `GCA-RDA-CODING-PILOT-RESULTS.md` — per-change table, the five criteria, the verdict, the
   attribution for every failure, and the cost split.
6. A one-paragraph answer to: *does this capability produce a repeatable advantage in a real
   development workflow?* — the question the pilot exists to answer, and the precondition for
   anything commercial.

---

## Appendix — why this order

Your sequence puts commercial validation fourth, and this specification enforces that. Nothing in it
can be run against a customer, a pricing hypothesis, or a product surface. The only thing it can
produce is evidence about whether an agent with provenance-anchored differential context does
measurably better work than an agent without it — on five changes, in one repository, with an oracle
that existed before the experiment.

If it fails, the attribution rule says which of four components to fix before trying again. If it
passes, the result is narrow and specific, which is the only kind worth building on.
