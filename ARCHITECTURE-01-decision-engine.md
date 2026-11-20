# ARCHITECTURE-01 — ScaleDown as a decision engine

Status: adapter and expansion implemented, offline, uncommitted. No model called,
nothing charged. The generative path (`run.js`, `src/*`, thresholds, fixtures) is
untouched; its self-test still reports 52 checks passing.

---

## 1. Settled: one additional decision pass

`snapshot/expand.js` exports `MAX_PASSES = 1` and `planSecondPass` **throws** above
it. Recursion is refused by the code, not by convention, so a recursive expansion
cannot be introduced by passing a larger number. The reason is measurable cost and
completeness: a feedback loop turns both into moving targets before either is
measured once.

## 2. The adjustment the interface forces

A closed-set engine answers questions; it cannot write a proposal. So expansion is
inverted:

```
native decision outputs  →  harness rules derive candidate proposals
                         →  one additional decision pass asks about each
                         →  verdict per proposal (supported / unsupported / indeterminate)
```

The engine still decides what survives; the harness names the candidates. The
proposal format is harness-owned (`schemas/gca-proposals.v1.json`), which is also
why it is not assumed to be a native provider response.

Rules that derive proposals today:

| origin | source | needs `locate`? |
|---|---|---|
| `unclaimed_locate_span` | spans returned but not cited by any card | yes |
| `low_confidence_choice` | choice confidence inside 0.35–0.70 | no |
| `ambiguous_probability` | P(yes) between 0.4 and 0.6 | no |
| `cross_source_shared_term` | a rare term quoted in two sources, no card relating them | yes |

## 3. The consequence for ScaleDown, stated plainly

`scaledown/classify-1` has **no `locate`** on its decisions surface. Three things
follow, and none of them can be engineered around inside the adapter:

1. Every card it produces is `inferred` — an assertion with no provenance. The
   assembler refuses to give it a quote it did not receive.
2. Proposals that require evidence cannot be validated, only asserted. The report
   counts them in `evidence.proposals_requiring_unavailable_evidence`.
3. Two of the four proposal rules never fire, because there is no quoted evidence to
   relate. Expansion on ScaleDown alone reduces to disambiguating what was already
   asked.

So: ScaleDown can be tested for **conditional accuracy at low cost**, and it cannot
by itself demonstrate **conceptual completeness**. That is exactly decision D0 in
`REVIEW-01-proposal-vs-hypothesis.md`, now with an empirical edge: the engine that
makes the economics work is the one that cannot supply provenance. A neutral
inventory (R-a) or a hybrid pass (R-b) is what would change this, and neither is
approved or built. `expansion_sources.inventory` reads `absent` and the reason is
recorded in every expansion report.

## 4. What the adapter is, and is not

Does: normalise input state, build the request, hand the request to a caller-supplied
transport, normalise and validate the response, preserve the native payload.

Does not: write cards, invent evidence, decide completeness, choose what to display.
Those are `snapshot/` and, later, whatever consumes the snapshot.

Layout matches the requested shape:

```
adapters/decision/interface.js    contract, state building, span mapping, transport
adapters/decision/scaledown.js    ScaleDown dialect (object state, no locate)
adapters/decision/perplexity.js   second provider, proves the seam
adapters/decision/normalize.js    typed validation, usage, problems
adapters/decision/validate.js     bank rule + capability checks, proposal schema check
snapshot/assemble.js              answers → cards, no invented evidence
snapshot/expand.js                proposals, one second pass, metrics
snapshot/validate.js              re-exports the frozen validators; no fork
```

## 5. Native outputs are preserved, not flattened

`normaliseResponse` returns `{ answers, usage, problems, native, question_multiplier }`.
`native` is the provider body verbatim. The three decision forms stay distinct:
`noul` keeps its probability, `choice` keeps its distribution, `score` keeps its
expected value, `locate` keeps both the verified source-relative ref and the raw
unicode span. Improving the assembler later does not require paying for the calls
again.

## 6. Expansion metrics implemented

Proposal count by origin, asked, rejected, truncated, duplicates removed, per-proposal
verdicts, newly supported relationships, additional questions, additional cards,
incremental cost, and incremental cost per supported card.

`incremental_completeness` is **null** with a stated reason. It needs the
model-independent inventory that does not exist, and reporting a number here would
invent the instrument the review says is missing.

## 7. Not implemented, deliberately

- grading the four ungraded GCA requirements (`domains`, `gaps`, `confidence`,
  `checks`) — a grading change needing authorisation and a self-test re-baseline
- the neutral inventory (R-a) that `deriveProposals` accepts but nothing supplies
- wiring the decision path into `run.js`, reports or a budget gate
- any threshold for the decision path (R5 in the review: separate pre-registration)
- persistence of `native` payloads — returned by the adapter, not yet written anywhere

## 8. Verification

`npm run selftest:decisions` → 39 checks, exit 0, all against recorded contract
samples with no network call. `npm run selftest` → 52 checks, exit 0, unchanged.
