# ARA-SCHEMA-01 — logical schema for the ARA information model

**Date:** 2026-11-18 · **Cost:** $0 · **Status:** design only. No migration, no table, no implementation.
**Inputs:** `INFORMATION-MODEL-01.md` (decision + amendments A1–A3), `CODE-STRESS-01.md` (what survived
code), `CARD-ID-01.md`, `CARD-GEN-01.md`, `INVENTORY-COVERAGE-01.md`.

These are **logical entities**, not six physical tables. Storage layout is deliberately undecided (§9, D1).

---

## 1. The invariant

ARA must answer four questions, and **no field may answer more than one**:

| # | Question | Answered by | Never by |
| --- | --- | --- | --- |
| **Q-A** | What information do I have? | `Claim` + `Anchor` (existence and resolvability) | a confidence score |
| **Q-B** | Where did it come from? | `Anchor` (source, revision, locator) + `Relationship.provenance` | a citation string |
| **Q-C** | What relationships have actually been established? | `Relationship` (typed, with extractor provenance) | import of a claim's text |
| **Q-D** | How complete and reliable is this for *this* decision? | `Coverage` (required set, instrument, blind spots) **and** `Assessment` (per-claim) — two answers | one blended number |

The failure this prevents is the measured one: F9 scored **1.00** on its own denominator while blind to
**2 of 2** required items. Any single field answering Q-A and Q-D together would have rendered that as
success. Q-D therefore returns **two** values plus an explicit `insufficient` with the failing side named.

## 2. Design principles (each with its evidence)

| Principle | Evidence |
| --- | --- |
| Identity is assigned by assembly, never by a model | engine agreement **1.000**; `cardId()` has no model input |
| Content identity and occurrence identity are different keys | **41/665** code lines share a content id; retrieval survives, attribution does not (A1) |
| No record without provenance | 50–60% of cards unanchorable; an unanchorable record is not retrievable |
| Append-only; state is a projection | mutable `status` loses *why* a decision changed, which RDA needs |
| `unknown` is representable and required | omission is undetectable from inside; a missing instrument must not read as zero (A2/A3) |
| No automatic conflict resolution | no experiment establishes which source wins; F3 P4 (0.57) and F9 P4 (0.43) are cases where a confident merge picks the wrong representation |
| Domain declares its instruments | prose constraint rules measured **0.00** on code; edges **0 of 1** imports (A2/A3) |

## 3. The six records

### 3.1 Claim — what is asserted

```json
{
  "claim_id": "clm_9f2c…",          // H(schema, canonical_text, domain)
  "canonical_text": "Nothing is deleted before that window closes.",
  "normalized": "nothing is deleted before that window closes",
  "domain": "prose | code | legal",
  "created_at": "2026-11-18T14:00:00Z",
  "status": "derived"                // projection, never stored
}
```

**Key:** content only. No confidence, no model, no run id, no timestamp in `claim_id` — two systems
asserting the same thing about the same evidence must land on the same claim.
**Must not contain:** probability, verdict, "is_complete", any positional reference.

### 3.2 Anchor — where a claim was seen, this occurrence

```json
{
  "anchor_id": "anc_71ab…",         // H(schema, source_id, normalized_quote, occurrence)
  "claim_id": "clm_9f2c…",
  "source_id": "src/spans.js",
  "source_revision": "sha256:4c1e…",
  "occurrence": 2,                  // rank among identical quotes at this revision
  "ordinal_basis": "observed",      // observed | rederived | reattributed
  "locator": { "start": 1840, "end": 1889 },
  "quote_digest": "sha256:aa01…",
  "state": "resolved",              // resolved | stale | ambiguous | missing | needs_reattribution
  "resolved_at": "2026-11-18T14:00:00Z",
  "resolution_mode": "same_offset"  // same_offset | relocated | disambiguated
}
```

**The locator is stored, and is *not* in `anchor_id`.** Including it would make every id break when anyone
types above it — destroying the measured result that **20/20 anchors re-resolved** after a global offset
shift while their stored offsets were invalid. The anchor still identifies a particular occurrence
because `occurrence` is in the id and `locator` is on the record; the locator is a *verified handle*, the
quote is the verification. If locator-in-id is wanted anyway, it is a one-line change at a measured cost
(§9, D2).

**Residual defect, stated rather than hidden:** `occurrence` is unstable if an identical line is inserted
above it. When locator and ordinal disagree after an edit, the record goes to `needs_reattribution` — it
is never silently re-pointed. `ordinal_basis` records which case applied.

### 3.3 Relationship — a typed edge with provenance

