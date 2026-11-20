# CARD-GEN-01 — does inventory recall survive conversion into anchored, recoverable state?

**Date:** 2026-11-18 · **Cost:** 4 runs × 64 questions ≈ **$0.00018** (provider-reported).
Cumulative: **≈ $0.0272 over 145 paid question-decisions.**

This is the stage between "the inventory sees 96.8% of the adjudicated requirements" and "the pilots'
gates move". It is measured as a pipeline, so a high inventory number cannot hide a loss downstream.

## 1. The three controls

**Oracle preserved.** `pilot/coverage/required-items.json` was only read. Its digest is recorded:
`7c7913b1cf933cca…`. Questions are generated from **inventory items**, not from the required list, so
the question stage can lose something. Nothing in the oracle was revised.

**Conversion loss tracked.** Six stages, counted per required item.

**Gates independent.** H1 and H2 measured separately, thresholds untouched (0.50 and 0.60), no
combined verdict, and a card useful for change detection is not assumed sufficient for recovery.

## 2. Conversion

| Stage | Count | Rate |
| --- | ---: | ---: |
| Required items (immutable oracle) | 31 | 100% |
| **S1** oracle → inventory item overlaps the adjudicated span | 30 | 96.8% |
| **S2** inventory → question exists | 30 | 96.8% |
| **S3** question → decision returned | 30 | 96.8% |
| **S4** decision → card states the requirement | 30 | 96.8% |
| **S5** card → anchored on the required span | 30 | 96.8% |
| **S6** card → classifiable (has an anchor) | 30 | 96.8% |

**Nothing was lost after the inventory stage.** Every detected requirement became a question, got a
decision, produced a card stating it, and carried an anchor on the required span. The single loss is
the inventory's: "backfills it in **two** batches" (F6b) writes a quantity as a word, and the value
rule matches digits only.

That is the answer to the question you posed: the information survives conversion, on this sample.
The failure remains upstream, in what the inventory names.

**Emission gate.** Cards are emitted when the engine's own probability for the item's verbatim
statement clears 0.5. On F3 all six items scored between 0.987 and 0.995; no item was suppressed
anywhere in the ten fixtures. Unsupported items would have been retained as `unknown`, never dropped —
none occurred.

**A design correction worth recording.** A `noul` answer is a **probability, not text** —
`{type:'noul', noul: 0.953}`. The card claim therefore has to be the inventory item's own verbatim
quote, supplied by the record, with the model judging only whether the source supports it. The first
run asked the model to "state exactly what the source specifies", which is not a proposition; it
returned confidences and produced zero cards. This is the adapter contract working as designed and my
question shape being wrong, not a model failure.

## 3. H1 — classification coverage (threshold 0.50)

Same five and four original bank questions for F3 and F9, anchored against the extended inventory.
The matcher reproduces the previously measured baselines exactly (0.40 and 0.50), which is why the
delta is credible.

| Fixture | baseline | extended | still unanchored |
| --- | ---: | ---: | --- |
| F3 | 0.40 | **0.60** | `documents_agree`, `governing_document` |
| F9 | 0.50 | **1.00** | none |

Mean 0.80 against a 0.50 floor. **H1's gate passes.**

The two remaining gaps are structural, not incidental: both ask a *relational* question ("do the
documents agree", "which governs") and carry no entity content the inventory can anchor. A relational
question needs a relational anchor, which is the next inventory gap rather than an identity problem.

## 4. H2 — anchored plant coverage (threshold 0.60)

Planted constraints scored against the generated anchored cards:

| Fixture | before generation | after generation |
| --- | ---: | ---: |
| F3 | 0.40 | **0.80** |
| F9 | 0.25 | **0.75** |

Mean 0.775 against a 0.60 floor. **H2's gate passes.**

The two failures are honest and different from each other:

- **F3 P4 (0.57)** — the plant bundles both documents' revisions ("handbook at 12 and playbook at 4")
  while the cards are one header each. A granularity mismatch: the state is present in two cards and
  absent from any single one. A recovery pack would need to compose them.
- **F9 P4 (0.43)** — "the retry happened at 03:19 on the same day as the original write" against the
  card "03:19 retry of batch 512 completed after 7 seconds". The fact is there; the wording differs.
  A lexical matcher under-counts it, and a semantic one might not.

**The gates were not made to agree.** H1 reaches 1.00 on F9 while H2 reaches 0.75 on the same fixture,
and H2 fails two plants that H1's question set does not ask about — which is exactly the independence
you asked to preserve.

## 5. Measurement bugs caught before reporting

Four, each of which would have produced a wrong conclusion:

1. **`noul` returns a probability.** Asking for free text produced zero cards, which read as
   "conversion loses everything" and was a question-design error.
2. **Digits were dropped by the token filter** (`length >= 4`), making "retained for 30 days" and
   "retained for 90 days" indistinguishable. F3's H2 read 0.40 when the correct card was present.
3. **The H2 matcher was reversed** — it asked whether the plant was inside the card using the card as
   the denominator, so a card longer than its own subject scored 0.55 and was counted absent. Corrected
   to the project's own convention: plant tokens found in the card.
4. **H1 anchoring included the question's instructions**, which let "do the two documents agree on the
   retention period" match a retention fact on the word "retention" and produced a false 1.000. Anchors
   now come from the claim alone.

## 6. What this does and does not establish

**Establishes:** with the coverage rules added, both pilots' gates clear their declared thresholds;
information survives card generation without further loss; every required item that becomes a card is
anchored to its source span; and the two gates behave independently.

**Does not establish:** that either pilot will produce a positive result. The gates are preconditions,
not outcomes. H1 still requires agent runs on the five repository changes; H2 still requires the
planted-state file, checkpoints and 60 agent runs. Neither set of frozen inputs exists yet.

**Also does not establish** that these numbers transfer to code. Ten short synthetic documents and one
engine; the engineering task will have different lexical structure, more repetition and more
identifiers.

## 7. Limits

- Ten short fixtures, one engine (`pplx-decider-flash-v1.2`), one reviewer for the oracle.
- Every matcher here is lexical and declared; the two H2 failures are exactly where lexical matching
  is weakest.
- H1's coverage is measured on the original bank's card set anchored against the extended inventory;
  it is a card-level property, not an agent outcome.
- The 30/31 conversion figure is bounded by an oracle that is known to be incomplete, in both
  directions.

## 8. Verification

```
node tools/card-generation.js --dry           → exit 0, 64 questions, worst case $0.000134
node tools/card-generation.js                 → exit 0, spend $0.00004608
npm run selftest / selftest:decisions / selftest:inventory → 52/52, 40/40, 39/39
```

Artifacts: `runs/cardgen/perplexity_pplx-decider-flash-v1.2/{F1,F3,F5,F6b,F6d,F6e,F6f,F7,F8,F9}.json`
and `summary.json` in the same directory.
