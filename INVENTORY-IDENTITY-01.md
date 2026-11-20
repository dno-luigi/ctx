# INVENTORY-IDENTITY-01 — can the inventory model what changed?

**Date:** 2026-11-18 · **Cost:** $0 (deterministic scan; no model calls).
**Scope:** the inventory identity experiment and the state-classification re-run. **No change was made to the
four state definitions, the 0.60 revision threshold, or the pilot's 0.50 gate.**

## 0. Baseline frozen first

`runs/frozen/pre-inventory-identity/` holds the pre-experiment artifacts with SHA-256 digests in
`manifest.json`: `F3.identity-states.json`, `F9.identity-states.json`, `card-id-experiment.json`,
`completeness.json`. Thresholds and classifier rules are recorded as unchanged and are not to be
revised retroactively. All v1 numbers remain quotable; the re-run writes to `runs/identity-states/v2/`.

## 1. Method

The same controlled edits, applied in sequence to F3 and F9, compared under three identity schemes:

| Strategy | Identifier |
| --- | --- |
| **S1 positional** | `inv_0001` by scan order — the current scheme |
| **S2 content** | `digest(kind, label, sorted normalised span quotes)` |
| **S3 content+occurrence** | S2 plus a per-span occurrence index, plus a revision registry |

F3 edits: E1 `30 days → 45 days`, E2 `revision 12 → 13`, E3 delete a clause. F9 edit: change the
**second** occurrence of the repeated offset line.

Five assertions, evaluated per transition. Where an assertion is genuinely untestable it is reported
`n/a` with a reason rather than as a pass — a vacuous "yes" would have manufactured two findings in
an earlier version of this tool, and both were caught before reporting.

## 2. Results

| Fixture | Strategy | a — edit creates distinguishable identity | b — prior identity traceable | c — deletion identifiable | d — unchanged retain identity | e — repeats not collapsed |
| --- | --- | --- | --- | --- | --- | --- |
| F3 | positional | **NO** | n/a | n/a | **NO** | yes |
| F3 | content | yes | yes | **NO** | yes | yes |
| F3 | content+occurrence | yes | yes | **NO** | yes | yes |
| F9 | positional | n/a | n/a | n/a | yes | yes |
| F9 | content | n/a | n/a | n/a | yes | yes |
| F9 | content+occurrence | n/a | n/a | n/a | yes | yes |

`n/a` reasons: F3 positional — no new identity was ever created, so there is nothing to trace; the
deleted text has no inventory item, so nothing can go missing. F9, all strategies — **no inventory
item covers the edited text**, so no identity could change.

## 3. Finding 1 — positional identity silently reassigns, and this is the strongest result here

Eight of F3's thirteen item identities survived two ordinary edits while describing different
evidence:

| Edit | Reassigned identifiers | What they describe |
| --- | --- | --- |
| E1 `30 days → 45 days` | `inv_0006`, `inv_0008`, `inv_0011`, `inv_0013` | `…days: 30 vs 90`, `…days: 90 vs 30`, two `customer event` links |
| E2 `revision 12 → 13` | `inv_0005`, `inv_0007`, `inv_0010`, `inv_0012` | `revision: 12 vs 4`, `4 vs 12`, two `data retention` links |
| E3 deletion | none | — |

**62% of identities were reused for changed content, with no signal available to any consumer.**
Under S2/S3 the same two edits produce 3 new + 3 retired + 3 linked identities per edit and **zero**
reassignment. That is the diagnosis confirmed: positional identity cannot expose in-place change.

## 4. Finding 2 — content addressing needs the registry to make "traceable" true

S2 alone creates the new identity but cannot say what it replaced; traceability (b) is only satisfied
because S3 records a one-to-one link at assembly. The first implementation linked three new
identities to a single predecessor and reported "traceable" — an artefact of greedy best-match
without exclusivity, now fixed to a greedy assignment by token overlap over the whole evidence text.
Ground truth: 3 new → 3 links, 0 missing, on both edits.

Content addressing also **merges two pairs of duplicate items** — `missing_connection` items 9/11 and
10/12 share identical evidence — reducing F3 from 13 items to 11. This is benign de-duplication and
it reveals that the inventory emits the same relationship twice. It is not a collapse of distinct
occurrences.

## 5. Finding 3 — deletion is invisible for a coverage reason, not an identity reason

