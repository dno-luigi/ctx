# CARD-ID-01 — deterministic card identity as the substrate for reuse

**Date:** 2026-11-18 · **Cost:** 3 paid calls, **$0.00037239** (three F2b–F2d snapshots needed for the
cross-fixture measurement). Everything else is recomputed from recorded runs at zero cost.
Cumulative: **$0.02701 over 109 paid assessments**.

**Hypothesis tested:** deterministic card identity plus explicit provenance makes knowledge reusable
across assessments, engines, fixtures and systems, so later onboarding compounds instead of each
system restarting.

**Answer: the identity layer works and is now built; compounding does not follow from it.** Reuse is
real but strictly conditional on the two assessments already agreeing and the two sources already
being related. Coverage did not move at all.

---

## What was added

`cards/identity.js` — three separate things, deliberately not conflated:

| Object | Derived from | Property |
| --- | --- | --- |
| **anchor id** | `digest(source_id, normalised quote)` | content-addressed: survives an offset shift, breaks when the language changes |
| **locator** | `{source_id, start, end}` recorded at assembly | an attribute, not part of identity — offsets go stale the moment anyone edits above them |
| **card id** | `digest(normalised claim, sorted anchor ids)` | two assessments asserting the same thing about the same evidence get the same id, whatever engine, run or repetition produced them |

Probabilities, confidence, model name, run id and timestamp are **excluded** from the card id. A card
is what it asserts and what it is anchored to.

As you recommended, **identity is assigned by assembly, never by a model**. Anchors come from matching
operator-authored bank text against the deterministic scan — both outside the model. Models propose
answers; the records establish what a card is. This is enforced structurally: `cardId()` has no model
input and `anchorsForQuestion()` has no model output in scope.

Resolution is *locator-as-handle, quote-as-verification*, in that order:

```
same_offset    the text at the stored locator still equals the quote
relocated      the quote occurs exactly once elsewhere (text was prepended)
disambiguated  the quote repeats; the occurrence nearest the stored locator wins
```

That ordering was forced by a measurement failure, and the failure is the finding: **quote-only
resolution does not work on repeated text.** F9 repeats its log line by construction, so the frozen
verifier correctly refuses three of its four anchors as `ambiguous_quote`. Identity has to carry its
own locator to be resolvable.

## 1. ID resolution — **yes**

20 distinct anchors across six fixtures (207 cards). Every one re-resolves, before and after a global
offset shift that invalidates every stored offset:

| Fixture | anchors | resolve as recorded | after offset shift | ids stable | revision breaks identity |
| --- | ---: | ---: | ---: | --- | --- |
| F9 | 4 | 4/4 `same_offset` | 4/4 (1 relocated, 3 disambiguated) | yes | **yes** |
| F3 | 4 | 4/4 `same_offset` | 4/4 (4 relocated) | yes | **yes** |
| F2a | 3 | 3/3 `same_offset` | 3/3 (2 relocated, 1 disambiguated) | yes | inconclusive |
| F2b–F2d | 3 each | 3/3 `same_offset` | 3/3 (2 relocated, 1 disambiguated) | yes | inconclusive |

**Identity survives editing; locators do not, and recover.** On F9 the disambiguation path is the one
that matters: three of four anchors moved and repeated, and all three still resolved to the correct
occurrence because the old locator was retained as the tie-breaker.

**Revision sensitivity** is demonstrated where the anchor is a sentence: revising F9's offset line and
F3's retention sentence destroys those identities and nothing else (F9 collateral 1, F3 collateral 3 —
both are other anchors that shared the revised language, which is correct). For F2a–F2d the test is
**inconclusive, not negative**: the anchor there is a short key (`a-17`) that still occurs inside the
revised string, so the identity legitimately persists. A cleaner test needs a sentence-length anchor
per fixture.

**The cost, stated plainly: 50–60% of cards cannot be anchored at all** (F9 30/60, F3 45/75,
F2a 15/60). Not because anchoring failed, but because the bank question names nothing the inventory
emits:

