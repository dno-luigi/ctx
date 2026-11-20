# GCA-RDA-COMPACTION-PILOT (H2) — specification

**Status:** specification only. Nothing here has been run.
**Pre-registered:** thresholds, fixtures and pass criteria are fixed before any data, and may not be
revised after seeing results.
**Separate from** `GCA-RDA-CODING-PILOT.md` (H1) by design, not by convention — see §2 and §9.

---

## 1. What H2 tests

H1 asks whether differential change context helps an agent decide better about a change. H2 asks a
different question:

> When an agent's context is compacted and it must continue the same work, does a GCA snapshot plus
> RDA updates plus selective reconstruction let it recover working state more completely and more
> cheaply than conventional compaction?

This is the context-management claim rather than the coding-adapter claim. If H2 passes, GCA/RDA is
useful wherever an agent must work longer than its window allows — which is a broader and more
durable proposition than being useful for repository diffs.

The two experiments share the identity and provenance substrate and nothing else. No H2 run may be
scored with an H1 gold set, and no combined verdict may be reported.

## 2. Why H2 must be separate

| | H1 (repo change) | H2 (compaction) |
| --- | --- | --- |
| What varies between arms | how a *change* is described | how *state* survives a boundary |
| Where the effect acts | decision quality at one point in time | cost and completeness of recovery |
| Primary metric | change-impact accuracy, tokens | tokens to reconstruct working state, retention |
| Failure it detects | missing dependencies in a diff | loss of decisions and constraints across compaction |
| Underlying requirement | anchors point at impacted regions | anchors are the *only* remaining evidence |

That last row is the reason the two cannot be merged: **H2 depends on anchoring more strongly than
H1.** In H1 the source is still in context and an unanchored card is merely less persuasive. In H2 the
source is gone, and an unanchored card can only be repeated, never verified. A capability that looked
adequate in H1 can fail in H2 for that reason alone, and merging the experiments would hide it.

## 3. Prior evidence, stated before the pilot

**Established:** identity is stable (25 ids / 207 cards, engine agreement 1.000); propagation loses
nothing (0 silent losses, 16/16 delta agreement); reuse works when answers agree and sources are
related; cost is $0.000124 per assessment on flash at 62 kB.

**Directly relevant to H2, measured today with `tools/plant-coverage.js`:** nine constraints a
continuation agent would need, drawn from existing fixtures, evaluated against existing snapshots:

| Fixture | present as a card | present **and anchored** | anchored coverage |
| --- | ---: | ---: | ---: |
| F3 | 3/5 | **2/5** | **0.40** |
| F9 | 2/4 | **1/4** | **0.25** |

Four failures, each a different kind:

- **Stated but unanchored.** "Nothing is deleted before the retention window closes" is captured
  exactly by a card, with no anchor. In H1 that is a minor weakness. In H2 it is the worst case: the
  claim survives, the evidence does not, and the agent cannot tell the difference between reading a
  recovered constraint and reading a remembered one.
- **Absent.** Revision numbers (F3 P4), the export capability (F3 P5), batch size and shard (F9 P2),
  the retry timestamp (F9 P4) produce no card at all.
- **Absent by granularity.** F9 P2 bundles two facts; the snapshot captured neither.
- **Present and correct.** Three plants are fully recovered, which shows the mechanism works when the
  inventory names the content.

This probe used document fixtures as a stand-in. An engineering task may differ either way — code
identifiers repeat and are highly lexically distinct, which may help the inventory — and that is
untested. It is a reason to run the pilot, not a result.

**Predicted gate status: H2 would currently fail its own stop rule (§10, S1).** As with H1, the
honest position is that the experiment is specified and not yet runnable.

## 4. Task design

The task must be long enough that the agent's own compaction fires, and structured so that loss is
measurable rather than merely plausible.

**Task:** a staged refactor in this repository — migrate inventory identity from positional to
content-addressed across every caller, add the revision registry, and keep the frozen suites green.
Chosen because:
- It genuinely exceeds a comfortable window: five modules, their callers, two test suites and the docs.
- It has **real dependency edges** (`inventory/scan.js → {completeness, identity, card-id-experiment}`,
  `src/spans.js → {validate, grade, report, identity}`).
- It has **decisions that must survive**: constraints that are checkable in the final diff.
- It has **repeatable actions**: re-reading a file, re-running a suite, re-applying an edit.

**Planted state, authored before any run** (`pilot/compaction/plants-H2.json`), 12–16 items across four
classes, each with a mechanical check:

