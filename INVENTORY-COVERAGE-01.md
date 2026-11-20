# INVENTORY-COVERAGE-01 — can new rules see what the inventory misses?

**Date:** 2026-11-18 · **Cost:** $0 (deterministic rules; no model calls).
**Frozen, untouched:** `inventory/scan.js`, `cards/identity.js`, the four state definitions, the 0.60
revision threshold, and both pilots' gates. This experiment adds a separate module and scores it.

## 1. Oracle authored first

`pilot/coverage/required-items.json` was written **before any new rule existed**, from the source text
with a fixed four-class checklist. It records `authored_before_new_rules: true`, the matching rule, and
the precision exclusions.

**Independence is procedural, not inter-rater.** One reviewer authored the items, from the sources,
without seeing rule output. That is weaker than the second independent reviewer you asked for, and it
is stated as a limit rather than papered over. What it does prevent is the specific failure you named:
the rules could not be shaped by the oracle, because the oracle predates them.

31 required items across ten fixtures, covering all four classes. F2a–F2d (62 kB variants) are
unadjudicated and excluded from scoring.

## 2. The four rules

`inventory/rules-coverage.js`, additive, same item shape as the existing scan:

| Kind | Detects |
| --- | --- |
| `explicit_fact` | numbers, dates, times, versions, identifiers, and `key: value` lines |
| `structural_constraint` | deletion, exception, scope, condition, prohibition, requirement |
| `relationship` | ownership, dependency, governance, supersession |
| `repeated_role` | one value appearing more than once in different surroundings |

Each class is tested **independently per clause**, so a clause that states a fact *and* a constraint
emits both. A single-item-per-clause precedence order was the first design and had to be abandoned:
it silently classified "the `tax_id` field is **required** … which **blocks** submission" as a plain
fact, because the identifier matched first. That is precisely the class this experiment exists to
recover.

## 3. Results

| Class | required | baseline recall (strict/loose) | new recall (strict/loose) | new items | new precision (strict/loose) |
| --- | ---: | --- | --- | ---: | --- |
| `explicit_fact` | 20 | 0.500 / 0.650 | **0.950 / 0.950** | 41 | 0.488 / 0.610 |
| `relationship` | 3 | 0.000 / 0.333 | **1.000 / 1.000** | 6 | 0.500 / 0.667 |
| `structural_constraint` | 7 | 0.143 / 0.571 | **1.000 / 1.000** | 8 | 0.875 / 1.000 |
| `repeated_role` | 1 | 0.000 / 1.000 | **1.000 / 1.000** | 6 | 0.333 / 0.833 |
| **overall** | **31** | **0.355 / 0.613** | **0.968 / 0.968** | **61** | **0.525 / 0.689** |

Two results stand out.

**Structural constraints: 0.143 → 1.000.** This is the class you singled out as consequential for
coding and legal work, and it is where the baseline was worst. The single clause the baseline missed —
"Nothing is deleted before that window closes" — is now detected, as are the F8 contractual condition
and F7's `can_submit=false` prohibition.

**Repeated roles: now represented.** F9's second occurrence is captured by a two-span item, which is
the thing that makes an edit to that occurrence detectable at all. Previously the inventory had no
per-occurrence dimension, so no identity scheme could see the change.

Remaining miss (1 of 31): **"backfills it in two batches"** — a quantity written as a word. The value
rule matches digits only. Left unfixed deliberately: adding word-number support now, after seeing the
miss, is oracle-tuning. It is a real gap and belongs in the next rule revision.

## 4. Precision, honestly

Precision against this oracle is **0.689 loose / 0.525 strict** — a lower bound, not an estimate of
junk. The oracle is not exhaustive: it lists 31 items, the rules emit 61. I inspected all 19 unmatched
items after the tokenizer fix:

- 8 are `key: value` attributes the oracle did not list (`service: billing-api`, `project: atlas`,
  `app: Mind`, `surface: workspace/form`, `field legal_name: …`) — true facts.
- 4 are version headings (`## 0.9.2` … `## 0.9.5`) — true facts about releases.
- 4 are release-note or identity lines carrying an identifier (`# Change request 2087`, `# Loader
  runbook — section 4`, a note mentioning `401`) — true facts.
