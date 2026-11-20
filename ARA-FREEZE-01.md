# ARA-FREEZE-01 — design baseline

**Date:** 2026-11-18
**Baseline:** `ARA-SCHEMA-02.md` (A1′) plus the evidence that supports it.
**Manifest:** `baseline/ara-freeze-01.json` — 12 artifacts, 15 pinned results.
**Manifest digest:** `78d98b588cf1ea6ebacacf379957c87c1de5e38aaa76bce4e6c0dabef3374803`
**Supersedes:** `ARA-SCHEMA-01.md`, digest `968a8142c2f86dd0fb330fc8b6ec2314666d3ef253fb0ae7df5fbf255e908d27` (preserved, not edited).

---

## 1. What is frozen

Twelve artifacts, each with a SHA-256 in the manifest:

| Group | Artifacts |
| --- | --- |
| current design | `ARA-SCHEMA-02.md` |
| current acceptance | `tools/schema-acceptance-v2.js` (52/52) |
| superseded design, preserved | `ARA-SCHEMA-01.md`, `tools/schema-acceptance.js` (39/39), `ARA-SCHEMA-VALIDATION-01.md` |
| D3 evidence | `D3-INSERTION-01/02/03.md` + their three instruments |
| source contract | `INFORMATION-MODEL-01.md` |

Freezing makes change **detectable**, not forbidden. Any change to these bytes is a deviation that must
be recorded with its reason; it is never resolved by regenerating the manifest.

## 2. Pinned results

These numbers may be cited only when `node tools/ara-freeze.js --verify` reports 12/12 intact.

| Result | Value |
| --- | --- |
| acceptance v2 (A1′) | **52/52** |
| acceptance v1 (ordinal rule, superseded) | **39/39** |
| AC-6 verified occurrences | **94/101** |
| AC-6 verified distinct quotes | **90/96** |
| AC-6 ambiguous / needs_reattribution / unresolved | 2 / 3 / 2 |
| AC-6 actual reattributions | **0** |
| D3 silent misattributions: content / ordinal / context / refined | 9 / 7 / 1 / **0** |
| D3 refined false flags | 3/26 |
| pilot freeze | 27/27 |
| `selftest` | 52/52 |

`94/101` and `90/96` are results about `src/spans.js`, one rename, and that denominator. They are pinned
as measurements, not as reliability claims.

## 3. What is deliberately not frozen

| Item | Why |
| --- | --- |
| **A1″** (wider or structural context for structurally indistinguishable occurrences) | A separate investigation with its own fixtures and acceptance criteria. It must not expand into this revision. |
| Occurrence-addressability limitation | Recorded in `ARA-SCHEMA-02.md` §4.1 as a boundary of A1′; unresolved, and out of scope here. |
| D1 — storage-level AC-3 companion | Open gate. |
| D6 — domain-specific extraction contract | Open gate. |
| D8 — cross-store exchange contract | Open gate. |
| Replay/projection volume and compaction | Open gate. |
| Implementation | **Not authorised.** |

## 4. Gate state

| Gate | Required | Status |
| --- | --- | --- |
| D3 empirical result | probe evidence | **met** — three probes, collision proven |
| A1′ contract | accepted identity/resolution rule | **met, frozen here** |
| AC-3 storage companion (D1) | storage-level test | open |
| D6 extraction contract | declared code extractor | open |
| D8 cross-store exchange | tested contract | open |
| replay/projection boundary | volume + compaction | open |
| implementation | all of the above | **closed** |

## 5. Deviation procedure

1. Any edit to a frozen artifact is a deviation, recorded in a new versioned document (e.g.
   `ARA-SCHEMA-03.md`), not applied in place.
2. A deviation states which pinned result it invalidates and which must be re-measured.
3. The manifest is regenerated only after the deviation is recorded — never to make a check pass.
4. Results cited after a deviation must name the manifest digest they belong to.

## 6. Verification

```
node tools/ara-freeze.js --verify   → 12/12 baseline artifacts match ARA-FREEZE-01
node tools/schema-acceptance-v2.js  → 52/52
node tools/schema-acceptance.js     → 39/39 (superseded contract, preserved)
node tools/ac6-refined.js           → 94/90 verified, 2 ambiguous, 3 flagged, 0 reattributions
node tools/d3-expanded-probe.js     → refined 0 silent misattributions
node tools/freeze-verify.js         → 27/27 pilot artifacts
node tools/selftest.js              → 52/52
```