| Class | Example decision | Check |
| --- | --- | --- |
| **Constraint** | "Do not modify `thresholds.json`, the frozen graders or `PROTOCOL.md`." | final diff touches none of them |
| **Decision** | "Card identity excludes confidence and probabilities." | no confidence field in any id input |
| **Decision** | "Registry links are one-to-one; no identity may claim two predecessors." | registry construction |
| **Rejected alternative** | "Positional ids are deprecated but retained until the pilot concludes." | both id forms still present |
| **Constraint** | "`runs/` is gitignored and must not be committed." | `git status` clean of `runs/` |
| **Fact** | "`locate()` refuses ambiguous quotes; identity must carry its own locator." | `cards/identity.js` still passes `locator` |

**Checkpoint:** the task is cut at a declared step — after stage 1 (the new identity module and its
first caller) and before stage 2 (the remaining callers). Compaction is forced at the checkpoint. Every
run reaches the checkpoint before any boundary event, so the pre-boundary state is comparable.

## 5. The two arms

Both arms: same agent, same model, same tools, same task, same pre-boundary transcript, same
compaction event. **The only difference is the recovery material.**

**Arm A — conventional compaction.** The agent's own summarisation of the pre-boundary history. To
recover anything the summary lost, it may re-read files and re-run suites. Those actions cost tokens
and are counted.

**Arm B — snapshot + deltas + selective reconstruction.** After the same compaction, the agent
receives:

```json
{
  "decisions": [{"decision_id":"...","text":"...","made_at_step":3,"anchor":{"source_id":"inventory/scan.js","start":412,"end":455}}],
  "constraints": [{"constraint_id":"...","text":"...","check":"thresholds.json untouched","anchor":{...}}],
  "delta_since_checkpoint": [{"item_id":"...","change":"superseded","replaced_by_revision":"..."}],
  "open_threads": ["stage 2 callers not yet migrated"],
  "unknowns": ["decisions with no anchor"],
  "plant_coverage": 0.0
}
```

Generation rules, so the pack is a recovery substrate and not a substitute for the task:
1. **No prose summary of the work.** The pack carries decisions, constraints, deltas and anchors — not
   a narrative of what was done.
2. **Every entry is anchored or explicitly listed as unanchored.** Unanchored state is shown in
   `unknowns` rather than omitted, so the arm is not silently advantaged.
3. **Selective reconstruction is limited to anchors.** The agent may read any file an anchor points to,
   at that region. It may not receive a pre-digested view of untouched files.
4. **Equal budget.** Both arms get the same post-boundary token allowance for recovery. Arm B's pack
   consumption counts against it.

## 6. Measurements

Per run, recorded to `pilot/compaction/runs/<arm>/<n>.json`:

| Metric | Definition | Collection |
| --- | --- | --- |
| **Retention of decisions and constraints** | of the planted items, how many are correctly restated *and* honoured in the final diff | planted-state check per §4, mechanical |
| **Dependency recall** | gold dependency edges named or correctly handled post-boundary | diff + gold set |
| **Repeated work** | post-boundary actions duplicating a pre-boundary action: same file read again, same suite re-run without intervening change, same edit re-applied | transcript diff |
| **Unsupported assumptions** | post-boundary claims not supported by any file the agent read after the boundary | blind adjudication |
| **Successful task continuation** | the task's acceptance oracle passes: `selftest` 52/52, `selftest:decisions` 40/40, `selftest:inventory` 39/39, plus the new identity assertions | mechanical |
| **Tokens to reconstruct working state** | tokens from the compaction event to the first productive action (first correct edit or first correct answer to a state question) | agent usage + transcript |

Two supporting figures, reported but not scored: total tokens for the whole run, and GCA pack cost
measured separately.

## 7. Controls

- Same agent and model in both arms; sampling settings fixed and recorded.
- Counterbalanced order (A,B,B,A…), 10 runs per arm = **20 runs per task instance**, three task
  instances cut from the same refactor at different checkpoints = **60 runs**.
- Visual and label blinding: the adjudicator sees transcripts with the arm label stripped.
- Frozen inputs: plants, checkpoints, gold edges and this document committed before the first run.
- No cross-contamination: fresh worktree at the baseline SHA; no arm sees a prior pack or transcript.
- Deviation log `pilot/compaction/deviations.md`, reported with every result.

## 8. Pass / fail criteria (pre-registered)

Let `tA`, `tB` be median tokens to reconstruct, `rA`, `rB` retention of planted items, `wA`, `wB`
repeated work, `pA`, `pB` continuation pass rates.

