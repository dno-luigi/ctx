# ARA-SCHEMA-02 — anchor identity and resolution (A1′)

**Date:** 2026-11-18 · **Status:** revision accepted provisionally, **implementation still closed**.
**Supersedes:** `ARA-SCHEMA-01.md`, digest `968a8142c2f86dd0fb330fc8b6ec2314666d3ef253fb0ae7df5fbf255e908d27`.
**Scope of the revision:** the anchor record's identity and resolution contract, and the two acceptance
criteria that depend on them (AC-5, AC-6). Nothing else.

---

## 0. Historical evidence, preserved

`ARA-SCHEMA-01.md` is **not edited**. It remains the record of the ordinal rule and of the results that
were true for it:

| Artifact | State |
| --- | --- |
| `ARA-SCHEMA-01.md` | unchanged, digest `968a8142…` |
| `tools/schema-acceptance.js` (v1) | unchanged, 39/39, validates the ordinal rule |
| `ARA-SCHEMA-VALIDATION-01.md` | unchanged, records the v1 results |
| `D3-INSERTION-01/02/03.md` | unchanged, record why the ordinal rule was withdrawn |
| `tools/d3-insertion-probe.js`, `tools/d3-expanded-probe.js` | unchanged |

The 39/39 result is not retracted and not re-scored. It measured a contract that is now superseded, and
both facts stand.

## 1. The change, in one table

| | ARA-SCHEMA-01 | ARA-SCHEMA-02 (A1′) |
| --- | --- | --- |
| `anchor_id` | `H(source, quote, occurrence_ordinal)` | `H(source, quote, birth_context_fingerprint)` |
| occurrence rank | part of identity | **not stored as identity**; derivable, never authoritative |
| context | absent | `context_fingerprint`, resolution evidence |
| locator | handle, assumed correct | `locator`, mutable candidate — never identity |
| resolution outcome | found / not found | `verified` / `ambiguous` / `needs_reattribution` / `unresolved` |
| what may propagate | any resolved anchor | **only `verified`** |

## 2. Anchor record

```
anchor_id            immutable identity: H(source_id, normalized_quote, birth_context_fingerprint)
claim_id             the claim this anchor supports
source_id            source the occurrence lives in
source_revision      revision the anchor was born at, or null
context_fingerprint  ±1-line neighbourhood last verified; may drift, never rewrites anchor_id
locator              {start, end} candidate position — a handle, not a fact
quote                verbatim text; the anchor's content, immutable
resolution_status    verified | ambiguous | needs_reattribution | unresolved
```

Rules:

1. `anchor_id` is computed once, at creation. A revision never recomputes it.
2. A context change never silently rewrites the anchor. It changes `resolution_status`.
3. `locator` may move freely; movement is not evidence of identity.

## 3. Resolution contract

Given an anchor and a source revision:

1. no whole-line occurrence of `quote` → `unresolved`
2. exactly one occurrence whose context equals `context_fingerprint` → `verified`
3. more than one → `ambiguous`, with **all** candidates reported
4. none → `needs_reattribution`

**Propagation:** `verified` may support dependent claims, relationships and assessments. `ambiguous`,
`needs_reattribution` and `unresolved` **block propagation**. They are not errors and not falsity; they
are absence of established identity.

Governing rule: **an anchor may move, but it may never silently change what it refers to.**

## 4. What this costs — stated, not hidden

### 4.1 AC-5 is narrowed

The ordinal rule guaranteed three distinct identities for three occurrences of the same quote. A1′ does
**not**. Where occurrences share an identical ±1-line neighbourhood, they share a birth context, so they
share an `anchor_id` and all resolve `ambiguous`:

| Fixture | ARA-SCHEMA-01 | ARA-SCHEMA-02 |
| --- | --- | --- |
| three `run();`, distinguishable neighbours | 3 ids, 3 verified | 3 ids, 3 verified |
| three `run();` in identical `if (ready) { … }` blocks | 3 ids, 3 "verified" | **1 id, 3 ambiguous** |