| Fixture | question | anchors | why |
| --- | --- | ---: | --- |
| F9 | `offset_value` | 4 | names "consumer group", "ingest-a", "committed offset" |
| F9 | `retry_duration` | **0** | unique numeric fact — no inventory item exists |
| F9 | `batch_written_once` | **0** | asks about an absence; nothing to name |
| F3 | `retention_30` / `retention_90` | 4 each | names "customer event logs" |
| F3 | `documents_agree` / `governing_document` / `nothing_deleted_early` | **0** | relational or absence question — no entity key in the claim |
| F2a | `export_window_days` / `export_destination` / `a17_governs` | 3 each | names "A-17", "audit trail" |
| F2a | `deadline_from_quarter_close` | **0** | no inventory key matches |

This is the same blindness recorded in PRIORITY-TESTS-01 for Q2, now **visible and countable** instead
of invisible. The ID layer does not fix inventory blindness; it makes it auditable. That is a real
improvement over the wording matcher, which could not distinguish "not covered" from "could not be
matched".

## 2. Cross-card reuse — **yes, and exactly as strong as answer agreement**

207 cards collapse to **25 distinct card ids**:

| Fixture | cards | distinct ids | cards per id | ids in ≥2 engines |
| --- | ---: | ---: | ---: | ---: |
| F9 | 60 | 4 | 15 | 4 (all) |
| F3 | 75 | 5 | 15 | 5 (all) |
| F2a | 60 | 4 | 15 | 4 (all) |
| F2b / F2c / F2d | 4 each | 4 each | 1 | n/a (single engine) |

Cross-fixture, on the F2 variants (same content, different framing):

| pair | shared ids | Jaccard |
| --- | ---: | ---: |
| F2a ~ F2b | 4/4 | **1.000** |
| F2a ~ F2c | 4/4 | **1.000** |
| F2a ~ F2d | 1/4 | 0.143 |

Identity reuse is perfect where the answers agree and collapses where they do not. **Identity does not
create agreement; it makes existing agreement recognisable and cheap to detect.** F2d is the useful
counter-example: a perturbed variant whose answers differ, where identity reuse correctly drops to
one shared card rather than pretending similarity.

One consequence worth recording: because confidence is excluded from the id, two cards asserting the
same thing at 0.49 and 0.72 are *the same card*. That is right for reuse and wrong for tracking
confidence drift — the stability analysis in LIVE-RUN-01 §6 found confidence moves while claims do
not. Identity should stay confidence-blind; confidence belongs in the record beside the id.

## 3. Onboarding marginal cost — **conditional, and negligible at this scale**

| Fixture | anchors | already known from another fixture | reuse | potential saving |
| --- | ---: | ---: | ---: | ---: |
| F9 | 4 | **0** | 0% | $0 |
| F3 | 4 | **0** | 0% | $0 |
| F2a | 3 | 3 | 100% | $0.00007446 |
| F2b | 3 | 3 | 100% | $0.00007446 |
| F2c | 3 | 3 | 100% | $0.00007446 |
| F2d | 3 | 2 | 67% | $0.00004964 |

**Two unrelated documents share no anchors at all.** Onboarding a genuinely new source inherits
nothing: the marginal cost is the full cost. Reuse appears only between re-framings of the same
content, where it is 60% of the assessment — but that is also the case where you already had the
answers.

