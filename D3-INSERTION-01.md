# D3-INSERTION-01 — does occurrence identity survive an insertion?

**Date:** 2026-11-18 · **Cost:** $0, no model calls.
**Subject:** decision **D3** in `ARA-SCHEMA-01.md`, which is **frozen at SHA-256
`968a8142c2f86dd0fb330fc8b6ec2314666d3ef253fb0ae7df5fbf255e908d27`** and was not modified by this probe.
**Instrument:** `tools/d3-insertion-probe.js`.

**Answer: no — and the schema's own anchor rule is not safe.** An ordinal in the anchor id still
misattributes silently. Identity built from the **surrounding context** misattributes **zero** times in
six edits, at the cost of occasionally demanding re-verification it did not need.

---

## 1. Method

One 2-occurrence source, two tracked anchors, six edits, four strategies measured on the same edits:

| Strategy | Anchor id |
| --- | --- |
| `content` | `H(source, quote)` — what the shipped identity layer does |
| `ordinal` | `H(source, quote, occurrence)` — **what ARA-SCHEMA-01 §3.2 specifies** |
| `context` | `H(source, quote, previous_line, next_line)` |
| `ordinal+context` | all of the above |

Outcomes: `correct` (resolved to the occurrence it was created for), `silent_wrong` (resolved to a
different occurrence with no warning), `flagged` (`needs_reattribution`), `broken` (quote no longer
exists — correct for a revised line).

Each occurrence carries a uniquely identifying marker line, and the edit set is designed so a duplicate
can land above, between, and at scale.

## 2. Results

| Edit | content | ordinal | context | ordinal+context |
| --- | --- | --- | --- | --- |
| **S1** unrelated line inserted above | correct, correct | correct, correct | correct, correct | correct, correct |
| **S2** duplicate inserted above (small) | **t1 silent_wrong**, correct | **t1 silent_wrong**, t2 flagged | correct, correct | correct, t2 flagged |
| **S3** duplicate inserted between | correct, **t2 silent_wrong** | correct, **t2 silent_wrong** | correct, correct | correct, correct |
| **S5** unrelated line deleted above (offset shift) | correct, correct | correct, correct | t1 **flagged**, correct | t1 **flagged**, correct |
| **S6** large block ending in a duplicate, above | **t1 silent_wrong**, **t2 silent_wrong** | **t1 silent_wrong**, t2 flagged | correct, correct | correct, t2 flagged |
| **S4** second occurrence revised | correct, **t2 silent_wrong** | correct, t2 flagged | correct, t2 flagged | correct, t2 flagged |

| Strategy | correct | **silent_wrong** | flagged |
| --- | ---: | ---: | ---: |
| `content` | 7 | **5** | 0 |
| `ordinal` (schema as written) | 6 | **3** | 3 |
| **`context`** | **10** | **0** | 2 |
| `ordinal+context` | 8 | **0** | 4 |

The two flags for `context` are not the same kind of event: S4's is **correct** (the line was revised, so
its identity is gone), S5's is a **false flag** (an unrelated line above it was deleted, changing the
previous-line context without changing the occurrence).

## 3. What this settles

**A1 as written in the schema is not sufficient.** Putting `occurrence` in the anchor id was supposed to
make occurrences identifiable. It does not, because the ordinal is checked against *the position the
resolver chose*: when the resolver picks the wrong line and that line happens to carry the same rank,
the check passes. S2, S3 and S6 are exactly that case — **3 silent misattributions**, which is the
failure mode the ordinal was added to prevent.

**Content-only identity is worse, not safer.** 5 silent misattributions of 12, including the offset-shift
case the model was proud of: `content` resolves correctly after a deletion (the locator moves with the
text) but not after a duplicate lands above.

**Context identity is the only strategy that never misattributes.** It trades that for false flags when
adjacent lines change — a safe failure: re-verifying costs a lookup, silent misattribution corrupts
lineage and every downstream relationship.

**`needs_reattribution` is justified by measurement**, not by anticipation. It fires 2 times where the
correct answer is "I cannot tell", which is what the schema predicted it would be for.

## 4. Proposed amendment (not applied — the schema is frozen)

**A1′** — anchor identity becomes:

```
anchor_id = H(schema, source_id, normalized_quote, context_before, context_after)   // ±1 line, normalized
occurrence = recorded attribute, used for reporting and tie-breaking, not part of the key
```

with resolution: find occurrences of the quote whose surrounding context matches the record; exactly one
→ resolved; none → `needs_reattribution`; several → nearest locator, else `needs_reattribution`.

Consequences if adopted:

- **AC-5** still passes — three occurrences still get three distinct ids, now for a different reason
  (three different contexts rather than three ordinals).
- **AC-6** is unaffected for unique lines, but should be re-run: the rename changes the *context* of
  neighbouring anchors, so collateral counts may rise from 2 towards "2 plus adjacent lines". That
  number must be measured before it is quoted.
- **D3 closes** with an empirical basis; the ordinal remains in the record as an attribute, which keeps
  the reporting value without the false identity claim.
- Cost of the safe failure is now measurable: **1 false flag in 6 edits** on this fixture. That is the
  number to watch on code, where adjacent-line edits are constant.

## 5. Two scoring defects caught before reporting

Both would have changed the conclusion, and the first would have inverted it:

1. **Forward marker scan.** The tag lookup scanned forward to the next `#` line, so an inserted duplicate
   inherited a later occurrence's marker and scored `correct`. Under that scoring `content` looked like
   10/12 with 2 misattributions; with the immediate-next-line rule it is **7/12 with 5**. The probe was
   hiding the failure it existed to find.
2. **`expect` never copied into the result rows**, so the printed scenario labels read `undefined` —
   cosmetic, but it meant the table could not be checked against its own intent.

## 6. Limits

- Two occurrences, ±1 line of context, six synthetic edits. Not tested: three or more duplicates, code
  with multi-line constructs, the false-flag rate under sustained editing, or performance.
- "Correct" is defined by the marker line; a real source has no markers, so production scoring needs the
  context window itself as the ground truth — which is the mechanism being tested, a circularity worth
  naming.
- No model involved; this is a pure resolver property.

## 7. Gate status

| Gate | Status |
| --- | --- |
| D3 has an empirical result | **yes** — this document |
| `ARA-SCHEMA-01.md` amended | **no** — frozen at `968a8142…`; A1′ awaits a decision |
| Implementation authorised | **no** — unchanged: D1, D3 (pending A1′), D6, D8 and the AC-3 storage companion remain open |

## 8. Verification

```
node tools/d3-insertion-probe.js    → 4 strategies × 6 edits, table above
sha256sum ARA-SCHEMA-01.md          → 968a8142… (unchanged, frozen)
node tools/schema-acceptance.js     → 39/39 (validates the schema as written, not A1′)
node tools/freeze-verify.js         → 27/27 intact
```