The clause deleted by E3 has **no inventory item at all**: 0 retired, 0 missing, for every strategy.
Changing the identity scheme cannot expose it. This is the same blindness that makes F9's
`retry_duration` unanswerable — the instrument never named the content.

Consequence: assertion (c) cannot pass until the inventory covers plain prose. Assigning deletion
detection to the identity layer would be a category error.

## 6. Finding 4 — F9 cannot decide between strategies, and that is itself informative

F9's second-occurrence edit changes no identity under any scheme, because the inventory emits
**phrase-level items with no occurrence dimension**: one `committed offset` item, not one per
occurrence. There is therefore nothing for an occurrence index to distinguish, and nothing that can
collapse. The repeated-line problem the earlier run appeared to show was a measurement artefact of a
bad collapse detector; after fixing it, **no repeat collapse occurs anywhere**, because the inventory
never emits per-occurrence items in the first place.

Recorded as: S3's occurrence dimension is currently **unexercised**. It is not proven necessary, and
it is not proven useless.

## 7. State classification re-run — coverage and accuracy, separated

`unknown` now carries a reason code and every card records a basis.

| Fixture | coverage | unknown reasons | bases | accuracy over classified | affected-but-unknown |
| --- | ---: | --- | --- | ---: | ---: |
| F3 | **0.40** | `no_anchor` 3 | 2 in edit region, 3 unanchored | **2/2 = 1.000** | **1** |
| F9 | **0.50** | `no_anchor` 2 | 2 outside edit region, 2 unanchored | **2/2 = 1.000** | 0 |

The two axes say different things, exactly as you warned:

- **Accuracy is perfect where classification is attempted.** Both classified cards on each fixture are
  correct against the independently adjudicated expectation in `runs/identity-states/expected.json`,
  authored from the edits before the re-run.
- **Coverage is 40–50%**, and one F3 card is a real coverage failure: `nothing_deleted_early` has truth
  `superseded` (its clause was deleted) and the system reports `unknown`. Counted as
  `affected-but-unknown`, never folded into accuracy.
- **`wrongly_unknown` is 0 and `spurious_classification` is 0.** The system does not claim states it
  cannot support; it declines. That is the safer of the two failure modes and it is now measured
  separately.

The F9 bases are the useful diagnostic: its two classified cards are anchored **outside** the edit
region. That is the "anchor exists but does not cover the edited material" condition you listed,
recorded as a basis rather than buried in `unknown`.

## 8. Gate status

The pilot's declared stop rule is a 0.50 coverage floor. Measured coverage: **0.40 (F3), 0.50 (F9)**.
Mean is below 0.50.

**The pilot is still not runnable, and by the declared rule it must be reported as not run.** The
inventory identity work improves *what a change looks like*, not *how much the inventory sees*.

## 9. Recommendation

1. **Adopt content-addressed inventory identity with a revision registry.** The evidence for it is
   direct: 62% silent reassignment under positional identity versus zero under content addressing.
2. **Do not adopt the occurrence dimension yet.** It is unexercised by these fixtures. Adopt it when an
   inventory rule emits per-occurrence items — which is a precondition for detecting edits to a
   repeated line anyway.
3. **The blocker is coverage, not identity.** Two of the four remaining failures (`c` deletion, F9
   `a`) are caused by content the inventory never names. Raising coverage is the next experiment, and
   it is the only change that can move the 0.50 gate.

## 10. Limits

- Two fixtures, five edits, one engine. The positional-vs-content comparison is structural and should
  hold generally; the coverage figures are specific to these fixtures.
- The revision registry is a harness record, matching identities by token overlap. It is deterministic
  and inspectable, but it is a heuristic link, not a guaranteed lineage.
- Accuracy rests on nine adjudicated cards. Perfect accuracy on nine cards is not evidence of general
  accuracy; it is evidence that the classifier does not fabricate on this sample.
- `expected.json` was authored by the same analyst who declared the edits. Independent adjudication
  would require a second author, which this pilot does not have.

## 11. Verification

```
node tools/inventory-identity.js                                    → exit 0
node tools/identity-states.js --fixture F3                          → exit 0, coverage 0.40
node tools/identity-states.js --fixture F9                          → exit 0, coverage 0.50
npm run selftest / selftest:decisions / selftest:inventory          → 52/52, 40/40, 39/39
```

Artifacts: `runs/inventory-identity/experiment.json`, `runs/identity-states/v2/{F3,F9}.json`,
`runs/identity-states/expected.json`, `runs/frozen/pre-inventory-identity/manifest.json`.
