# D3-INSERTION-03 — the two finalization probes

**Date:** 2026-11-18 · **Cost:** $0, no model calls.
**Subject:** D3 / A1′ (occurrence identity). `ARA-SCHEMA-01.md` remains **frozen** at
`968a8142c2f86dd0fb330fc8b6ec2314666d3ef253fb0ae7df5fbf255e908d27` — unchanged.
**Instruments:** `tools/d3-expanded-probe.js` (E12 added), `tools/ac6-refined.js`.

**Result: both probes support finalizing A1′, with one measured cost — verification of lines adjacent
to a revision, not correctness.**

---

## 1. Structural collision proof (E12)

E11 showed a collision that plain context survived *by luck*. E12 removes the luck: two occurrences
share an identical neighbour pair (`alpha` above, `ctx same` below), and a **third twin is inserted at
the second occurrence's old locator**, so the nearest candidate is the twin while the referent has moved
away.

| Strategy | c1 | c2 |
| --- | --- | --- |
| `content` | verified_correct | **verified_wrong** |
| `ordinal` | verified_correct | **verified_wrong** |
| `context` | verified_correct | **verified_wrong** |
| `ordinal+context` | verified_correct | **verified_wrong** |
| **`refined`** | **ambiguous** | **ambiguous** |

The resolver had four inputs and no way to distinguish the twin from the referent. `context` reported
**verified** for a wrong line — a silent misattribution produced by the rule that was supposed to be
safe. `refined` reported `ambiguous` for both, which is the only claim the evidence supports.

## 2. Updated totals (13 edits × 2 anchors = 26 evaluations)

| Strategy | correct | **silent_wrong** | ambiguous | needs_reattribution |
| --- | ---: | ---: | ---: | ---: |
| `content` | 16 | **9** | 0 | 0 |
| `ordinal` | 13 | **7** | 0 | 5 |
| `context` | 20 | **1** | 0 | 4 |
| `ordinal+context` | 16 | **1** | 0 | 8 |
| **`refined`** | **17** | **0** | **4** | **4** |

`refined` is the only strategy with zero silent misattributions. Its cost is unchanged: **3 false flags
of 26 (11.5%)** — E5, E6 and E10, all adjacent-line edits with the referent intact — plus 1 correct flag
(the revised line) and 4 ambiguity reports (E11, E12).

## 3. AC-6 under A1′ — four counts, reported separately

Same basis as the acceptance suite: every trimmed line of `src/spans.js` ≥ 8 characters, occurrence
ordinal from repeated trimmed lines, revision = `locate` → `locateSpan`. 101 occurrences, 96 distinct
quotes.

| Outcome | Occurrences | Distinct quotes |
| --- | ---: | ---: |
| `verified` | **94** | **90** (93.8%) |
| `ambiguous` | 2 | 1 (`ok: true,`) |
| `needs_reattribution` (false flags) | 3 | 3 |
| `unresolved` | 2 | 2 |
| **actual reattributions** | **0** | — |

**The ambiguity is real, not synthetic.** `ok: true,` occurs more than once in `src/spans.js` with
identical neighbouring lines. Under A1′ it is reported `ambiguous`; under the ordinal rule it was
silently attributed to whichever occurrence carried the rank. The collision hazard is not an artefact of
the probe — it exists in the codebase being measured.

**The three false flags are exactly the predicted collateral**, and their quotes confirm it:

| Line | Quote | Why the context drifted |
| --- | --- | --- |
| L64 | `const source = findSource(` | previous line *is* the renamed `locate` signature |
| L130 | `stats.refs += 1;` | next line *is* `const found = locate(input, ref);` |
| L132 | `if (!found.ok) {` | previous line is the same renamed call |

None of the three quotes changed. Their neighbours did. A1′ re-verifies them instead of assuming.

**Collateral, stated as a cost:** occurrence survival falls from **99/101** (ordinal) to **94/101**
(A1′); distinct-quote survival from **94/96** to **90/96**. That is 5 anchors of extra verification and
zero silent misattributions. Per your asymmetry, that is the right side of the trade.

**One caveat that matters for how the ordinal number is cited:** AC-6's 99/101 is a *survival* count, not
an attribution-correctness count. On a rename every offset below a symbol shifts, so an anchor can
"survive" while pointing at a different occurrence — which is precisely what D3 measured (7/26 silent
misattributions). 99/101 must not be read as 99 correctly attributed.

## 4. Why the model must stay non-binary

The four distinctions you named are now each backed by a measured case:

| Distinction | Evidence |
| --- | --- |
| found ≠ verified | E11: 2 occurrences found, neither verifiable → `ambiguous` |
| similar ≠ identical | E12: twin at the old locator, identical context, different referent |
| missing ≠ deleted | E7 / AC-6 unresolved: the line was **revised**, not removed; the claim survives, its anchor does not |
| ambiguous ≠ false | E11/E12: correct content, undecidable anchor — not an error, an absence of evidence |

These cannot be flattened at any layer. If AA receives `ambiguous` as `found`, or `unresolved` as
`deleted`, every conclusion built on it inherits the error — the same failure mode as the original
ordinal rule, one level up.

## 5. A1′ status

Provisional design confirmed by both probes:

```
claim_id            stable claim identity
anchor_id           immutable: H(source, quote, birth_context_fingerprint)
context_fingerprint resolution evidence; may drift, never overwrites identity
locator             mutable candidate position
resolution_status   verified | ambiguous | needs_reattribution | unresolved
```

Only `verified` may support downstream propagation. `ambiguous` and `needs_reattribution` block
propagation; `unresolved` means the evidence is gone, not that the claim is false.

**Not amended:** `ARA-SCHEMA-01.md` keeps the ordinal rule on paper until you authorise the diff. The
acceptance suite therefore still validates the rule D3 rejects — a known, recorded inconsistency, not a
silent one.

## 6. Remaining before the gate can move

- Write the A1′ diff to `ARA-SCHEMA-01.md` (new `ARA-SCHEMA-02.md`, ordinal rule retained as superseded
  history) and re-run AC-1 … AC-7 against it.
- Storage-level AC-3 companion (D1) and D6 extraction contract still open.
- False-flag rate on real code under sustained editing; 11.5% here is synthetic-plus-one-rename, not a
  forecast for a long session.

## 7. Verification

```
node tools/d3-expanded-probe.js   → E12 table above; totals §2
node tools/ac6-refined.js         → 94/90 verified, 2 ambiguous, 3 false flags, 0 reattributions
node tools/schema-acceptance.js   → 39/39 (still the ordinal rule)
node tools/freeze-verify.js       → 27/27 intact
```