| # | Criterion | Threshold |
| --- | --- | --- |
| **Q1** | Continuation non-inferiority | `pB ≥ pA − 0.10` |
| **Q2** | Reconstruction cost | `tB ≤ 0.70 × tA` |
| **Q3** | Retention of decisions and constraints | `rB ≥ rA + 0.20` absolute |
| **Q4** | Repeated work | `wB ≤ wA` |
| **Q5** | Unsupported assumptions | `uB ≤ uA` |

**PASS** requires **Q1 ∧ Q2 ∧ Q5 ∧ (Q3 ∨ Q4)**.
**FAIL** is everything else. No partial credit, no re-running with new thresholds.

Reported regardless: per-checkpoint results, anchored plant coverage per run, the deviation log, the
cost split, and the full list of planted items that neither arm retained.

## 9. Attribution and the relationship to H1

If H2 fails, the failure is assigned to one component:

| Component | Evidence |
| --- | --- |
| **Inventory** | the planted decision produces no card at all (the F3 P4/P5, F9 P2/P4 pattern) |
| **Snapshot representation** | the card exists but is unanchored, so it cannot be reconstructed (the F3 P3 pattern) |
| **RDA deltas** | the state changed after the checkpoint and the delta is missing or wrong |
| **Reconstruction policy** | the anchor is right but the region returned is wrong or unreadable |
| **Agent** | the recovered state was in the pack and was contradicted anyway |

**Reported separately, never combined:**

| H1 | H2 | What may be claimed |
| --- | --- | --- |
| pass | pass | two capabilities attested separately: differential change context and context recovery |
| pass | fail | change description helps; state recovery does not — the adapter claim stands, the layer claim does not |
| fail | pass | recovery helps even though change description does not — the layer claim stands on its own |
| fail | fail | neither; attribution per component above |

A pass in one experiment is never evidence for the other, and no sentence may report a single verdict
over both.

## 10. Stop rules

- **S1 — plant coverage floor.** If mean **anchored** plant coverage on the pilot's own planted state is
  **below 0.60**, H2 does not test GCA and must be reported as *not run*. Probe measurement today:
  **0.40** and **0.25**. This is the live blocker.
- **S2 — pack leakage.** If the pack contains a prose narrative of the pre-boundary work, or any file
  content not reachable from an anchor, the run is void.
- **S3 — unequal budgets.** If Arm B consumes more post-boundary tokens than Arm A, the comparison is
  void, not adjusted.
- **S4 — no compaction occurred.** If the task fits in the window and no boundary event happens, the run
  is void and the task must be lengthened.

## 11. Budget

| Item | Estimate |
| --- | --- |
| GCA pack per run | ≈ $0.0002 (flash, several files) |
| Packs for 60 runs | **≤ $0.05** |
| Agent tokens | outside this harness; reported, not budgeted |
| Adjudication | dominant cost: 12–16 planted items × 60 runs, mechanical where possible |

## 12. Out of scope

- No commercial interface, pricing or positioning.
- No Aura, AA, Truth Engine or ARA integration.
- No claim that GCA/RDA is a general context-management layer beyond this agent, these tasks and these
  checkpoints. A pass supports that claim in its narrowest falsifiable form.
- No change to frozen graders, protocol, thresholds or historical records.

## 13. Deliverables

1. `pilot/compaction/plants-H2.json`, `checkpoints.json`, `gold-edges.json` — frozen inputs.
2. `pilot/compaction/runs/**` — 60 run records.
3. `pilot/compaction/deviations.md`.
4. `GCA-RDA-COMPACTION-PILOT-RESULTS.md` — per-checkpoint table, Q1–Q5, verdict, attribution, the
   separated H1/H2 table from §9, and the cost split.
5. One paragraph answering: *does an agent recover working state better from a GCA snapshot than from
   conventional compaction?* — the narrow question, and the only one this document authorises.

---

## Appendix — the probe, reproduced

```
node tools/plant-coverage.js
→ F3: 3/5 present as a card, 2/5 present and anchored (0.40)
→ F9: 2/4 present as a card, 1/4 present and anchored (0.25)
```

The one case that matters most for H2: a card states "The support playbook states that nothing is
deleted before its window closes" — correct, complete, and **unanchored**. In H1 that card is a
slightly weaker source of context. In H2 it is the failure mode the experiment exists to detect: state
that survives compaction as a claim with no way back to its evidence.
