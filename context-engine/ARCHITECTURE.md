# Architecture

## 1. Shape

```
                    ┌──────────────────────────── read-only ────────────────────────────┐
 subject tree ──→ acquire ──→ partition ──→ scan ──→ verify ──→ aggregate ──→ snapshot
                    │            │            │                                │
                 hashes        budget +     provider                        pack ──→ agent
                 mtimes        cross-refs   (stub/live)                        │
                    │                                                          └──→ delta ──→ snapshot v+1
                    └────────────────────── source stays authoritative ─────────────────────┘
```

Only `acquire` touches the filesystem for reading. Nothing in `src/` writes to the subject.

## 2. Components

| Module | Responsibility | Explicitly not its job |
| --- | --- | --- |
| `source.js` | Walk the tree, hash bytes, record kind/mtime/lines, account for skips | Decide relevance |
| `partition.js` | Group files under a token budget; split only oversized files; index cross-file references before scanning | Infer relationships semantically |
| `budget.js` | Derive the single-pass budget from model context, safety ratio, output reserve, operator ceiling | Estimate cost |
| `providers.js` | Translate a request to a provider, return payload + reported usage + resolved model | Judge the payload |
| `scan.js` | Build the scanning prompt, normalise the payload, attach verification | Repair invalid output |
| `validate.js` | Check each quote against the named source; report ambiguity and failures | Decide truth |
| `aggregate.js` | Merge duplicates across partitions, mark cross-partition edges, detect numeric conflicts, count unexamined sources | Promote inferences |
| `snapshot.js` | Build the seven-section artifact and its content digest | Mix model text into `source_facts` |
| `differential.js` | Classify source changes, rescan only changed files, carry forward and revalidate the rest | Rebuild everything |
| `compact.js` | Select whole items by priority under a budget, list omissions with sources | Rewrite or paraphrase |
| `instrument.js` | Record one row per call: model, resolved model, upstream, tokens, cost source, latency | Sum nulls as zero |
| `pipeline.js` | Compose the above into `scanProject`, `updateProject`, `pack` | Add policy of its own |
| `guard.js` | Authorise one paid attempt per run id; refuse a retry without a distinct authorisation; write the ledger | Decide how much may be spent |
| `support.js` | Check that numbers, identifiers and negation in a finding come from its quote | Adjudicate whether the claim is true |

One dependency crosses the module boundary: `digest`/`stableStringify` from the repository's
`src/canonical.js`. It is reused rather than duplicated so snapshot ids are comparable with the rest of the
repository. No other file outside `context-engine/` is imported.

## 3. Data flow, step by step

1. **Acquire.** Every regular file under the root is read unless excluded, binary, too large, a symlink, or
   over the file limit. Each skip is recorded with a reason. `source_id` is the POSIX-relative path;
   `sha256` covers the text.
2. **Budget.** `usable = floor(context × safety_ratio) − output_reserve`; `ceiling = min(hard_ceiling,
   usable)`; requested values are clamped to the ceiling.
3. **Partition.** Files are packed in path order up to the budget. A file alone above the budget is split
   by lines and the split is recorded. Imports, Markdown links and path mentions are resolved against the
   acquisition to produce cross-partition edges before any model sees the text.
4. **Scan.** One call per partition. The prompt carries source ids, line numbers, the schema, and any
   cross-file references relevant to the partition. The model is told that source text is data and that
   unlabelled certainty is treated as inferred.
5. **Verify.** For each finding, each citation is looked up in the named source. Exact substring match;
   optional line disambiguates repeated quotes; more than one occurrence without a line becomes
   `ambiguous_locator`. Nothing is rewritten.
6. **Aggregate.** Findings merge by `kind + normalised text`; evidence is unioned; certainty is never
   upgraded. Relationships merge by `from|to|type`. Numeric `key = value` disagreements across quotes become
   contradiction candidates. Sources with no citation are reported as `unexamined`.
7. **Snapshot.** Seven sections, listed in §4, plus coverage, contradictions and a content digest.
8. **Pack.** Whole items, priority order, budget with a reserved slice for the source index. Every dropped
   item is listed with its references.
9. **Differential.** Compare hashes; classify added/changed/removed/unchanged; rescan added+changed only;
   carry the rest; re-resolve every carried quote; mark `stale` or `invalidated`; emit delta + snapshot v+1
   with lineage.

## 4. Why the sections are separate

| Section | Source | May be treated as fact? |
| --- | --- | --- |
| `source_facts` | disk | **Yes** — path, hash, size, mtime |
| `observations` | model | Only with its verification status |
| `verified_conclusions` | model, citation resolved, labelled `stated` | As *citation-verified*, not truth-adjudicated |
| `inferences` | model, `derived`/`inferred` or failed citation | No |
| `questions` | model/material | No — they are open |
| `historical_state` | prior snapshot | Only as history |
| `current_state` | findings of kind state/outstanding/risk | Only via their observations |