The saving is also stated at a measured per-question price ($0.00002483 on flash at F2a's scale), and
it is *potential*: nothing here skipped a question. A realised saving needs an answer cache keyed by
`(question_id, anchor set, source digest)` — and the source digest is precisely what changes when a
source is onboarded, so the cache helps only when the evidence is identical, not merely similar.

## 4. Cross-system transfer — **precondition met, transfer itself unproven**

Engine identity agreement is **1.000 on every multi-engine fixture**: all four engines, asserting the
same things about the same evidence, produce byte-identical card ids. That is the precondition for
transfer — a card store written by one engine is readable by another without translation.

But the measured transfer results on record are claim-scoped, not knowledge-scoped:

- delta questions against another engine's cards: **6/6 across two fixtures and four engines**
- held-out substitution: **1/6 to 2/8 genuine retention**

So a card set transfers as *answers to the questions that were asked*, not as a body of knowledge that
answers new questions. No ARA or AA exists in this repository, so the cross-system half of the
hypothesis is untested rather than refuted.

## Coverage: does adding cards add coverage? — **no, and the inventory is why**

F3, 11 assertion items in the denominator:

| card set | cards | anchored assertion items | coverage |
| --- | ---: | ---: | ---: |
| pass-1 bank | 5 | 3 | 0.273 |
| plus held-out bank | 10 | **3** | **0.273** |

Five additional cards covering exports, automatic deletion, revisions, scope and ownership added
**zero anchored coverage**. Three of those five could not be anchored at all — the inventory emits no
item for what they assert — and the other two re-anchored items already covered.

This is the Q1 finding again, with a better instrument: **coverage is bounded by the inventory, not by
card count.** More cards cannot cover what the instrument cannot name.

---

## Verdict on compounding

| Layer | Established? | Evidence |
| --- | --- | --- |
| Stable identity across engines, runs, repetitions and fixtures | **yes** | 25 ids for 207 cards; engine agreement 1.000; ids survive a global offset shift |
| Identity that survives editing and breaks on revision | **yes**, for sentence-length anchors | 8/8 anchored sentences re-resolved after editing; 2/2 revised sentences lost identity |
| Reuse across assessments | **yes, conditional on agreement** | F2a~F2b 1.000, F2a~F2d 0.143 |
| Declining onboarding cost | **only between near-identical sources** | 0% between unrelated sources, 60% between re-framings |
| Coverage growth from added cards | **no** | 0.273 → 0.273 with five added cards |
| Cross-system transfer of knowledge | **unproven** | identity agreement 1.000, but transfer stays claim-scoped |

Reuse here is **multiplicative in detection and additive in value**: identity lets you recognise the
same card instantly and for free, but it does not make the next source cheaper unless the next source
is the same source. Exponential returns would need each onboarding to shrink the next one's work; the
measured shrink is 0% across different documents.

The three conditions you set for reuse to compound are the ones that fail, and they fail in order:

1. **Accurate** — partially: 50–60% of cards have no anchor, so their relationships are absent rather
   than inaccurate.
2. **Reusable** — yes, provably, whenever answers agree.
3. **Independently verifiable** — yes for the 20 anchors that resolve; the rest are unverifiable
   because there is nothing to verify against.

The binding constraint is the same one PRIORITY-TESTS-01 found: **the inventory decides what can be
identified, and identification is what reuse is built on.** That is the thing to fix before ARA or AA
is locked down — expanding the inventory until anchoring does not fail on plain facts, absences and
relational questions. Anchoring a card to nothing now fails visibly, which means the fix is
measurable: drive the unanchored rate down and watch whether onboarding reuse rises with it.

## Verification

```
node tools/card-id-experiment.js        → exit 0, runs/card-id/experiment.json
npm run selftest                        → 52/52, exit 0
npm run selftest:decisions              → 40/40, exit 0
npm run selftest:inventory              → 39/39, exit 0
```

## Limits

- No ARA or AA exists, so the cross-system metrics are measured at the identity and decision level.
- F2a–F2d are variants of one source, so their reuse is an upper bound, not a typical case.
- Anchor matching requires every exposed entity key to appear in the bank claim. Relaxing that would
  raise the anchored rate and lower precision; it was not tuned, because the failure pattern is the
  result.
- Revision sensitivity is unproven on short-key anchors, as recorded above.
- The answer cache that would realise onboarding savings was not built.
