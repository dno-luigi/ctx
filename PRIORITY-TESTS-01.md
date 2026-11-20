# PRIORITY-TESTS-01 — the three questions, tested

**Date:** 2026-11-18 · **Cost:** 17 paid calls, **$0.00054108**. Cumulative spend across all work:
$0.02664 over 106 paid assessments.

The three questions were asked in priority order, and each was given an instrument that could
return "no":

| # | Question | Instrument | Verdict |
| --- | --- | --- | --- |
| 1 | Does a neutral inventory provide a reliable denominator for snapshot completeness? | `tools/completeness.js` | **No** |
| 2 | Can GCA identify what was omitted, rather than merely assess what was retained? | `tools/completeness.js` (omission section) | **No, not on this path** |
| 3 | Can RDA propagate changes without silently losing unaffected information or introducing unsupported conclusions? | `tools/rda-propagation.js` | **Yes on this sample**, with one divergence |

Replication was run alongside, as instructed: F3 **and** F9, each with two engines
(`pplx-decider-flash-v1.2` and `scaledown/classify-1`).

---

## Q1 — the inventory as a completeness denominator: **no**

Three independent failures, each sufficient on its own.

**1. It reports 100% completeness on a snapshot it cannot see through.** On F9 the inventory's
assertion denominator is 3 relationship items, all three of which a card matches — ratio **1.000**.
Yet the inventory emits **nothing at all** overlapping either human-adjudicated required span:
its items sit on the first log line ("consumer group", "committed offset"), while the required
regions are on the second occurrence. The same data scored by two mechanical matchers:

| Fixture | required | blind | covered via inventory | covered direct |
| --- | ---: | ---: | ---: | ---: |
| F3 | 2 | 0 | 2 | 2 |
| F9 | 2 | **2** | **0** | **2** |
| F2a | 1 | 0 | 1 | 1 |
| **total** | **5** | **2** | **3** | **5** |

Two equally mechanical rules — one going through the inventory, one comparing card wording to the
required wording — differ on **2 of 5** items, in opposite directions on the same snapshot. A ratio
that moves from 0.6 to 1.0 depending on the matcher is not a denominator.

**2. The ratio does not respond to real added content.** F3's denominator is 11 assertion items and
the 5-card snapshot covers 4 (**0.364**). A second pass over the same fixture with a held-out bank
added **5 more cards** covering genuinely different content (exports, automatic deletion, revisions,
scope, ownership). Ratio: **0.364 — unchanged.** The metric is not measuring "how much of the
corpus the snapshot accounts for"; it is measuring string agreement between card claims and item
labels, and the new cards use different strings.

**3. The denominator inherits every inventory blind spot.** F6b's key–value record (0/3 required),
F9's unique numeric fact, and any prose that repeats nowhere produce no assertion items, so those
fixtures have a denominator of zero or a denominator made of the wrong things. A zero denominator is
reported as `vacuous`, never as completeness 1.0 — but `vacuous` is not a usable answer either.

What survives: **reproducibility**. Every span re-derives byte-exact on every fixture (LIVE-RUN-01
§7), so the instrument is stable. Stability was never the problem; **validity** is.

## Q2 — identify what was omitted: **no, not on this path**

The harness can produce an omission list, and it does — 7 unmatched assertion items on F3, 34 on
F2a. But omission detection is bounded by the same instrument that defines the denominator, so:

- **0 omissions were both real and detected** across three fixtures. The one place the answer key
  and the inventory disagree (F9) is precisely where the inventory emits nothing — the omitted
  region has no item to flag it as omitted.
- The omissions it *does* list are dominated by inventory items no answer key corroborates, so the
  list cannot be read as an omission report without human adjudication of every entry.

The mechanism is simple and worth stating plainly: **you can only flag the absence of something you
were able to name.** The inventory names entities, repeated phrases and dependency cues. It does not
name key–value fields, unique numeric facts, or one-off prose. Those are exactly the regions where a
bank-scoped snapshot omits content, so the omission detector is blind at the omission sites.

GCA as implemented therefore does what the earlier critique said it does: it scores **retention** of
what the bank asked about. It does not yet enumerate omission.

## Q3 — RDA propagation: **yes on this sample**, one divergence

Two arms per configuration, same engine, same amendment:

- **A. full source + amendment** (reference)
- **B. snapshot + amendment** (propagation)

Each arm answered the original bank (did facts survive?) and the delta bank (did the change land?).

