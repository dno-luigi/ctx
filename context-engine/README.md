# Context Engine (GCA/RDA)

**Status:** implemented and verified offline; **first live scan run 2026-11-20** on GLM Flash Latest, recorded
in [LIVE-SCAN-01.md](LIVE-SCAN-01.md). Two runs, 7 of 8 gates each, **different gates failed** (H2 then H4),
so the hypothesis is **not supported on this fixture** under the rules as written. The thresholds were not
changed afterwards. After carrying contradictions into the pack, a QA re-check (no rescan) reached 5/6
attribution and q6 became answerable; that is recorded separately, not retrofitted into run 2.

**H4 now passes** on the contradiction-bearing pack at the pre-registered 5/6 bar (attribution 0.833,
reconstruction 0.833, 0 traps). All eight gates have therefore been observed passing at least once, but
**never together in one run**, and the failing gate moved between the two live runs. The consolidated gate
matrix, spend ledger, open gaps and the pre-registration for the next measurement are in
[POC-RESULT.md](POC-RESULT.md).

---

## 1. Purpose

An agent that works longer than its window is usually given a **summary** of what it lost. Summaries are
compressed once, by the same process that is about to be truncated, and their errors are not recoverable:
a dropped constraint looks exactly like a constraint that never existed.

This engine takes the opposite approach.

> When the context limit approaches, do not summarise harder. Re-read the complete source with an
> inexpensive model, verify what it reports against the bytes, and carry a structured, source-addressed
> representation forward.

The representation is not prose. It separates what the source **says** from what a model **inferred**,
keeps every finding attached to a verbatim quote and a file hash, and records what it did not examine.
When the source changes, only the changed material is rescanned; unchanged findings are carried forward
and re-checked, not regenerated.

The governing principle:

> Preserve complete source truth while making working context inexpensive to reconstruct, update, verify
> and compact.

This is **not** a summarisation tool. A summary replaces the source; this keeps the source authoritative
and makes the derived context cheap to discard and rebuild.

## 2. What it is not

- Not a decision engine. It never recommends, approves or ranks actions.
- Not a writer. It reads the subject tree and writes only to its own output/example paths.
- Not a truth oracle. `citation_verified` means the quote resolves in the bytes; it does not mean the
  statement is correct or that the source is right.
- Not a replacement for GCA/RDA. It shares the repository's canonical digest and provider discipline; it
  does not import or alter the frozen GCA/RDA baseline.

## 3. How it works

```
acquire ──→ partition ──→ scan (cheap model) ──→ verify quotes ──→ aggregate ──→ snapshot
                                                                                   │
                                                        pack (budgeted) ←──────────┤
                                                                                   │
source changes ──→ diff ──→ rescan changed only ──→ carry forward ──→ delta + new snapshot
```

Five guarantees that are enforced in code, not in prose:

| Guarantee | Where |
| --- | --- |
| Quotes are checked against the bytes; failures are quarantined, never repaired | `src/validate.js` |
| A model's unlabelled claim is treated as `inferred`, not `stated` | `src/scan.js` |
| Unchanged findings are carried forward only if their cited sources are byte-identical | `src/differential.js` |
| A pack lists every omitted item with its source references | `src/compact.js` |
| Cost is provider-reported or `null`; it is never estimated | `src/providers.js`, `src/instrument.js` |

## 4. Quick start

Offline (deterministic, $0):

```bash
node context-engine/poc/run-poc.js
node context-engine/tests/budget.test.js
```

The PoC acquires `fixtures/poc-repo`, scans it, builds three pack sizes, answers six cross-file questions
from the pack only, applies a declared change set to a temporary copy, runs a differential scan, and
writes the artifacts to `context-engine/examples/`.

Live (paid, explicit budget, GLM Flash Latest by default):

```bash
node context-engine/poc/run-poc.js \
  --provider live --model glm-flash-latest --budget-usd 0.05 --qa model
```

Nothing spends money without `--budget-usd`; the provider adapter refuses before the first call if the
budget is absent or already exhausted.

## 5. Model selection and economics

| id | slug | input | output | context |
| --- | --- | --- | --- | --- |
| `glm-flash-latest` (default) | `~z-ai/glm-flash-latest` | $0.0399/M | $0.0784/M | 1.05M |
| `glm-5.3-flash` | `z-ai/glm-5.3-flash` | $0.0399/M | $0.0784/M | 1.05M |
| `glm-4.7-flash` | `z-ai/glm-4.7-flash` | $0.0605/M | $0.40/M | 200k |
| `glm-4.5-air` | `z-ai/glm-4.5-air` | $0.13/M | $0.85/M | 131k |

The default is the moving alias, per operator decision. Because it redirects, each call records the
response's resolved model id (`resolved_model`) next to the requested slug, so two runs cannot be confused
after the alias moves. A pinned id remains available for reproducing an old result.

