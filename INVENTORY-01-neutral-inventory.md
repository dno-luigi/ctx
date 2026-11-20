# INVENTORY-01 — R-a: rule-based neutral inventory

Status: built and calibrated offline, uncommitted. Authorised as a **separate
experimental component**. D0 is unchanged, the decision adapter is unchanged, the
generative path is unchanged, and the frozen 52-check baseline still reports 52.

---

## 1. What it is

An independent reference instrument that reads source material and proposes
candidate structure. It answers no question, ranks nothing, and decides nothing.

| Constraint given | How it is enforced |
|---|---|
| No model-generated input | the scanner takes only a `gca-input`; it has no model id, client or response in scope |
| No dependency on decision-model outputs | `inventory/scan.js` imports exactly two modules: its own corpus reader and the frozen span resolver. A self-test asserts the import list |
| No invented evidence | every item carries spans built from source slices, and `verifySpans` re-derives each one through `locate()`; a span that does not match its quote fails the suite |
| No automatic promotion into accepted cards | there is no import path to `snapshot/`; the scanner cannot construct a card, and items carry no `oid`, `claim` or `confidence` |
| Distinguishable from model proposals | items carry `origin: 'inventory'` and a `rule`; proposals carry their own origin and schema; `compare.js` reports both sets side by side and never concatenates them |

## 2. Rules, and what each one can see

| Rule | Kind | Basis |
|---|---|---|
| `version_literal`, `qualified_identifier`, `code_span`, `proper_noun_phrase`, `acronym` | entity | lexical shape |
| `repeated_phrase` | entity | a bigram repeated ≥2× in the corpus — the only way lowercase names like "billing service" become visible |
| `dependency_phrase` | relationship | an explicit cue ("depends on", "requires", "blocks", "replaces") with the two named chunks |
| `shared_sentence` | relationship | two names in one sentence |
| `shared_entity_across_sources` | cross_source_reference | one name, ≥2 sources |
| `numeric_attribute_conflict` | contradiction_candidate | two sources, same subject, shared content terms, disjoint numbers |
| `unresolved_cue` | unresolved_proposition | "?", "pending", "unclear", "may", "not yet", … |
| `normative_without_relation` | unclaimed_span | an obligation or dependency sentence no relationship item covers |
| `shared_context_unpaired` | missing_connection | two sources discussing the same subject in the same words without naming the two things together |

Weakest rule: `shared_context_unpaired`. It fires on shared vocabulary, not on
meaning, and it will over-report on corpora where two documents share boilerplate.
The calibration below measures recall, not precision, so this is a stated limitation
rather than a measured one.

## 3. Detection limits, measured

`inventory/calibration.js` plants structure into three small corpora with known
expectations and reports what came back. Current measurement (2026-11-18):

| | |
|---|---|
| planted structures recovered | **10/10** (recall 1.0) |
| recall per kind | 1.0 for entity, relationship, cross_source_reference, contradiction_candidate, unresolved_proposition, unclaimed_span, missing_connection |
| spans checked / failures | **37 / 0** — every emitted span re-derived exactly |
| items not matching a planted expectation | **6** (4 entity, 2 cross_source_reference) |
| precision | **not measured** |

Precision is deliberately not reported. The corpora contain unplanted material, so an
item that matches no expectation is a candidate discovery, not a false positive;
scoring it as one would manufacture a number. A fully labelled corpus would be needed,
and none exists.

The limit that matters: **recall is known only for structures that were planted.**
Recall on unlabelled, real material is unknown. A reference instrument whose misses are
unmeasured cannot be treated as ground truth, which is why the output carries
`ground_truth: false` in every result rather than relying on the reader to remember.

## 4. The calibration earned its cost immediately

Two instrument defects were found by writing the calibration alongside the scanner, not
by reading the code:

1. **Tokenisation kept sentence-final periods.** "seconds" in one source and "seconds."
   in the other were different tokens, so every cross-source rule silently
   under-counted. Planted `missing_connection` recall was 0 until fixed.
2. **Articles were treated as part of a name.** "The Billing Cache" and "Billing Cache"
   produced different entity keys, so a name mentioned with an article in one source
   never linked to its other mention.

Both were invisible in the code and obvious in the recall table. That is the argument
for building the measurement with the instrument.

