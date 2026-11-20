# Schema

All artifacts are JSON, versioned by `schema`, and content-addressed by a `sha256:` digest over canonical
JSON (sorted keys). A consumer must refuse a `schema` it does not know.

Enums are closed. Anything outside them is recorded as a problem and downgraded — never coerced silently
into a valid member.

Examples below are **shape illustrations**, not measured results. The only measured artifacts are in
`examples/` and any live run's report; where a number appears here it exists to show the field type and
unit, not to claim an outcome.

---

## 1. Acquisition — `context-engine/sources/v1`

```json
{
  "schema": "context-engine/sources/v1",
  "root": "poc-repo",
  "root_path": "/…/fixtures/poc-repo",
  "sources": [{
    "source_id": "src/retention.js",
    "path": "src/retention.js",
    "kind": "code",
    "bytes": 214,
    "lines": 8,
    "sha256": "sha256:…",
    "mtime": "2026-11-20T…Z",
    "text": "…"
  }],
  "skipped": [{ "path": "node_modules", "reason": "excluded_directory" }],
  "totals": { "files": 11, "bytes": 3238, "skipped": 0, "by_kind": { "code": 4, "doc": 5 } },
  "digest": "sha256:…"
}
```

| Field | Rule |
| --- | --- |
| `source_id` | POSIX-relative path; stable identity for citations |
| `kind` | `code`, `config`, `doc`, `query`, `data`, `log`, `other` |
| `sha256` | digest of `{text}`; changes iff the visible bytes change |
| `skipped[].reason` | `excluded_directory`, `excluded_path`, `symlink_not_followed`, `binary`, `too_large:<bytes>`, `max_files_reached`, `not_a_regular_file` |
| `digest` | over `{root, files:[{source_id,sha256,bytes}]}` |

`text` is present in memory for verification and is **not** written into snapshots.

## 2. Partition plan — `context-engine/partitions/v1`

```json
{
  "schema": "context-engine/partitions/v1",
  "max_tokens_per_partition": 400000,
  "partitions": [{
    "partition_id": "p001",
    "source_ids": ["README.md", "src/ingest.js"],
    "ranges": [{ "source_id": "README.md", "start_line": 1, "end_line": 14 }],
    "estimated_tokens": 3238,
    "split": false
  }],
  "partition_count": 1,
  "estimated_tokens_total": 3238,
  "source_to_partitions": { "README.md": ["p001"] },
  "references": [{ "from": "src/ingest.js", "to": "src/store.js", "kind": "import", "line": 2 }],
  "cross_partition_references": []
}
```

`estimated_tokens` is `ceil(chars/4)` and is a planning figure. `split: true` records that one file was
divided; the ranges show where.

## 3. Model payload (untrusted input, not an artifact)

The prompt requests exactly this shape. It is validated, never trusted.

```json
{
  "findings": [{
    "kind": "architecture | responsibility | dependency | invariant | decision | state | outstanding | risk | contradiction | reference | task",
    "text": "one sentence, no recommendation",
    "certainty": "stated | derived | inferred",
    "sources": [{ "source_id": "path", "quote": "exact text", "line": 1 }],
    "entities": ["optional"]
  }],
  "relationships": [{ "from": "…", "to": "…", "type": "imports | depends_on | documents | defines | references", "sources": [{ "source_id": "…", "quote": "…" }] }],
  "contradictions": [{ "text": "…", "between": ["source_id"], "sources": [{ "source_id": "…", "quote": "…" }] }],
  "questions": ["…"]
}
```

Rules applied to it:

| Condition | Result |
| --- | --- |
| `kind` outside the enum | recorded as `unknown_kind`, kind becomes `reference` |
| `certainty` missing/invalid | recorded, certainty becomes `inferred` |
| no citation | verification `no_citation` |
| quote absent from the named source | verification `quote_not_found` |
| source not in acquisition | verification `source_unknown` |
| quote occurs more than once and no line resolves it | verified, `ambiguous_locator: true` |

## 4. Aggregate — `context-engine/aggregate/v1`