This is a genuine capability boundary, not a defect to paper over: A1′ cannot distinguish occurrences
its evidence cannot tell apart. It reports that, rather than inventing an order. The acceptance suite
asserts the collapse explicitly (`tools/schema-acceptance-v2.js`, AC-5).

### 4.2 AC-6, measured on the real revision

`src/spans.js`, 101 occurrences / 96 distinct quotes, rename `locate` → `locateSpan`:

| Outcome | Occurrences | Distinct quotes |
| --- | ---: | ---: |
| `verified` | 94 | 90 |
| `ambiguous` | 2 | 1 (`ok: true,` — identical neighbours) |
| `needs_reattribution` | 3 | 3 (L64, L130, L132 — all adjacent to a renamed line) |
| `unresolved` | 2 | 2 (the renamed symbol lines) |
| actual reattributions | **0** | — |

The three re-verifications are the price: lines whose neighbours were edited are re-checked even though
their referent is intact. **94/101 is a result about this file, this edit and this denominator** — not a
reliability claim for another corpus or a longer session.

Zero reattributions means the model detected what it could not resolve; it does not mean attribution
risk is zero.

## 5. Acceptance criteria, revised

- **AC-5 (revised):** distinguishable contexts yield distinct identities and `verified` resolutions;
  identical contexts collapse to one identity and resolve `ambiguous` with all candidates named; no
  occurrence with an unestablished identity is reported `verified`.
- **AC-6 (revised):** revision produces four separated counts (verified / ambiguous / reattributed /
  unresolved); **no anchor is silently reattributed**; every `unresolved` occurrence is a line whose own
  quote changed; every `needs_reattribution` quote still exists verbatim in the revision.
- **AC-1, AC-2, AC-3, AC-4, AC-7:** unchanged in substance, re-run against the new anchor form
  (`anchor` now requires a birth context, `provenance.fields` carries `context` and
  `resolution_status`).

`node tools/schema-acceptance-v2.js` → **52/52**.

## 6. What is not changed

Retrieval contract, six-state lifecycle, event semantics (`append`, `supersede`, `conflict`, `resolve`,
`retract`), relationship identity vs proof identity, assessment independence, `edges_unknown` vs
`no_edges`, coverage and sufficiency rules, D1–D8. The revision touches identity and resolution only.

## 7. Open, and what would invalidate this revision

| Item | Status |
| --- | --- |
| Identical-context occurrences cannot be individually identified | **known limitation**; candidate A1″ (wider context or structural path) — not applied |
| False-flag rate under sustained editing | unmeasured beyond one rename |
| D6 extraction contract | open — blocks implementation |
| D8 cross-store exchange | open |
| AC-3 storage companion (D1) | open |
| replay/projection volume and compaction | open |
| Implementation | **closed** by the gate in `PHASE-02.md` |

This revision would be invalidated by a probe showing a `verified` anchor whose referent changed without
its status changing, or a `needs_reattribution`/`ambiguous` rate that makes retrieval unusable on real
code. Neither is measured yet.

## 8. Verification

```
node tools/schema-acceptance-v2.js   → 52/52 (A1′, revised AC-5/AC-6)
node tools/schema-acceptance.js      → 39/39 (v1, ordinal rule, unchanged)
node tools/ac6-refined.js            → 94/90 verified, 2 ambiguous, 3 false flags, 0 reattributions
node tools/d3-expanded-probe.js      → refined: 0 silent misattributions (content 9, ordinal 7, context 1)
node tools/freeze-verify.js          → 27/27 intact
node tools/selftest.js               → 52/52
sha256 ARA-SCHEMA-01.md              → 968a8142c2f86dd0fb330fc8b6ec2314666d3ef253fb0ae7df5fbf255e908d27 (unchanged)
```
