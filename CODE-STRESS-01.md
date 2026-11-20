# CODE-STRESS-01 — does the information model survive real code?

**Date:** 2026-11-18 · **Cost:** $0, **0 model calls** · Deterministic probes over six real source files.
**Constraint honoured:** no core-engine change, no frozen artifact touched
(`node tools/freeze-verify.js` → 27/27 intact), read-only corpus.

**Question:** before an ARA schema turns the information model's assumptions into tables, which of them
actually hold on code?

**Short answer:** content-addressed identity **holds** under a real rename and keeps retrieval correct;
the **constraint class does not transfer** to code at all; and **relationship edges — the thing RDA
propagates over — are not captured**, so the update algebra is sound but starved.

---

## 1. Probe A — identity under identifier/line repetition

My prediction was that repeated lines would make content addressing collapse badly. **It did not
collapse badly**, and the measured number is the useful one:

| File | lines | share an identity with another line | worst repeated line |
| --- | ---: | ---: | ---: |
| `cards/identity.js` | 128 | 2 (1.6%) | 2× |
| `inventory/rules-coverage.js` | 107 | 4 (3.7%) | 4× |
| `tools/usage-capture.js` | 79 | 0 | — |
| `tools/score-transcript.js` | 164 | **23 (14.0%)** | 3× |
| `tools/blind-packet.js` | 86 | 2 (2.3%) | 2× |
| `src/spans.js` | 101 | 10 (9.9%) | 2× |
| **total** | **665** | **41 (6.2%)** | |

For every colliding quote there is exactly **one** anchor id and several occurrences — that is how
`anchorId` is defined. The important question is whether that breaks anything downstream, and it does not:

- **retrieval survives.** In all **5 of 5** files with a repeated line, two distinct occurrences
  carrying the *same* anchor id still resolve to their own correct offsets, because `resolveAnchor`
  uses the stored locator as handle and the quote as verification (modes `same_offset` /
  `relocated` / `disambiguated`).
- **attribution does not.** Two records with the same `claim_id` on different occurrences are
  indistinguishable by identity alone. At 6.2% of lines here and 14% in one file, lineage — "which
  occurrence changed?" — has a measured blind spot, not a hypothetical one.

**So the finding is narrower and more useful than the prediction:** content addressing is right for
*claims* and insufficient for *occurrences*. Prose rarely repeats a sentence; code repeats lines
constantly. This is a schema requirement, not a redesign.

## 2. Probe B — constraints in code: the headline failure

Twelve guards, refusals, limits and provenance rules were listed from the source **before** the rules
ran (`pilot/code/constraints-oracle.json`).

| Measure | Result |
| --- | --- |
| constraint lines touched by *any* inventory item | **9 / 12 (0.75)** |
| constraint lines found by the **constraint class** | **0 / 12 (0.00)** |
| misses | K4 anchor limit, K6 filter guard, K10 `Number.isFinite` validation |
| `structural_constraint` items emitted on the corpus | 41 — **none** on a guard line |

All nine "hits" came from `explicit_fact`, because the guard lines happen to contain numbers
(`>= 4`, `0.6`, `!== null`). The rule matched the digits, not the constraint. The 41 constraint items it
did emit are prose in comments ("never by a model", "never repaired") — genuine constraints, but in
English, not in the code's own control flow.

**This is the F9 pattern again, in code:** a line-overlap metric reports **0.75** while the class the
metric is supposed to measure captures **nothing**. If ARA reports "constraint coverage 75% on this
repository" from an overlap metric, that number is an artifact of numbers appearing in guard
expressions. The class is 0.00 and must be reported as 0.00.

## 3. Probe C — relationships: the edges are missing

The corpus contains **1** intra-corpus import edge (`cards/identity.js → src/spans.js`). The inventory
recorded **0 of 1** import statements as any kind of item; the 3 relationship items it emitted on the
whole corpus are prose ("superseded by", "depends on") in comments.