```json
{
  "schema": "context-engine/aggregate/v1",
  "findings": [{
    "kind": "invariant",
    "text": "The store MUST never delete an unexpired object…",
    "certainty": "stated",
    "entities": ["store", "MUST"],
    "partition": "p001",
    "verification": "citation_verified",
    "evidence": [{ "source_id": "src/store.js", "sha256": "sha256:…", "quote": "…", "start": 74, "end": 141, "line": 5, "occurrences": 1, "ambiguous_locator": false }],
    "flags": [],
    "merged_from": ["p001"],
    "partitions": ["p001"]
  }],
  "relationships": [{ "from": "src/ingest.js", "to": "src/store.js", "type": "imports", "verification": "citation_verified", "cross_partition": false }],
  "contradictions": [{ "text": "timeout is given 30 and 5…", "between": ["docs/ARCHITECTURE.md", "config/defaults.json"], "verification": "derived_from_quotes", "numeric": true }],
  "questions": [{ "text": "…" }],
  "unexamined_sources": ["config/defaults.json"],
  "stats": { "findings": 30, "findings_before_merge": 30, "duplicates_merged": 0, "verified_citations": 30, "failed_citations": 0, "relationships": 3, "cross_partition_relationships": 0, "contradictions": 0, "questions": 1, "sources_cited": 8, "sources_unexamined": 3, "kinds": {} },
  "digest": "sha256:…"
}
```

Numeric conflicts use the literal `key = value` / `key: value` form found inside verified quotes. They are
**candidates**: a key with two values across sources is reported, not adjudicated.

## 5. Snapshot — `context-engine/snapshot/v1`

```json
{
  "schema": "context-engine/snapshot/v1",
  "engine": "context-engine/0.1.0",
  "snapshot_id": "snap-1a2b3c4d5e6f7a8b",
  "subject": {
    "root": "poc-repo",
    "acquired_at": "…",
    "source_digest": "sha256:…",
    "files": 11,
    "bytes": 3238,
    "skipped": [],
    "source_facts": [{ "source_id": "README.md", "kind": "doc", "bytes": 559, "lines": 14, "sha256": "sha256:…", "mtime": "…", "authoritative": true }]
  },
  "scan": {
    "provider": "openai-compatible",
    "model": "~z-ai/glm-flash-latest",
    "upstream": ["Z.AI"],
    "generation_ids": ["gen-…"],
    "partitions": 1,
    "strategy": "single_pass",
    "partition_budget_tokens": 400000,
    "partition_budget_source": "model_context",
    "partition_budget_notes": ["operator ceiling 400000 is below the model's usable 782432; ceiling applies"],
    "partition_reason": "estimated 3238 tokens fits the 400000-token budget",
    "max_output_tokens": 8000,
    "calls": 1,
    "usage": { "input_tokens": 8123, "output_tokens": 1402, "cost_usd": 0.000434, "cost_source": "provider" },
    "latency_ms": 4210,
    "problems": []
  },
  "sections": {
    "source_facts": ["…"],
    "observations": [{ "kind": "…", "verification": "…", "evidence": ["…"], "status": "preserved | stale | invalidated (differential only)" }],
    "verified_conclusions": [{ "kind": "…", "text": "…", "evidence": ["…"] }],
    "inferences": [{ "kind": "…", "certainty": "inferred", "verification": "…", "flags": [] }],
    "questions": [{ "text": "…" }],
    "historical_state": null,
    "current_state": { "state": [], "outstanding": [], "risks": [] }
  },
  "architecture": { "components": [], "dependencies": [], "relationships": [] },
  "contradictions": [],
  "coverage": {
    "sources_total": 11,
    "sources_cited": 8,
    "sources_unexamined": ["config/defaults.json"],
    "citation_coverage": 0.7273,
    "findings": 30,
    "verified_citations": 30,
    "failed_citations": 0,
    "cross_partition_relationships": 0,
    "duplicate_findings_merged": 0
  },
  "manifest": { "model_derived": true, "authoritative_source": "subject.source_facts", "notes": ["…"] },
  "digest": "sha256:…"
}
```