**Single-pass budget.** Derived from the model window, capped by policy:

```
usable  = floor(context × 0.75) − 4000 output reserve      → 782,432 for GLM Flash
ceiling = min(400,000 operator cap, usable)                → 400,000
budget  = ceiling unless --partition-tokens is lower
```

A request above the ceiling is clamped **and reported**; it is never silently ignored. A model with no
declared context (the stub) falls back to 60,000. Longer subjects partition at the budget, and every file
split and cross-partition reference is recorded. See [ARCHITECTURE.md](ARCHITECTURE.md) §6.

## 6. Layout

```
context-engine/
  README.md            this file
  ARCHITECTURE.md      components, data flow, budget, boundaries
  SCHEMA.md            artifact and payload schemas
  PROTOCOL.md          normative scan / reconcile / compact rules
  EVALUATION.md        metrics, fixtures, pre-registered live-scan thresholds
  POC-RESULT.md        consolidated gate matrix, spend ledger, open gaps, next-run pre-registration
  models.json          configurable model registry + partition policy
  src/                 source, partition, budget, providers, scan, validate,
                       aggregate, snapshot, differential, compact, instrument, pipeline
  poc/                 run-poc, apply-delta, pack-only QA and scoring
  fixtures/            poc-repo, its ground truth, and the delta change set
  examples/            generated snapshot, packs, delta, instrumentation, report
  tests/               budget unit tests
```

## 7. Current evidence, stated precisely

Offline, repeatable, $0:

```
budget tests                                   16/16
PoC structural checks                          25/25
stub: line-rule facts 8/8 · model-only 0/2
```

First live run (GLM Flash Latest → `glm-5.3-flash` at Wafer), $0.0024 including one failed attempt:

```
findings 20 · citations verified 20/20 · contradictions 1 · coverage 11/11
QA retention 0.833 · attribution 0.833 · reconstruction 0.833 · traps 0
differential: preserved 15 · stale 4 · invalidated 1 · added 14 · preserved_identical true
gates: H1 H3 H4 H5 H6 H7 H8 pass · H2 fail (model-only facts 0/2 in observations)
```

The stub is a line-rule scanner: its numbers show the pipeline is coherent, not that a model scans well. The
live contradiction was found and verified, but the timeout value was not emitted as a standalone
observation — hence H2's strict fail. See [LIVE-SCAN-01.md](LIVE-SCAN-01.md) §2 and §7.

Second live run, single attempt (same model, same subject), $0.00136493:

```
findings 21 · citations verified 21/21 · contradictions 1 · model-only facts 2/2
QA retention 0.833 · attribution 0.667 · reconstruction 0.667 · traps 0
differential: preserved 14 · stale 6 · invalidated 1 · added 14 · preserved_identical true
gates: H1 H2 H3 H5 H6 H7 H8 pass · H4 fail (q3 attribution, q6 not_in_pack)
```

QA re-check on the rebuilt pack, one call, $0.000180414, **no rescan**:

```
pack 2,989/4,000 tokens · 30/30 items · 1 contradiction (unresolved, both sides cited) · 0 omissions
retention 1.000 · attribution 0.833 · reconstruction 0.833 · traps 0 · q6 answered
gates: H4 pass · q3 remains the only miss (correct answer, cites README + ARCHITECTURE, not src/ingest.js)
```

Offline checks re-run for the consolidated record: budget 16/16, compaction 11/11, PoC structural 25/25.

## 8. Known limitations

- **Planning estimates are not measurements.** `ceil(chars/4)` decides partitioning; only provider-reported
  usage produces cost.
- **Quote verification is not truth adjudication.** A false statement with an accurate quote passes.
- **A quote may resolve more than once.** It is marked `ambiguous_locator` rather than assigned an offset
  by guesswork.
- **The PoC subject is one small repo (11 files).** Ground truth covers it; generalisation is untested.
- **Compaction is not a proof of sufficiency.** It reports what it omitted; it cannot know what the agent
  will need.
- **No transport hardening.** Same process, single writer, no auth, no rate limiting, no schema negotiation.
- **The test suite is partial.** Budgeting has unit tests; pipeline behaviour is exercised by the PoC's
  structural checks rather than a full integration/regression suite.
- **A live scan will produce model findings that the stub cannot.** No claim about quality is made until
  that run exists.

## 9. Relation to the existing work

The repository already contains the GCA/RDA decision pilot and the ARA/AA information architecture. This
engine reuses two conventions only: the canonical digest (`src/canonical.js`) and the adapter rule that a
provider translates fields but never semantics. It does not read or modify the frozen baseline, thresholds,
fixtures, scoring rules or historical records, and no result here may be folded into them.
