# D8-EXCHANGE-01 — AA ↔ ARA exchange contract

**Date:** 2026-11-18 · **Cost:** $0, offline.
**Instruments:** `tools/d8-exchange.js`, `tools/d8-acceptance.js` — **45/45**.
**Baseline:** `ARA-FREEZE-01` untouched (12/12). D8 is an addition.

**Result: the boundary holds. Authority crossing is refused rather than cleaned, and every exchange —
including refusals — is hash-chained and replayable.**

---

## 1. Direction of authority

| | May cross | Must never cross |
| --- | --- | --- |
| **AA → ARA** | claims, verbatim evidence, source references and revisions, anchor identities, extractor provenance, explicit unknowns | AA confidence, verdicts, conclusions, recommendations, assessments, probabilities, preferred actions |
| **ARA → AA** | assessments (its own, model-attributed), coverage records, open conflicts, anchor resolution status, insufficiency reasons with the failing side | anything presented as AA's own observation or confidence; instructions; truth claims |

A submission containing `confidence`, `verdict`, `assessment`, `probability` or `conclusion` anywhere in
its claim tree is **rejected whole** — not stripped, not logged-and-ignored. Silently dropping the field
would make AA believe its judgement had been considered.

## 2. Envelope

```json
{
  "schema": "aa-ara/v1",
  "direction": "submit",
  "submission_id": "s1",
  "supersedes_revision": "r1",
  "claims": [{
    "text": "The service keeps three replicas.",
    "domain": "prose",
    "anchors": [{
      "source_id": "svc.md", "source_revision": "r2",
      "quote": "The service keeps three replicas.",
      "context": "a|b", "loc_start": 0, "loc_end": 33,
      "status": "verified"
    }]
  }],
  "unknowns": [{ "kind": "retrieval", "detail": "head revision unavailable" }]
}
```

ARA assigns identities on arrival (claim and anchor ids are ARA's computation), so AA cannot assert an
identity it did not earn. `status` is AA's retrieval status, mapped — not trusted as an appraisal.

## 3. Dispositions

| Disposition | Rule | Effect |
| --- | --- | --- |
| `rejected` | authority leak, unsupported schema, wrong direction, empty claims, malformed unknown | nothing written; refusal audited |
| `duplicate` | same `submission_id`, or same claim with the same anchor identities and statuses | no event |
| `stale` | a different `source_revision` arrives for a source without `supersedes_revision` naming the stored one | nothing written |
| `accepted` | otherwise | one `append` event; unknowns recorded in the audit |

Revisions are **opaque tokens**: ordering is not inferred. An advance must be declared, because guessing
that `r2` is newer than `r1` is exactly the kind of silent assumption this contract exists to forbid.

## 4. Status mapping

| AA retrieval status | ARA anchor status |
| --- | --- |
| `verified` | `verified` |
| `ambiguous` | `ambiguous` |
| `stale` | `needs_reattribution` |
| `not_matched` | `unresolved` |
| `not_covered` | `unresolved` |

The mapping is total and **never upgrades**. ARA does not re-verify at the boundary: an anchor arriving
`ambiguous` stays `ambiguous`, and no arriving status becomes `verified` through transfer. `not_covered`
becomes `unresolved`, not "absent" — ARA has no evidence about the occurrence at all.

## 5. Response

```
{ claims: [{ claim_id, resolution_status[], assessments[], conflicts[], coverage[] }],
  coverage[], insufficiency, unknowns_received }
```

`insufficiency` names its failing side: `instrument` when no coverage exists or the instrument does not
fit the domain, `coverage` with `covered/total` when it does. **Sufficiency never reads AA confidence**,
because AA confidence never arrived; there is no field for it to read. Missing coverage is reported as a
side, never as `0`.

Explicit unknowns are recorded in the audit and counted in the response, but are **not** turned into
claims and not rendered as resolution statuses — an unknown is not a finding.

## 6. Audit and replay

Every exchange entry carries `seq`, `direction`, `disposition`, `reason`, `envelope_digest`,
`prev_digest` and a chained `digest`. Refusals are entries too: the log shows what was attempted, not only
what succeeded.

- Replay recomputes dispositions from the envelopes and compares them with the recorded ones — it does not
  trust the log's own conclusions.
- Replay reproduces the ARA projection byte for byte and the audit chain.
- Editing a recorded envelope breaks the chain (tested).

## 7. What this does not establish

- **Same process, same database.** No transport, no authentication, no authorisation, no rate limiting,
  no schema negotiation. This is the contract, not a service.
- **Single writer.** Concurrent submitters could interleave; ordering is not promised.
- **Duplicate detection is structural**, by claim text and anchor identity. Two genuinely different
  observations that happen to share text and anchors collapse — correct for this schema, but it means
  "duplicate" says nothing about intent.
- **Opaque revisions depend on AA honesty** in declaring `supersedes_revision`.
- No volume or performance claim.

## 8. Gate state

| Gate | Status |
| --- | --- |
| D8 exchange contract | **met at model level** (45/45) |
| replay | met (D1 + D8) |
| compaction | **open** — next |
| AA schema | not started |
| combined acceptance and freeze | not yet |
| implementation | **closed** |

## 9. Verification

```
node tools/d8-acceptance.js         → 45/45
node tools/storage-acceptance.js    → 58/58
node tools/ara-freeze.js --verify   → 12/12 baseline artifacts
node tools/schema-acceptance-v2.js  → 52/52
node tools/d6-heldout.js            → 33/33
node tools/selftest.js              → 52/52
```