Invariants:

1. `snapshot_id` equals `snap-` + the first 16 hex characters of `digest`.
2. `sections.source_facts` contains only acquisition fields; no model text.
3. `verified_conclusions` requires `verification = citation_verified`, `certainty = stated`, a concludable
   kind, **and** `status ∉ {stale, invalidated}`.
4. Every `verified_conclusions` entry has at least one evidence item with a `sha256`.
5. `coverage.sources_unexamined` is a list, not a count, so the gap is inspectable.
6. The digest covers content only. `subject.acquired_at` and `scan.latency_ms` are recorded in the
   artifact but excluded from the digest, and `manifest.digest_excludes` lists them so a consumer can
   recompute the id from the artifact and get the same value.

## 6. Delta — `context-engine/delta/v1`

```json
{
  "schema": "context-engine/delta/v1",
  "from_snapshot": "snap-…",
  "to_snapshot": "snap-…",
  "source_digest_before": "sha256:…",
  "source_digest_after": "sha256:…",
  "sources": {
    "added": [{ "source_id": "src/backfill.js", "sha256": "…" }],
    "changed": [{ "source_id": "src/retention.js", "before_sha256": "…", "sha256": "…" }],
    "removed": [{ "source_id": "notes/LEGACY-RETENTION.md", "sha256": "…" }],
    "unchanged": [{ "source_id": "README.md", "sha256": "…" }]
  },
  "rescanned": ["src/backfill.js", "src/retention.js"],
  "operations": [
    { "op": "preserved", "target": "invariant", "text": "…" },
    { "op": "stale", "target": "decision", "text": "…", "why": "source_changed" },
    { "op": "invalidated", "target": "decision", "text": "…", "why": "source_removed" },
    { "op": "modified", "target": "src/retention.js", "before_sha256": "…", "sha256": "…" }
  ],
  "counts": {
    "sources_added": 1, "sources_changed": 3, "sources_removed": 1, "sources_unchanged": 7,
    "findings_preserved": 26, "findings_stale": 1, "findings_invalidated": 2,
    "findings_added": 1, "findings_updated": 1, "calls": 1, "rescan_files": 4
  },
  "verification": {
    "preserved_identical": true,
    "stale_retained": true,
    "invalidated_retained": true,
    "unchanged_sources_rescanned": 0,
    "notes": ["…"]
  },
  "digest": "sha256:…"
}
```

`preserved_identical` is computed by text comparison against the prior snapshot, not asserted by the
writer. `unchanged_sources_rescanned` must be 0.

## 7. Pack — `context-engine/pack/v1`

```json
{
  "schema": "context-engine/pack/v1",
  "pack_id": "pack-…",
  "profile": "medium",
  "budget_tokens_estimate": 4000,
  "used_tokens_estimate": 3242,
  "subject": { "root": "poc-repo", "snapshot_id": "snap-…", "source_digest": "sha256:…", "authoritative_source": "the source tree, not this pack" },
  "sections": {
    "invariants": [{ "id": "invariants:…", "text": "…", "sources": [{ "path": "src/store.js", "line": 5, "quote": "…", "sha256": "…" }] }],
    "current_state": [], "outstanding": [], "architecture": [], "dependencies": [],
    "decisions": [], "failures": [],
    "contradictions": [{ "id": "contradictions:…", "text": "…", "caveat": "unresolved", "contradiction": true,
      "sources": [{ "path": "docs/ARCHITECTURE.md", "line": 14, "quote": "…", "sha256": "…" },
                   { "path": "config/defaults.json", "line": 3, "quote": "…", "sha256": "…" }] }],
    "questions": [], "inferences": []
  },
  "source_index": [{ "path": "src/store.js", "line": 5, "quote": "…", "sha256": "…" }],
  "omissions": [{ "id": "…", "section": "inferences", "priority": 8, "text": "…", "sources": ["…"], "reason": "budget" }],
  "coverage": { "items_total": 40, "items_included": 15, "items_omitted": 25, "citation_coverage": 0.73, "sources_cited": 8, "sources_total": 11 },
  "reconstructible": true,
  "disclaimer": "Selected context, not complete source truth. Omitted items remain listed with their source references.",
  "digest": "sha256:…"
}
```