- 3 are multi-class duplicates of the above emitted under `relationship` because
  `project`/`service` are declared relationship keys — the weakest part of the rule set, and a design
  choice rather than a fabrication.

**No fabricated item was found among the 19.** So the measured precision understates real precision
substantially, and the honest statement is: *recall 0.968 against a 31-item oracle; of 61 emitted
items, 19 are outside the oracle and none of those is false.* A complete oracle would be needed to
state precision properly.

## 5. Three measurement bugs caught before reporting

Recorded because each would have produced a wrong conclusion:

1. **A malformed regex.** `\b(nothing|…|no\s+\w|not\s+\w|…)\b` can never match a phrase ending in a
   word, so every prohibition phrased "is not yet approved" or "no amendment" was silently dropped.
   It made structural-constraint recall look like 0.857 when it was 1.000.
2. **A field-name error** made overall precision `NaN` instead of a number.
3. **A tokenizer defect** split `## 0.9.2` into `## 0.`, `9.`, `2` and `ghcr.io/...:1.14.2` at every
   dot, manufacturing 19 junk items and depressing precision for reasons unrelated to the rules'
   judgement. A related `exec`-without-`g` bug hung the run outright.

## 6. Four-way diagnostic on the state classifier

The classifier is unchanged; the diagnostic is new instrumentation.

| Fixture | coverage | correctly classified | correctly abstained | incorrectly classified | incorrectly abstained |
| --- | ---: | ---: | ---: | ---: | ---: |
| F3 | 0.40 | 2 | 2 | **0** | **1** |
| F9 | 0.50 | 2 | 2 | **0** | 0 |

The number that matters is the last one. **Incorrectly classified is 0 on both fixtures** — the
system does not assert states it cannot support. **Incorrectly abstained is 1** — `nothing_deleted_early`,
whose truth is `superseded` and which reports `unknown`. That is the coverage failure with
consequence, and it is now counted separately from accuracy rather than hidden inside it.

## 7. What this does and does not unlock

**Unlocked:** the inventory now *represents* the four classes it was blind to, with measured recall
against a pre-registered oracle. The specific content whose absence made deletion and
second-occurrence edits undetectable — negative constraints, per-occurrence values — is now named.

**Not unlocked:** both pilots' gates are measured on **cards**, not items. A card requires a bank
question and a decision call; these rules produce items. So:

| Gate | Measured on | Status after this experiment |
| --- | --- | --- |
| H1 classification coverage ≥ 0.50 | cards | **unchanged: 0.40** |
| H2 anchored plant coverage ≥ 0.60 | cards | **unchanged: 0.40 / 0.25** |

The experiments remain gated. The step that would move them is generating cards from the new items —
one bank question per item class, then a decision call — and re-measuring both gates. That is a
separate, small piece of work, and it is the only remaining path to an interpretable pilot.

## 8. Limits

- **One reviewer.** Procedural independence only. A second adjudicator who has not seen the rules is
  required before any claim of general precision or recall.
- **Ten short synthetic fixtures.** No engineering corpus. Whether these rules hold on code — where
  identifiers repeat and negations are rarer — is untested.
- **The oracle is incomplete**, so measured precision is a lower bound and no upper bound is claimed.
- **Rules are lexical.** They find scope and prohibitions by marker words, not by parsing. They will
  miss constraints phrased without a marker and over-fire on descriptive uses of "not".
- F2a–F2d are unadjudicated and unscored.

## 9. Verification

```
node tools/inventory-coverage.js                     → exit 0, 31 required items scored
node tools/identity-states.js --fixture F3           → exit 0, coverage 0.40, confusion 2/2/0/1
node tools/identity-states.js --fixture F9           → exit 0, coverage 0.50, confusion 2/2/0/0
npm run selftest / selftest:decisions / selftest:inventory → 52/52, 40/40, 39/39
```

Artifacts: `runs/coverage/coverage.json`, `pilot/coverage/required-items.json`,
`runs/identity-states/v2/{F3,F9}.json`.
