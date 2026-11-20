# PILOT-FREEZE-01 — preparation state frozen

**Date:** 2026-11-18 · **Cost:** $0 · **Authorisation:** preparation state closed. No live-agent run authorised.

## What this freeze covers

Everything needed to run H1 and H2 *except* a live agent, frozen with digests in
`runs/frozen/pilot-prep/manifest.json`:

- the five measurement instruments (usage capture, contract test, scorer, blind packets, dry-run checker);
- the five H1 patch fixtures with their validated oracles;
- the three H2 fixture files (plants, checkpoints, gold edges);
- the frozen adjudication protocol and the claims-eligibility declaration;
- the two preparation audits and the synthetic dry-run transcripts with hand-computed expectations.

`runs/frozen/card-gen-01/` remains frozen separately and is not touched by this record.

## Standing rules (in force from here)

1. **No criterion is weakened to make a pilot runnable.** If a measurement cannot be taken, the
   criterion is excluded from the claim — not estimated, not proxied, not dropped silently.
2. **P2/Q2 and P4/Q5 must be independently satisfied or explicitly excluded.** Encoded per criterion
   in `pilot/claims-eligibility.json`; currently P2, Q2, P4, Q5 are **ineligible** and Q3 is
   **partially eligible** (12 of 14 plants).
3. **An ineligible criterion never becomes a silent zero.** It is reported as EXCLUDED with its
   blocker named.
4. **The two adjudicated H2 plants are never folded into a 14/14 figure.** They are reported separately.
5. **The author of a fixture may not adjudicate it.** If no independent reviewer exists, the
   measurement is reported as self-adjudicated and no claim may rest on it.
6. **Instrument changes after the freeze are deviations.** They invalidate runs taken before the
   change and must be logged, not quietly re-hashed.

## What was repaired before freezing

| Defect | How it was found | Effect had it shipped |
| --- | --- | --- |
| `selftest:decisions` passes on a renamed request field | C1 passed while patched | an interface break would score as a successful arm |
| Scorer credited an edge when *either* endpoint appeared | synthetic control arm, which never opened `spans.js`, scored as recalling the dependency | the control arm would be flattered on P3/Q4 |
| `object_text` state compared as a string | contract test failed on clean code | false alarm on the adapter boundary |
| Exit code read from `tail` instead of the test | verification output | a failing check could report as passing |

Three of the four were caught by the measurement system examining itself, before any pilot data
existed. That is the point of this phase, and it is the strongest result so far — it is a
methodological result, not evidence about either hypothesis.

## What is established

- The bridge experiment's result is frozen (`CARD-GEN-01`), including the flat 30/30 conversion through
  all six stages and the single word-number miss.
- Five H1 patches apply deterministically, each oracle fails while patched, every tree restores hash-clean.
- H2's fixtures are complete and independent of H1.
- The measurement path runs end to end on known answers and separates the arms on 7 of 7 metrics.
- Two criteria are known to be unclaimable, and that is declared before runs rather than discovered
  during analysis.

## What is not established

- That either pilot will produce a positive result.
- That treatment helps an agent at all.
- That compaction occurs at the checkpoint, that pre-boundary context is inaccessible, that budgets are
  enforced equally, or that file-access restrictions hold. **All four require live agents and remain
  unverified.**
- That P2/Q2 or P4/Q5 can be measured in practice.

Nothing in this document may be cited as a pilot result. The dry run is synthetic and labelled so in
the tool output, the fixtures and the audit.

## The next authorisation boundary

Live-agent execution, and only when:

1. a runtime reports usage per run (input, output, cached input, tool-context), so P2/Q2 have denominators;
2. an independent adjudicator is named, or P4/Q5 and the two adjudicated plants are formally excluded;
3. the four unverified live-run properties are checked on one fixture per arm;
4. both pre-registrations are re-read against the above and confirmed unchanged.

Until all four hold, the answer to "do these pilots work?" is **not yet measured** — which is a
different statement from "no effect", and the difference is the whole reason this phase existed.

## Verification

```
node tools/patch-check.js --apply          → 5 applicable, 5 oracles fail, all restored
node tools/contract-test.js                → exit 0 clean / exit 1 patched
node tools/dryrun-check.js                 → 32/32 (synthetic)
node tools/usage-capture.js --selftest     → 19/19
node tools/blind-packet.js --selftest      → 9/9
node tools/score-transcript.js --selftest  → 17/17
npm run selftest / selftest:decisions / selftest:inventory → 52/52, 40/40, 39/39
```