```json
{
  "relationship_id": "rel_2b7d…",   // H(schema, from_claim, to_claim, type)
  "from_claim_id": "clm_9f2c…",
  "to_claim_id": "clm_a410…",
  "type": "depends_on",             // depends_on | supersedes | governs | owns | contradicts | composed_of
  "direction": "directed",
  "provenance": [
    {
      "extractor": "code.imports",  // declared, never implicit
      "extractor_version": "1",
      "evidence_anchor_ids": ["anc_71ab…"],
      "asserted_at": "2026-11-18T14:00:00Z"
    }
  ]
}
```

**Key excludes provenance**, so two extractors that agree on an edge produce *one* relationship with two
provenance rows — the same lesson that made engine agreement 1.000 useful rather than noisy.
**Provenance is mandatory.** An edge with no extractor cannot be written; a scope with no analyzer has
`edges: unknown`, never `0` (A3), because the corpus had **2 real dependents** and the model recorded
**0** edges.

### 3.4 Assessment — how reliable one claim is

```json
{
  "assessment_id": "asm_5c31…",     // H(schema, claim_id, question_id, model, assessed_at)
  "claim_id": "clm_9f2c…",
  "question_id": "nothing_deleted_early",
  "model": "perplexity/pplx-decider-flash-v1.2",
  "answer_form": "noul",
  "probability": 0.991,
  "evidence_anchor_ids": ["anc_71ab…"],
  "verdict": "supported",           // supported | unsupported | indeterminate
  "cost_usd": 0.00002483,
  "assessed_at": "2026-11-18T14:00:00Z"
}
```

**Never merged.** Confidence moves while claims do not (0.49 and 0.72 are the same card), so assessments
accumulate beside an immutable claim. No `confidence` column exists on `Claim` — that is the point.

### 3.5 Event — the only write path

```json
{
  "event_id": 10042,                // store-local monotonic, append-only
  "at": "2026-11-18T14:00:00Z",
  "actor": "extractor | adjudicator | agent | system",
  "op": "append",                   // append | supersede | conflict | resolve | retract
  "subject": { "claim_id": "clm_9f2c…" },
  "payload": { "anchor_id": "anc_71ab…" },
  "basis": null                     // required by resolve; free text by retract
}
```

No record is updated in place; every change is an event, and current state is a **projection** of the log.
The projection must equal a replay from empty (§8, AC-1).

### 3.6 Coverage — how complete, for a scope

```json
{
  "coverage_id": "cov_8e10…",       // H(schema, scope, required_set_digest, instrument, domain)
  "scope": "repo:gca / decision:retention_policy",
  "domain": "code",
  "required_set": { "ref": "req_31items", "digest": "7c7913b1cf933cca…", "items": 31 },
  "instrument": { "name": "prose_rules", "version": "1", "class": "structural_constraint" },
  "measured": { "covered": 0, "total": 12, "class_recall": 0.0 },
  "instrument_fit": "mismatch",     // fit | mismatch | absent
  "blind_spots": ["guards/refusals have no code-aware instrument"],
  "unanchored_claims": 412,
  "computed_at": "2026-11-18T14:00:00Z"
}
```

`instrument_fit: mismatch` is why a **0.00** class recall is reported as 0.00 and not repaired into 0.75 by
line overlap (A2). Coverage for a scope whose instrument is absent is `unknown`, and `unknown` is not zero:
a decision may not proceed on it silently.

## 4. Keys and identity rules

| Record | Key | Excludes | Why |
| --- | --- | --- | --- |
| Claim | `H(schema, canonical_text, domain)` | confidence, model, run, time | reuse must be free and model-independent |
| Anchor | `H(schema, source_id, normalized_quote, occurrence)` | locator, revision | offsets go stale; ids must not |
| Relationship | `H(schema, from, to, type)` | provenance | agreement must collapse to one edge with two proofs |
| Assessment | `H(schema, claim_id, question, model, at)` | — | assessments are observations, never deduplicated away |
| Event | store-local monotonic | — | total order per store is what makes replay deterministic |
| Coverage | `H(schema, scope, required_set_digest, instrument, domain)` | measured value | a re-measurement is a new record, not an edit |

## 5. Event semantics

| Op | Preconditions | Effect | Forbidden |
| --- | --- | --- | --- |
| `append` | provenance present (anchor or extractor) | new claim/anchor/relationship | appending without a source |
| `supersede` | old and new both exist | new `valid_from`; old `valid_until` set | deleting or overwriting the old record |
| `conflict` | both exist, same anchor class | symmetric pair recorded on both | resolving it in the same event |
| `resolve` | `basis` non-null (source wins, or adjudicator id) | conflict closed with named authority | automatic resolution; resolution without basis |
| `retract` | cause given | state → `unknown` with cause; record retained | removing the record or its events |