A third, more consequential gap was found and is *not* a bug: lexical patterns alone
miss lowercase technical names entirely, so the first draft detected no relationships in
ordinary prose. That is why `repeated_phrase` and `dependency_phrase` exist. Without
them the inventory would have reported high confidence on capitalised headings and
nothing else.

## 5. Comparing the two candidate sets

`inventory/compare.js` takes the inventory and the model-derived proposals and reports:

- coverage — inventory items a proposal also cites
- overlap pairs, inventory-only, model-only, span-unlinked proposals
- supported relationships, and those the inventory did not already locate
- incremental cost per additional supported relationship
- unresolved inventory items, separable for adjudication

Matching is **span overlap**, and the output says `agreement: 'unadjudicated'`. Two
instruments citing the same region is a coincidence of location, not a finding that
either is right. Nothing is merged, promoted or scored.

A proposal with no evidence candidates (a disambiguation question) cannot be span-linked
at all. It is counted as `unlinked`, never guessed into an overlap.

## 6. Not done

- **Not wired into expansion.** `snapshot/expand.js` still reports
  `expansion_sources.inventory: absent`; nothing supplies it. Connecting the inventory
  as a proposal source changes what expansion measures and is the D0 decision the
  owner reserved. `compare.js` is the only bridge, and it merges nothing.
- **No operator document.** The instrument has been run over all 16 text fixtures (§8), but
  not over any real operator material, so nothing here is evidence about prose it was not
  calibrated or tuned near.
- **No precision, no adjudication.** Both need labelled data and a human.
- **No cost.** The inventory is free by construction, which is exactly why its
  comparison against a paid engine is the interesting measurement.

## 7. Verification

`npm run selftest:inventory` → 39 checks, exit 0.
`npm run selftest:decisions` → 40 checks, exit 0 (39 before the live contract probe, which
falsified the recorded `locate` claim; see `LIVE-RUN-01.md` §1).
`npm run selftest` → 52 checks, exit 0, unchanged.
`npm run inventory:run` → all 16 text fixtures, 0 span failures, exit 0.

## 8. Measured over the real fixtures (2026-11-18)

`npm run inventory:run` writes `runs/inventory/inventory-run.json`. F4 is skipped because it is
image-only, which is correct for a text instrument rather than a gap.

| | |
| --- | --- |
| fixtures scanned | 16 |
| characters | 252,656 |
| items | 333 |
| span failures | 0 — every emitted span re-derived through the frozen resolver |
| required items, post hoc | 26 |
| covered by any overlapping item | 19 (0.731) |
| covered by a **point-scoped** item | 18 (0.692) |
| items per required item | 12.81 |
| precision | unmeasured |

Bare overlap overstates coverage, because a `shared_sentence` relationship item carries the whole
sentence as its primary span and therefore overlaps any quote inside it. Excluding sentence-scoped
rules (`shared_sentence`, `unclaimed_span`, `unresolved_cue`) gives 0.692; that is the number to
quote, and the runner reports both.

### Detection limits this run actually exhibited

1. **Yield does not respond to context size.** F2a–F2d are 62,250 characters each and produce the
   same 66 items as each other, because they are eight paragraphs repeated and the scanner
   deduplicates by entity key. A 62 kB context is indistinguishable from a 2 kB one in this
   instrument's output.
2. **Key–value records are invisible.** F6b: **0/3** required items. `status: in review`,
   `assignee: R. Okonjo` and a proper-noun-free prose sentence match no rule;
   `proper_noun_phrase` does not match `R. Okonjo`.
3. **Unique numeric facts are invisible.** F9: 1/2. The retry line has no capitalised name, no
   identifier and no repeated bigram, so no rule fires on it. The offset line is found only
   because "committed offset" and "consumer group" recur elsewhere.
4. **83% of yield is combinatorial.** `shared_sentence` (45.3%) and `repeated_phrase` (37.8%)
   both scale with names-per-sentence and with repetition, so a repetitive document looks richer
   than a dense one.
5. **`shared_context_unpaired` stayed quiet** (4 items, 1.2%), but F2a–F2d suppress it by
   repetition, so this is not evidence that the rule is well-behaved on varied prose.

None of this changes the component's independence: it still imports only `./corpus.js` and the
frozen span resolver, still takes no model output, and is still not wired into expansion.
