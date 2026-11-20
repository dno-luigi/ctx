# D3-INSERTION-02 — expanded probe, and what A1′ must be

**Date:** 2026-11-18 · **Cost:** $0, no model calls.
**Subject:** D3 (occurrence identity). `ARA-SCHEMA-01.md` remains **frozen** at
`968a8142c2f86dd0fb330fc8b6ec2314666d3ef253fb0ae7df5fbf255e908d27` — not modified by this probe.
**Instrument:** `tools/d3-expanded-probe.js` — 11 edits × 5 strategies, 24 anchor-evaluations each.

**Result: the child of this probe is a rule, not a hash.** Both hash-based candidates either misattribute
silently (`content` 8, `ordinal` 6) or claim verification they cannot support (`context`). Only the
**identity/resolution split** returns 0 silent misattributions *and* reports `ambiguous` where the
evidence genuinely does not decide.

---

## 1. What was added, per your list

| Requirement | How it is covered |
| --- | --- |
| three or more identical occurrences | scene `three` (3 occurrences) + E8, which prepends a fourth |
| multiple adjacent edits | E10 edits the line above *and* the line below the anchor within ±1 |
| multi-line constructs | scene `block`, a 2-line quote duplicated above (E9) |
| false-flag measurement | flags classified per scenario in §3 |
| context collisions | scene `collision`: two occurrences with identical neighbours (E11) |
| identity ≠ resolution | strategy `refined`: `anchor_id` fixed at creation, `context_fingerprint` as evidence, `locator` mutable, `resolution_status` reported |

## 2. Results

| Strategy | verified_correct | **verified_wrong** | ambiguous | needs_reattribution |
| --- | ---: | ---: | ---: | ---: |
| `content` (shipped) | 15 | **8** | 0 | 0 |
| `ordinal` (schema as written) | 12 | **6** | 0 | 5 |
| `context` | 19 | 0 | 0 | 4 |
| `ordinal+context` | 15 | 0 | 0 | 8 |
| **`refined`** | **17** | **0** | **2** | **4** |

**`ordinal` gets worse with a third occurrence, not better.** At 2 occurrences it misattributed 3 of 12;
with a third it misattributes 6. The rank check compares the ordinal against *the position the resolver
chose*, so a wrong line that carries the right rank passes — E8 is the clearest case, where the anchor is
credited with a duplicate it never referred to.

**`content` is the worst of all** (8/24): it is right after a deletion — the locator moves with the text —
and wrong whenever a duplicate lands above, which is exactly the case the offset-shift success never
tested.

**`context` never misattributes here, and that is the trap.** In E11 the two occurrences have *identical*
neighbours. `context` reports **verified** for both; it happened to land on the right lines because the
nearest-locator tie-break pointed at them. It had no evidence to justify the claim — the report and the
epistemic situation disagree. The `refined` strategy returns **ambiguous** for the same two anchors. Same
outcome this time, different guarantee, and only one of them survives a case where nearest ≠ referent.

## 3. Flag ledger — false flags are the price of the safe rule

`refined` produced 4 flags and 2 ambiguity reports:

| Scenario | Anchor | Status | Verdict on the flag |
| --- | --- | --- | --- |
| E5 unrelated line deleted above | t1 | needs_reattribution | **false flag** — referent unchanged |
| E6 adjacent edit above | t1 | needs_reattribution | **false flag** |
| E10 edits above and below | t1 | needs_reattribution | **false flag** |
| E7 second occurrence revised | t2 | needs_reattribution | **correct** — identity genuinely gone |
| E11 context collision | c1, c2 | ambiguous | **correct** — evidence does not decide |

False-flag rate: **3 of 24 anchor-edits (12.5%)**, each costing one re-verification. Silent
misattribution rate for the alternatives: 33% (`content`) and 25% (`ordinal`). That is the trade you
specified, measured.

## 4. AC-5 and AC-6 re-run, units reported separately

| Check | Occurrences | Distinct quotes | Result |
| --- | ---: | ---: | --- |
| AC-5 synthetic fixture | 3 | 1 | 3 distinct ids, 3 distinct offsets resolved |
| AC-5 real corpus line (`tools/score-transcript.js`) | 3 | 1 | 3 distinct ids |
| AC-6 rename `locate` → `locateSpan` | 101 | 96 | **99/101** occurrences survive; **94/96** distinct quotes survive; 2 breaks, both symbol lines |

The two units differ by the five repeated quotes in `src/spans.js`. Quoting either number alone invites
misreading; both belong in the results vocabulary.

## 5. A1′ — the contract this probe supports

```
anchor_id            H(schema, source_id, normalized_quote, birth_context_fingerprint)
                     fixed at creation; never recomputed
context_fingerprint  evidence: the ±1-line window last verified for this anchor
locator              mutable candidate position, never identity
resolution_status    verified | ambiguous | needs_reattribution | unresolved
```

Resolution:

1. no occurrence of the quote → `unresolved`
2. exactly one occurrence whose context matches the fingerprint → `verified`
3. several match → `ambiguous`
4. none match → `needs_reattribution` (the neighbourhood changed, or this occurrence was revised — the
   resolver cannot tell which, and must not guess)

**Governing rule, now measured rather than asserted:** an anchor may move — E1, E2, E3, E4, E8 and E9 all
return `verified` for the right occurrence after insertions and a duplicated multi-line block — but it may
never silently change what it refers to. Only `verified` may be consumed by dependents; `ambiguous` and
`needs_reattribution` **block propagation** rather than degrading it.

## 6. What remains before A1′ becomes the contract

- **A collision case where nearest ≠ referent.** E11's collision happened to resolve correctly for
  `context`, so the demonstration that `context` can *silently* misattribute is structural, not
  constructed. Building that case is the next probe, and it is the one that would prove the split is
  necessary rather than merely tidy.
- **False-flag rate on real code** under sustained editing, where adjacent edits are constant. 12.5% on
  synthetic fixtures is not a forecast.
- **Collateral re-measure for AC-6 under A1′.** Context-based identity changes neighbouring anchors'
  fingerprints when a rename touches adjacent lines, so 2 breaks is a floor, not a promise.
- **Re-run the acceptance suite** against A1′ (it currently validates the ordinal rule, which this probe
  shows is unsafe).

## 7. Defects caught in the probe itself

1. **Context extraction read the newline.** The next line was taken from the newline that terminates the
   quote, yielding `''` for every fingerprint — which made all context strategies look like they never
   verified anything (`verified_correct=0`). Obvious in the totals, invisible per-scenario.
2. **Tag lookup scanned forward** (in the earlier probe) letting an inserted duplicate inherit a later
   marker and score `correct`. That one inverted a conclusion: `content` looked like 10/2 instead of 7/5.

Both are recorded because a probe that flatters a strategy is worse than no probe.

## 8. Gate

| Gate | Status |
| --- | --- |
| D3 has an empirical result | **yes**, two documents |
| A1′ safe enough to become the contract | **not yet** — §6 items open |
| `ARA-SCHEMA-01.md` amended | **no** — frozen at `968a8142…` |
| Implementation authorised | **no** |

## 9. Verification

```
node tools/d3-expanded-probe.js   → 11 edits × 5 strategies, totals in §2
node tools/d3-insertion-probe.js  → earlier 6-edit probe, unchanged
node tools/schema-acceptance.js   → 39/39 against the schema as written (ordinal rule)
node tools/freeze-verify.js       → 27/27 intact
```