Invariants: no event deletes; no projection is authoritative; a `conflict` left open is a *valid* state
that must be reported rather than cleaned up.

## 6. Retrieval contract

Three modes, three distinct failure vocabularies — they may never collapse into "not found":

| Mode | Input | Success | Failure values |
| --- | --- | --- | --- |
| exact | `claim_id` | the claim + anchors | `absent` |
| anchored | `(source_id, quote, occurrence?)` | span + `resolution_mode` | `stale`, `ambiguous`, `quote_not_found`, `source_missing` |
| traversed | `(claim_id, type, depth≤2, direction)` | edges + their provenance | `no_edges`, `edges_unknown` (no declared extractor) |

`stale` vs `ambiguous` vs `quote_not_found` is the distinction the identity layer exists to make: a
record that cannot be found, a quote that repeats, and a field that moved are three different facts about
the system's knowledge, and only the third is repairable.

**Sufficiency query** (`may_proceed(scope)`):

```
coverage = measure(scope)                      // Q-D part 1: instrument_fit must be 'fit'
support  = min assessment probability over claims in scope   // Q-D part 2
result   = covered ∧ support ≥ floor
         | insufficient{ side: 'coverage' | 'support' | 'instrument', detail }
```

Never "sample more until confident" — that silently changes the denominator.

## 7. The invariant, checked record by record

| Question | Query | Returns | Cannot be answered by |
| --- | --- | --- | --- |
| Q-A | claims in scope + anchor states | counts by state, unanchored list | `Assessment.probability` |
| Q-B | anchors of a claim | source, revision, locator, mode | `Claim.canonical_text` |
| Q-C | traversal with provenance | typed edges + extractor + evidence | text similarity |
| Q-D | `measure(scope)` + assessments | two values, `insufficient` naming the side | any single field |

A schema test in §8 (AC-3) asserts this mechanically: no query for one question may read a field
belonging to another's answer set.

## 8. Acceptance criteria (testable, before any implementation)

| # | Criterion | Probe |
| --- | --- | --- |
| AC-1 | replay from the event log equals the projection | rebuild from `Event` only, diff against stored state |
| AC-2 | no record without provenance | assert every written record has an anchor or extractor |
| AC-3 | four questions use disjoint field sets | query audit over the four contracts |
| AC-4 | `unknown` never renders as zero | scope with `instrument_fit: absent` must return `unknown` |
| AC-5 | occurrence attribution holds on repeated lines | reuse the code corpus: **41/665** lines share a content id; each must resolve to its own occurrence |
| AC-6 | revision stability preserved | rename `locate` → `locateSpan`: **94/96** anchors survive, **2/2** breaks are the symbol lines |
| AC-7 | `edges_unknown` is distinguishable from `no_edges` | scope without analyzer must not report 0 |

AC-5 through AC-7 are already demonstrated at the model level by `CODE-STRESS-01`; the schema must not
regress them.

## 9. Unresolved design decisions

| # | Decision | Options | What would settle it |
| --- | --- | --- | --- |
| **D1** | one store or two | shared schema + separate stores (recommended) vs shared tables | AA contract mapping (phase 3) |
| **D2** | locator in `anchor_id` | stored verified handle (recommended) vs in the hash | re-run the offset-shift probe; in-hash should break all 20 |
| **D3** | occurrence durability | stored ordinal + locator verify (recommended) vs rank-at-resolve vs context-window hash | a corpus with insertions above duplicates; none measured yet |
| **D4** | conflict authority | none until measured (recommended) vs source-precedence rules | an experiment where precedence is knowable |
| **D5** | revision identity | whole-source content hash vs monotonic revision number | edit-pattern data; not measured |
| **D6** | edge extraction per domain | `code.imports` analyzer; prose rules; absent → `unknown` | the code analyzer does not exist yet |
| **D7** | assessment retention | keep all vs window per claim | cost of storage vs drift analysis need |
| **D8** | how ARA learns of AA claims | event feed vs pull by `claim_id` | AA contract mapping; must not become inheritance |

## 10. What is deliberately absent

No `confidence` on `Claim`; no `is_complete`; no positional identity; no edge without provenance; no
automatic merge; no single "memory" row that implies knowledge. Each absence corresponds to a measured
failure elsewhere in this project.

## 11. Limits of this document

It is a design derived from six files of one repository, ten synthetic documents, one engine and one
reviewer. The parts with the strongest evidence are identity, the update algebra and the sufficiency
split; the parts with the weakest are every domain-specific extractor (D6), where code measured **0.00**
constraint recall and **0** recorded imports. Nothing here is implemented, and no migration should begin
before AC-1 through AC-7 exist as tests.