With n = 1 this is not a rate and is not reported as one. The mechanism is the finding: `RELATION`'s
vocabulary is prose (`owner`, `governs`, `superseded by`), and `import … from './x.js'` contains none of
it. Code dependencies have to come from a code analyzer, not from these rules.

That matters because **RDA propagates over edges**. The algebra propagated 3/3 deltas with zero silent
losses — but only over edges someone declared. On code, the model supplies none.

## 4. Probe D — differential update under a real rename

`src/spans.js`: rename `locate` → `locateSpan` (a symbol with a real cross-file dependent).

| Measure | Result |
| --- | ---: |
| anchors before / surviving | 96 / **94 (0.979)** |
| anchors broken | 2 |
| breaks that mention the renamed symbol | **2 / 2** |
| textual dependents elsewhere in the corpus | 2 (`cards/identity.js`) |
| edges the *model* recorded for this file | **0** |
| edges a mechanical import scan finds | 1 |

Content addressing behaved exactly as designed: the rename broke precisely the two lines containing the
symbol, nothing else. That is the strongest positive result here — identity is precision-preserving under
real revision, at file scale.

But the update cannot *use* that precision: the dependent in `cards/identity.js` is discoverable
textually and mechanically, and invisible to the information model. A differential update would break
the importer and have nothing to traverse.

## 5. What this changes in INFORMATION-MODEL-01

Three amendments, all evidence-driven, none of them a redesign:

| # | Amendment | Evidence |
| --- | --- | --- |
| **A1** | `anchor_id` gains an **occurrence ordinal** (or the record carries `occurrence` beside a content id) for quotes that repeat in a source; retrieval keeps locator-as-handle | 41/665 lines share an identity; 14% worst file; all 5 colliding files still resolve correctly, so this is attribution, not retrieval |
| **A2** | Coverage is **per domain with a domain-specific naming instrument**; a prose constraint rule may not be credited on code. Report class-level recall (0.00 here), never line-overlap (0.75). | 9/12 touched vs 0/12 classified |
| **A3** | `edge_source` is a **declared field per domain**; for code it must be an analyzer, and a scope with no edge source reports `edges: unknown`, never `0` | 0/1 imports recorded; 2 real dependents invisible; RDA cannot traverse what was never recorded |

A3 is the one with architectural weight: it says the shared update algebra is domain-neutral but its
**input** is not, and the model must name where edges come from or refuse to claim propagation.

## 6. What this does not establish

- **Six files, one repository, one reviewer.** Some corpus files were written by the same reviewer who
  wrote the oracle; independence is weak and stated in `pilot/code/corpus.json`.
- **n = 1 on imports.** The import probe shows the mechanism, not a rate.
- **Line granularity only.** Anchors in production are inventory-item spans, not lines; the 6.2% figure
  is an upper-bound-by-granularity estimate, not a corpus statistic.
- **No model was involved.** Every probe is lexical and deterministic. A model-based constraint extractor
  might do better on code — that is exactly the untested option A2 points at, and testing it would cost
  money and belongs in the next phase's budget, not in this one.

## 7. Verdict on the sequence

The ordering was right. Written first, an ARA schema would now contain: positional or occurrence-blind
anchor identity, a prose constraint rule credited with code coverage, and a dependency table fed by
`RELATION` regexes — all three of which this probe shows to be wrong, and each of which would have been
expensive to remove after tables and migrations existed.

The model is **partially validated for code**: identity (yes, with A1), lifecycle (yes), update algebra
(unchanged), constraint extraction (no — 0.00), relationship extraction (no — 0 edges).

## 8. Verification

```
node tools/code-stress.js          → exit 0, runs/code-stress/report.json
node tools/freeze-verify.js        → 27/27 artifacts match, freeze intact
npm run selftest                   → 52/52
```

Artifacts: `pilot/code/corpus.json`, `pilot/code/constraints-oracle.json` (authored before the rules ran),
`runs/code-stress/report.json`.