| Fixture | Engine | preserved | silent loss | stale | delta agreement |
| --- | --- | ---: | ---: | ---: | ---: |
| F3 | flash | 5/5 | 0 | 0 | 3/3 |
| F3 | classify-1 | 4/5 | **0** | **1** | 3/3 |
| F9 | flash | 4/4 | 0 | 0 | 3/3 |
| F9 | classify-1 | 4/4 | 0 | 0 | 3/3 |

**No silent loss in any configuration** — nothing the amendment left untouched was dropped. The
change itself landed **3/3 in all four** configurations, including the withdrawal of the playbook's
longer window and the 9-second retry.

The single divergence is informative rather than fatal: on F3, `classify-1` reclassified
`governing_document` from "neither is identified as governing" to "platform handbook" when given the
full source plus the 45-day directive, while the snapshot arm kept the pre-change answer. That is a
genuine propagation difference on the one original-bank question this amendment actually touches.
The other four original-bank questions ask what the documents *state*, and an overriding directive
does not change what the documents state, so "preserved" is the correct answer for them — which
means this test's sensitivity is one question wide, and it should be read that way.

**No cost saving at this scale**: the snapshot arm was *more* expensive in all four configurations
($0.00000861 vs $0.00000827 on F3/flash; $0.00013544 vs $0.00013 on F3/classify-1), because a
504-character rendering is larger than F3's 402-character source — the same `≈180 chars per card`
of rendering overhead recorded in LIVE-RUN-01 §14.

---

## Component diagnosis

The tests did not all succeed, so there is **no evidence yet for a scalable contextual
architecture**. The useful result is *where* the failure sits.

| Component | Verdict from this work | Evidence |
| --- | --- | --- |
| **Assessment model** | **not the limiter** | 42/42 decisions identical across five repetitions; 6/6 delta questions across two fixtures and four engines; 15/16 facts preserved through propagation; 16/16 delta agreement in RDA |
| **Inventory** | **limiting** | blind to key–value records (F6b 0/3), unique numeric facts (F9), and non-repeated prose; yield insensitive to context size (F2a–F2d all 66 items); 12.8 items per required item with precision unmeasured |
| **Snapshot representation** | **limiting, and first in the chain** | cards carry no citations, so nothing can be anchored: completeness matching is lexical, omission has no span to be absent from, and two mechanical matchers disagree on 2 of 5 required items |

The ordering matters. Even a perfect inventory would not fix completeness on this path, because a
card with no citation cannot be matched to an inventory item except by wording — and wording is
where the 0.6-vs-1.0 disagreement came from. Conversely, citations alone would not make the
inventory adequate: the blind spots are real. **Both** the representation and the inventory need
work, and the representation comes first.

Two things follow, and they are cheap:

1. **Evidence must come back into the representation.** Every engine in this cohort refuses `box`
   and has no `locate` discriminator, so span-level citation is impossible on this cohort. Either a
   model that serves text spans is added, or the harness anchors cards to *inventory item ids* at
   assembly time — which is computable offline, deterministic, and does not need a model.
2. **The inventory must cover records and numbers.** A key–value rule and a numeric-fact rule would
   close F6b's 0/3 and F9's unique-number gap — the two fixtures where omission is currently
   invisible.

Neither change touches the frozen graders, the thresholds, or the decision path.

---

## Verification

```
node tools/completeness.js --fixtures F3,F9,F2a --model perplexity/pplx-decider-flash-v1.2 \
  --broad runs/live/broad                                        → exit 0
node tools/rda-propagation.js --fixtures F3,F9 \
  --models perplexity/pplx-decider-flash-v1.2,scaledown/classify-1 → exit 0, 16 calls
npm run selftest           → 52/52, exit 0 (unchanged)
npm run selftest:decisions → 40/40, exit 0 (unchanged)
npm run selftest:inventory → 39/39, exit 0 (unchanged)
```

Records: `runs/completeness/completeness.json`, `runs/live/rda/propagation.json`, and the held-out
snapshot used for the responsiveness check in `runs/live/broad/`.

## Limits

- Five required items across three fixtures is a small adjudication set; the matcher disagreement is
  demonstrated, not estimated.
- The propagation test is one amendment per fixture, both synthetic, and its sensitivity is one
  original-bank question wide on F3 and zero wide on F9 (the F9 amendment changes a fact the bank
  does ask about, so it is measured through the delta bank, not through preservation).
- Completeness matching is lexical by necessity. The numbers above are properties of declared
  matchers, and that is the finding — not a workaround for it.
