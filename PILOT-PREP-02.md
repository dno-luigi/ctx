# PILOT-PREP-02 — C1 repaired, instrumentation frozen, dry run complete

**Date:** 2026-11-18 · **Cost:** $0 (no model calls).
**Authorisation:** preparation only. **No paid run is authorised by this document.**

---

## 1. C1 — the oracle was fixed, not the patch

The mutation was left exactly as it was: `criteria:` → `options:` in both adapters. What changed is
the oracle.

`tools/contract-test.js` asserts the request body at the adapter boundary:

- choice criteria is a **record**, not an array;
- record keys equal their values and equal the option strings;
- the type discriminator survives;
- `noul` questions carry no criteria;
- the state field matches the provider's declared `state_form` (including `object_text`).

| State | `node tools/contract-test.js` |
| --- | --- |
| unmodified tree | **exit 0** — request shape matches the declared contract |
| C1 applied | **exit 1** — choice questions carry no criteria record |

C1 is now **validated**: applicable, oracle fails when patched, working tree restored and verified.
The original failure — patched code passing `selftest:decisions` — is preserved in `C1.json`
(`history[]`) and PILOT-READINESS-01 §2. Nothing was weakened and no claim was substituted.

**The finding stands and is worth carrying:** a suite that passes on a broken contract is not an
oracle for that contract. The decision suite never asserted the request body, so it could not have
caught this class of break in any earlier run.

Two defects in my own contract test were caught before it was trusted: `state_form: 'object_text'`
was being compared as a string, and my exit-code check was reading `tail` rather than the test.

## 2. Instrumentation — frozen

`pilot/instrumentation/manifest.json` — digests of:

| Instrument | What it guarantees |
| --- | --- |
| `tools/usage-capture.js` | inputs, outputs, cached input, tool-context captured **as reported**; null never becomes zero or an estimate; `unavailable[]` lists what the runtime did not supply; `agent_total_tokens` is input+output only; `gca_processing_usd` is a separate field, never added |
| `tools/contract-test.js` | the adapter boundary is asserted, not assumed |
| `tools/score-transcript.js` | six measurements as declared set operations; dependency edges count only when **both** endpoints are reached |
| `tools/blind-packet.js` | adjudication packets with arm, model, tokens, turns and oracle verdict redacted; refuses to emit a packet that still contains one |

Self-tests: usage **19/19**, scorer **17/17**, blind packets **9/9**.

## 3. Adjudication — protocol frozen, reviewer not yet named

`pilot/instrumentation/adjudication-protocol.md`.

- Reviewer sees task, result, source state and evidence available; never the arm.
- Four outcomes: `supported`, `reasonable_but_wrong`, `unsupported`, `indeterminate`.
- **Only `unsupported` counts toward P4/Q5.** A defensible inference that turned out wrong is
  reported separately, because folding it in would punish correct reasoning.
- Second reviewer on a 20% random sample; below 0.80 agreement the set is re-adjudicated by a third
  pass and the disagreement is reported.
- **Independence rule:** an author of the fixtures may not adjudicate. If nobody independent is
  available, the measurement is reported as **self-adjudicated** and no pass criterion depending on it
  may be claimed.

**Blocker:** no independent reviewer has been named. Until one is, P4 and Q5 cannot be claimed.

## 4. H2 plants — kept visibly unequal

14 plants: **12 mechanically checked** in the final diff, **2 adjudicated** (H2-F3, H2-F4). The results
document must report them in two columns. They are never to be presented as fourteen equally verified
items.

## 5. Harness dry run — synthetic, and labelled as such

`tools/dryrun-check.js` — one fixture per arm, hand-authored transcripts, hand-computed expected
scores: **32/32 checks passed.**

| Metric | control | treatment |
| --- | ---: | ---: |
| oracle passed | false | true |
| retrieval recall | 0.50 | 1.00 |
| symbol recall | 0.00 | 0.50 |
| impact accuracy | 0.20 | 0.40 |
| missed dependencies | 1 | 0 |
| repeated work | 2 | 0 |
| unsupported assumptions | 1 | 0 |

Every metric separates the arms except retrieval precision, which is 1 for both because neither read an
irrelevant file. Blinding verified per packet; usage captured without mixing agent tokens and GCA cost.

**This validates the measurement machinery and nothing else.** The transcripts are synthetic. It is not
a pilot result and must not be cited as evidence that either arm helps.

### The five dry-run properties, restated

| Property | Status |
| --- | --- |
| compaction actually occurs | **unverified** — needs a live agent |
| pre-boundary context genuinely inaccessible | **unverified** |
| recovery budgets enforced equally | **unverified** |
| file-access restrictions hold in treatment | **unverified** |
| mechanical scoring correct on known cases | **verified** (32/32, synthetic) |

Four of five remain open, and none may be inferred from the synthetic run.

## 6. Pre-registration recheck

| Criterion | Denominator | Instrumented? | Claimable now? |
| --- | --- | --- | --- |
| P1 / Q1 continuation non-inferiority | oracle pass rate | yes, mechanical | yes, once runs exist |
| P2 / Q2 token efficiency | runtime-reported usage | **capture only** | **no** — needs a runtime that reports usage; incomplete reports must be excluded and the exclusion reported |
| P3 dependency recall | gold edges | yes, both-endpoint rule | yes |
| P4 / Q5 unsupported assumptions | citations + adjudication | protocol frozen | **no** — no independent reviewer |
| P5 catastrophic miss | gold edges | yes | yes |
| H2 retention | 14 plants | 12 mechanical, 2 adjudicated | **partially** — 12 claimable, 2 not |
| H1 change-impact accuracy | gold Jaccard | yes | yes |

Two rules follow, and they are declared before any run:

1. A run whose usage report is missing required fields is recorded as `incomplete` and **excluded from
   the token comparison**; the exclusion count is reported. No estimate is substituted.
2. Any verdict line touching P4/Q5 or the two adjudicated plants carries the reviewer's independence
   status beside it.

## 7. What remains before paid runs

1. **A runtime that reports usage** (input, output, cached input, tool-context) for both arms.
2. **A named independent adjudicator.**
3. **The five live dry-run properties** listed in §5.
4. **C1 replacement status confirmed in the results doc** — H1 has five fixtures, one of which was
   validated only after its oracle was repaired, and that must be stated wherever C1 results appear.

## 8. Verification

```
node tools/contract-test.js            → exit 0 (clean tree), exit 1 (C1 applied)
node tools/patch-check.js --apply      → 5 applicable, 5 oracles fail, all restored
node tools/usage-capture.js --selftest → 19/19
node tools/score-transcript.js --selftest → 17/17
node tools/blind-packet.js --selftest  → 9/9
node tools/dryrun-check.js             → 32/32 (synthetic)
npm run selftest / selftest:decisions / selftest:inventory → 52/52, 40/40, 39/39
```