Invariants: whole items only (no truncation of text), every omission carries its sources, `reconstructible`
is false if any retained non-question item lacks a source reference, and `coverage.items_total` includes
omitted items. Contradictions are carried as their own section, labelled `unresolved`, with the citations
for **both** sides — a one-sided account of a disputed value is not a valid pack.

## 8. Instrumentation — `context-engine/instrumentation/v1` (JSONL)

One row per provider call:

```json
{
  "schema": "context-engine/instrumentation/v1",
  "at": "2026-11-20T…Z",
  "model": "glm-flash-latest",
  "requested_model": "~z-ai/glm-flash-latest",
  "resolved_model": "z-ai/glm-5.3-flash",
  "upstream_provider": "Z.AI",
  "generation_id": "gen-…",
  "input_tokens": 8123,
  "output_tokens": 1402,
  "cost_usd": 0.000434,
  "cost_source": "provider",
  "catalogue_cost_usd": 0.000434,
  "latency_ms": 4210,
  "partition": "p001",
  "partitions_total": 1,
  "sources_examined": 11,
  "sources_total": 11,
  "findings": 24,
  "quotes_checked": 24,
  "quotes_failed": 0,
  "provider_kind": "openai-compatible",
  "model_slug": "glm-flash-latest",
  "failed": false
}
```

`cost_source`: `provider`, `catalogue`, `absent`, `not_applicable` (stub), or `mixed_or_catalogue` in a
summary. `null` means not reported; it never means zero.

## 9. Fixture ground truth — `context-engine/ground-truth/v1`

Lives with the fixture, not with results. `facts` are checkable in the source; `model_only` facts are those
a line-rule scanner is not expected to find and are reported separately; `questions` require more than one
file; `traps` are statements the source does not support, used to detect fabricated answers.

## 10. Spend ledger — `context-engine/spend-ledger/v1` (JSONL)

Append-only, written by `src/guard.js`, one row per event. It is the enforcement record, not a report: a
fresh process reads it to decide whether it may spend.

```json
{"schema":"context-engine/spend-ledger/v1","event":"attempt_opened","run_id":"run-2026-11-21-a","attempt":1,"purpose":"poc:live","authorized_usd":0.05,"authorize_retry":null,"prior_spend_usd":0,"at":"…"}
{"schema":"context-engine/spend-ledger/v1","event":"call","run_id":"run-2026-11-21-a","attempt":1,"model":"~z-ai/glm-flash-latest","input_tokens":2466,"output_tokens":3360,"cost_usd":0.000721812,"generation_id":"gen-…","at":"…"}
{"schema":"context-engine/spend-ledger/v1","event":"attempt_closed","run_id":"run-2026-11-21-a","attempt":1,"outcome":"completed","calls":3,"spent_usd":0.00136493,"at":"…"}
```

Events: `attempt_opened`, `call`, `call_refused`, `attempt_closed`. A `call` row is written before the
payload is interpreted, because a truncated response is still paid for. `attempt_opened` for a run id that
already has one is refused and produces no row.

## 11. Support check — `context-engine/support-check/v1`

```json
{
  "schema": "context-engine/support-check/v1",
  "snapshot_id": "snap-…",
  "observations": { "total": 21, "supported": 18, "unsupported": 3, "no_evidence": 0, "flag_counts": { "number_not_in_quote": 2, "negation_not_in_quote": 1 } },
  "contradictions": { "total": 1, "supported": 1 },
  "verified_conclusions": { "total": 15, "supported": 13 },
  "note": "Mechanical checks only. A flagged finding may still be correct."
}
```

Flags: `number_not_in_quote`, `identifier_not_in_quote` (path citations are satisfied by `source_id`),
`negation_not_in_quote`, `negation_only_in_quote`, `no_evidence`. A support result never rewrites
`verification`; it is reported next to it.