The failure mode this prevents: a plausible sentence produced by a model becoming indistinguishable from a
line read from disk. Merging the sections is the whole bug; keeping them apart is the design.

## 5. Verification states

| Status | Meaning | Enters conclusions? |
| --- | --- | --- |
| `citation_verified` | Every quote resolves in its named source | Yes, if `stated` and kind is concludable |
| `quote_not_found` | At least one quote does not occur in the source | No |
| `source_unknown` | A citation names a file not in the acquisition | No |
| `no_citation` | The finding carries no citation | No |

`flagged[]` keeps the reason and the offending quote. A rejected citation is evidence about the model, so it
is preserved rather than deleted.

## 6. Budget and partitioning

```
context 1,048,576
safety ratio 0.75          → 786,432
output reserve 4,000       → usable 782,432
operator ceiling 400,000   → budget 400,000   (source: model_context)
```

- `source` is one of `model_context`, `requested`, `requested_clamped`, `fallback`.
- A request above the ceiling is clamped **and** recorded in `notes`; the run reports `requested_clamped`.
- No declared context (stub) → `fallback` 60,000, never an invented window.
- Strategy is explicit: `single_pass` when the acquisition estimate fits, `partitioned` otherwise, with the
  reason carrying both numbers.
- Estimates are `ceil(chars/4)`. They decide partitioning and nothing else.

Partitioning does not silently sever relationships: cross-partition references are computed before scanning,
passed into the relevant prompts, marked `cross_partition` in the aggregated relationships, and counted in
coverage.

## 7. Differential states

| State | Condition | Effect |
| --- | --- | --- |
| `preserved` | Every cited source byte-identical, every quote still resolves | Carried into conclusions and packs |
| `stale` | A cited source changed, or a quote no longer resolves | Retained in observations; excluded from conclusions |
| `invalidated` | A cited source was removed | Retained with its reason; excluded from conclusions |
| new | Not present before | Added and verified normally |

`delta.verification.preserved_identical` is computed by comparing carried text with the prior snapshot's
text, not asserted. `unchanged_sources_rescanned` must be zero; the rescan set is derived from hashes.

## 8. Compaction

Priority order (whole items only):

```
1 invariants/instructions       5 failures, risks and contradictions
2 current state / outstanding   6 open questions
3 architecture / dependencies   7 (reserved: source index)
4 decisions                     8 inferences, labelled, last
```

Profiles: `small` 1,500 tokens, `medium` 4,000, `large` 10,000; 15–20% reserved for the source index so
every retained item can be followed back. Items that do not fit are written to `omissions[]` with their
source refs. `reconstructible` is true only when every retained item has a resolvable reference.

A contradiction is carried as its own item at priority 5 with `caveat: "unresolved"` and the citations for
**both** sides. It is never merged into `current_state`, never ranked, and never presented with one side as
settled: a pack that carries only the side that fits is worse than a pack that omits the item and says so.
If a contradiction cannot fit, it is listed in `omissions[]` with those same two references.

## 9. Failure handling

| Failure | Behaviour |
| --- | --- |
| Provider error / HTTP failure | Call recorded as failed; scan continues with other partitions; problem surfaced |
| Payload not JSON or wrong shape | Findings skipped with a `payload_not_object` / `findings_not_array` problem |
| Unknown kind | Mapped to `reference` with `unknown_kind` recorded |
| Missing certainty | Treated as `inferred`, recorded |
| Quote not found | Finding kept, flagged, excluded from conclusions |
| Budget exceeded | Call refused before request; error names spent/ceiling |
| Usage absent | Tokens and cost `null`, `cost_source: 'absent'`; summary says the total is incomplete |
| Provider returns no charge | Catalogue product recorded with `cost_source: 'catalogue'` |
| Paid provider built without a guard | Refused at construction; no request is made |
| Retry on an already-open run id | Refused before the request; refusal row written to the ledger |
| Ledger unwritable | Refused; spending stops rather than proceeding unrecorded |

## 10. Extension points

- **New model**: add an entry to `models.json` (slug, context, price). No code change.
- **New provider dialect**: implement `complete({system,user,maxTokens,meta})` returning
  `{payload, usage, provider, latency_ms, problems}`; the pipeline is unchanged.
- **New partition policy**: pass `partitionPolicy` or edit the registry block; the derivation and notes are
  shared.
- **New artifact consumer**: the snapshot is versioned and digest-addressed; consumers should refuse an
  unknown `schema`.

## 11. Non-goals

No daemon, database, queue, auth layer or deployment. No mutation of the subject. No folding of results into
the frozen GCA/RDA baseline. No claim of completeness from a pack.
