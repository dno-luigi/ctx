# PHASE-02 — instrumented live-execution readiness

**Phase:** `gca-0.2.0-phase02` · **Opened:** 2026-11-18 · **Predecessor:** PREP-01 (closed, frozen)
**Status:** open, nothing executed. No live-agent run in this phase.

## Phase 01 is closed

The authoritative preparation checkpoint is `PILOT-FREEZE-01.md` and its manifest.

| | |
| --- | --- |
| Manifest | `runs/frozen/pilot-prep/manifest.json` |
| SHA-256 of the manifest | `b4d59c2d1d08e2c9ab558040632bb8f00b6e68ee96a619573c1e17e98b99de25` |
| Artifacts | 27, all verified on re-read |
| Verification | `node tools/freeze-verify.js` → 27/27 match, freeze intact |
| Separate freeze | `runs/frozen/card-gen-01/manifest.json` (13 artifacts), untouched |

The pinned manifest digest is recorded here so that any later edit to the checkpoint — including a
"harmless" re-hash — is detectable by comparing that one value. Phase 01 is not modified by this
phase, and none of its 27 artifacts may be edited in place.

## Phase 02 scope

Exactly four items, all inherited from the phase-01 authorisation boundary:

1. **Runtime usage reporting** — a live agent runtime that reports input, output, cached input and
   tool-context tokens per run, fed to `tools/usage-capture.js` so P2/Q2 acquire denominators.
2. **Independent adjudication** — a reviewer who did not author the fixtures, or a formal, recorded
   exclusion of P4/Q5 and the two adjudicated H2 plants.
3. **The four unverified live-run properties** — compaction occurs, pre-boundary context is genuinely
   inaccessible, recovery budgets are enforced equally, treatment file-access restrictions hold. One
   fixture per arm.
4. **Pre-registration re-read** — both pilot documents re-confirmed unchanged against the above.
5. **Information-model decision (added 2026-11-18)** — the AA/ARA architectural question resolved in
   `INFORMATION-MODEL-01.md`: shared lifecycle, identity and update algebra; separate stores,
   confidence and verdicts. **Decision recorded only; no implementation is authorised in this phase.**
   This item adds no artifact to the phase-01 freeze and modifies none of its 27 files
   (`node tools/freeze-verify.js` → 27/27 intact after the addition).
6. **Design track (added 2026-11-18)** — sequenced per instruction: (1) code stress test
   `CODE-STRESS-01.md` complete, $0, amendments A1–A3 adopted into the model; (2) ARA logical schema
   `ARA-SCHEMA-01.md` complete, **design only — no migration, no table, no code**; (3) AA contract
   mapping and (4) integration design not started. Same freeze status: 27/27 intact, no frozen artifact
   read-modified, no paid call.
7. **Schema validation (added 2026-11-18)** — `ARA-SCHEMA-VALIDATION-01.md`: AC-1…AC-7 executed against
   an in-memory reference model, **39/39**, with `ARA-SCHEMA-01.md` unchanged (SHA-256 `968a8142…`).
   Validation only: D1, D3, D6 and the three §7 findings must be resolved or explicitly accepted before
   any migration or implementation.

**Out of scope in this phase:** modifying any frozen artifact, paid pilot runs, changing any threshold,
adding core-engine features, and revising `pilot/claims-eligibility.json` except to flip an
`eligible: false` to `true` when its blocker is genuinely resolved.

## Deviation protocol

A deviation is any change to a frozen artifact. It is recorded here before the change is relied on:

| Date | Artifact | Old digest | New digest | Reason | Runs invalidated |
| --- | --- | --- | --- | --- | --- |
| — | — | — | — | none yet | — |

Rules:

- The deviation is logged **before** any run uses the new version.
- Runs that predate a deviation are invalid for claims that depend on the changed instrument; they are
  not re-scored with the new one.
- A deviation is never resolved by re-writing the manifest to match the new file. The manifest is the
  record; the table above is the explanation.

## Exit gate to Phase 03 (live execution)

All four scope items closed, `tools/freeze-verify.js` still intact, and both pre-registrations
confirmed. Only then does a paid run become an authorised action.

If item 1 or 2 cannot be closed, the honest exit is a Phase 03 that runs the pilots with **P2/Q2 and
P4/Q5 formally excluded from every claim** — stated in the results document, not discovered in the
analysis.

## Current state

| Item | Status |
| --- | --- |
| Runtime usage reporting | **not started** — no runtime wired |
| Independent adjudication | **not started** — no reviewer named |
| Four live-run properties | **not started** — require a live agent |
| Pre-registration re-read | **not started** — pending the three above |

Nothing in this phase has produced evidence about either hypothesis, and it cannot: this phase builds
the conditions under which evidence would be admissible.

## Verification

```
node tools/freeze-verify.js     → 27/27 artifacts match, freeze intact
```

The verifier reports deviations and missing files by name and exits non-zero; it never repairs.
