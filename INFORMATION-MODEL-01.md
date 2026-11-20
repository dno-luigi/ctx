# INFORMATION-MODEL-01 — shared lifecycle, separate stores

**Date:** 2026-11-18 · **Cost:** $0 · **Status:** decision, no code. Nothing frozen was modified.

**Amended by** `CODE-STRESS-01.md` (2026-11-18): three evidence-driven amendments — A1 occurrence
ordinal in anchor identity, A2 per-domain coverage instruments, A3 declared `edge_source` per domain.
The decision below stands; §3 and §5 carry the amendments.

**Question:** should AA and ARA share a common information lifecycle and differential-update mechanism,
while retaining separate responsibilities and storage boundaries?

**Answer: yes to the lifecycle, the identity function and the update algebra. No to a shared store, a
shared confidence field, and inherited verdicts.** The three shared pieces are the ones the experiments
actually validated; the three refused pieces are the ones where sharing would let one system's
judgement become another system's fact.

---

## 1. The decision

| Layer | Shared between AA and ARA? | Evidence it should be |
| --- | --- | --- |
| Lifecycle vocabulary (observed → captured → retained → retrievable → assessed → unknown) | **yes** | it is already the measurement spine; every loss measured in the last four experiments is a stage loss |
| Identity function (content-addressed claim + anchor ids) | **yes** | 207 cards → 25 ids, engine agreement 1.000, ids survive a global offset shift |
| Differential-update algebra (append, supersede, conflict; never rewrite) | **yes** | RDA propagated 3/3 deltas across 4 configs with 0 silent losses |
| Storage (tables, journals, files) | **no** | no experiment measured a cross-system store, and transfer of knowledge is unproven (§10) |
| Confidence | **no** | confidence moves while claims do not; it is an observation, not a property of the record |
| Verdicts / assessments | **no** | transfer is claim-scoped: 6/6 delta questions, but 1/6–2/8 held-out retention |

The shape is: **one contract, two stores.** A record produced by either system has the same identity,
the same lifecycle state, and the same update operations. The records live where they are authored, and
a record's author is the only writer that may assert it.

## 2. Why the lifecycle is the thing to share

The stage counters are not an abstraction invented for the design; they are what caught the losses:

| Stage | Measured | What it showed |
| --- | --- | --- |
| inventory → question → decision → card → anchor | 31 → 30, then **flat** 30/30/30/30/30 | conversion is not where information dies; naming is |
| inventory recall vs oracle | 0.355 → **0.968**, `structural_constraint` 0.143 → 1.000 | what gets *named* determines what can ever be retained |
| cards added to raise coverage | 0.273 → **0.273** with five added cards | coverage is bounded by the naming instrument, not by record count |
| anchored rate | **50–60% of cards unanchored** (F9 30/60, F3 45/75, F2a 15/60) | an unanchorable record is not retrievable, and no downstream layer can repair that |

Sharing the vocabulary is what makes those counters comparable across systems. Two systems with
private stage names cannot tell a loss of coverage from a loss of retrieval, and that distinction is
exactly where every defect in this project has been found.

## 3. The record

One record per assertion, identical in both systems:

```
claim_id        digest(normalised claim, sorted anchor_ids)     — content-addressed, no model input
anchor_ids[]    digest(source_id, normalised quote, occurrence) — survives edits, breaks on revision
                                                                 (occurrence added by CODE-STRESS-01 A1:
                                                                 41/665 code lines share an id without it)
locator         {source_id, start, end}                          — attribute, NOT identity
granularity     'item' | 'composite' + member claim_ids[]        — see §9
state           observed | captured | retained | retrievable | assessed | unknown
revision        {valid_from, valid_until | null}                 — the source revision, not wall clock
supersedes[]    claim_ids this replaces
conflicts_with[] claim_ids asserting an incompatible claim on the same anchor
confidence      {value, question_id, model, at}                  — an observation beside the record
verdict         {value, evidence_ids[], basis} | null            — ARA's, never AA's
```

Three fields are doing load-bearing work and each has a reason measured here:

- **`locator` is an attribute.** Positional identity silently reassigned **8 of 13** F3 ids across two
  edits. Offsets are stale the moment anyone types above them; they are a hint for resolution, never a key.
- **`confidence` is not in `claim_id`.** Two cards asserting the same thing at 0.49 and 0.72 are the
  same card — right for reuse, wrong for drift. Identity stays confidence-blind; confidence sits beside it.
- **`revision` is the source's.** Revision sensitivity was demonstrated: revising one sentence destroyed
  exactly that identity and its collateral (F9 1, F3 3), because revision means new language, new id.

## 4. AA: the six states, and the rule that matters

The rule: **something is remembered only when there is a record with a resolvable evidence address.**
Appearing in a conversation, a snapshot or a compaction summary establishes `observed` and nothing more.

| State | Established by | Not established by |
| --- | --- | --- |
| `observed` | the item appeared in a stream the system processed | — |
| `captured` | a record was written with ≥1 anchor | being mentioned, being summarized, being "in context" |
| `retained` | the anchor still resolves after the source revision changes | the record existing in storage |
| `retrievable` | resolution returns the record by locator-then-quote, or by `claim_id` | being retained — storage can hold what the resolver cannot find |
| `assessed` | a verdict exists with its evidence ids | confidence being high |
| `unknown` | explicitly declared absent, with the query that failed | silence, omission, or a null |

`unknown` is a first-class state with a cause, not an empty column. The F9 result is the reason: an
inventory with a **1.0** ratio against its own denominator was simultaneously blind to **2 of 2**
required items. A system that reports "everything captured" without an external denominator is
reporting the size of its own blind spot as success.

`retained` requires a probe, not a belief. Retention is only demonstrated by re-resolving after a
revision — the mechanism that let 20 anchors survive a global offset shift, and that destroyed exactly
the two revised sentences.

## 5. The differential-update algebra

Shared by both systems, because it is the most validated piece in the project: RDA propagated **3/3**
deltas across four configurations with **zero silent losses**.

| Operation | Effect |
| --- | --- |
| `assert(record)` | append; a record whose `claim_id` already exists is the same record and merges anchors |
| `supersede(old, new)` | new record with `supersedes: [old]`; old keeps `valid_until = new.revision`; nothing is deleted |
| `conflict(a, b)` | both records kept, each listed in the other's `conflicts_with`; neither is chosen automatically |
| `retract(id, basis)` | state → `unknown` with a cause; the record remains as history |
| `reassess(id, verdict)` | new verdict appended; the previous verdict is retained with its timestamp |

Two properties the design depends on:

1. **No operation rewrites a record.** Contradiction is represented, not resolved. Automatic resolution
   would require a rule for which source wins, and no experiment here establishes one — the two H2
   failures (`F3 P4` 0.57 granularity, `F9 P4` 0.43 wording) are precisely cases where a confident
   automatic merge would have silently picked the wrong representation.
2. **Every operation is a delta with an evidence address.** That is what makes propagation testable at
   all, and it is why the RDA result was a clean 3/3 rather than a partial.
3. **`edge_source` is declared per domain (CODE-STRESS-01 A3).** The algebra is domain-neutral; its
   input is not. On code the information model recorded 0 of 1 imports while 2 real dependents existed,
   so a scope with no declared edge source reports `edges: unknown` rather than `0`, and propagation
   over code requires an import/dependency analyzer.

## 6. Coverage and confidence are two instruments, never one number

| | Coverage | Confidence |
| --- | --- | --- |
| Question | does the record set span the **required** items? | does the source support this one claim? |
| Denominator | a declared required set, authored outside the naming instrument | the question asked, per claim |
| Measured by | set operations against the required set | the decision model's probability |
| Fails when | the naming instrument cannot name the item | the model is miscalibrated |
| Reported as | ratio **plus** unanchored count **plus** required-set id | distribution, with the question and model recorded |

They must not be multiplied, averaged or summed into a single score. The reason is empirical: F9 scored
**1.00** on one gate while its inventory was blind to **2 of 2** required items. A blended score would
have averaged a real failure into a passing number.

And coverage needs an **external** denominator, because omission is not detectable from inside: the
system cannot report a record it never had a name for. Any ARA claim of "sufficient evidence" therefore
resolves to two separate checks —

```
sufficient(scope) =
    covered(required_set(scope))            // did we name everything the scope requires?
  ∧ confidence(claims) above its floor      // is each named claim supported?
```

— and when either is false the answer is `insufficient`, naming which side failed. Never "sample more
until confident", which silently changes the denominator.

## 7. What this does to ARA's unfinished tables

The old design (decisions table + KV journal) is not wrong, it is under-specified in three places this
model now fixes:

| Old shape | Replaced by | Why |
| --- | --- | --- |
| decision row with mutable `status` | append-only `verdict` records; current state is a projection | mutable status loses the reason a decision changed, which is the thing RDA needs |
| journal as free-form KV | event log of the five operations, each with `claim_id` + anchors | makes propagation a set operation rather than a replay guess |
| one blended "confidence" per decision | `confidence` (observation) separate from `verdict` (assessment) separate from coverage | prevents a high-confidence invention from reading as covered |
| retrieval by recency / similarity | resolution by `locator`-then-`quote`, or exact `claim_id` | similarity retrieval cannot distinguish "not covered" from "not matched"; identity can |
| evidence stored as a citation string | `anchor_ids` + `locator` + source revision | a string cannot be re-resolved after an edit |

**"Has ARA got enough evidence?"** becomes: the required set for the scope, coverage against it, and
per-claim confidence — three answers, not one.

## 8. What this does to AA's persistence

- **Write on observation, with an address.** A capture without an anchor is `observed`, not remembered.
  Given 50–60% unanchored cards in the measured pipeline, an AA that treats capture as retention would
  be wrong about most of its own memory.
- **Retention is a probe.** Re-resolve anchors after each source revision; move failing records to
  `unknown` with the reason, rather than leaving them looking remembered.
- **Retrieval reports the failure mode.** `not_covered` (no record was ever named), `not_matched`
  (a record exists but did not resolve), `stale` (resolved to a superseded revision). These three are
  currently collapsed into "not found", which is the distinction the whole identity layer exists to make.
- **`unknown` is queryable.** "What don't you know?" must be answerable, or the system cannot distinguish
  working from blind.

## 9. Granularity: state the composition, don't infer it

`F3 P4` scored **0.57** because the plant bundled both documents' revisions while the cards carried one
header each — the state existed across two records and in no single one. That is not a coverage failure
to be fixed by adding cards; it is a **representation** fact.

Hence `granularity` on every record: `item`, or `composite` with explicit `member claim_ids`. A retention
claim must say which it is asserting:

- *per-record retention* — each member retrievable;
- *composite retention* — the members are retrievable **and** their composition is recorded.

Without the second form, "we retained the reconciliation rule" is unfalsifiable: the pieces are there and
the thing the task needed is not.

## 10. What sharing must not imply

**A shared record is not shared knowledge.** The transfer measurement is the constraint: delta questions
against another system's cards scored **6/6**, but held-out substitution scored **1/6 to 2/8**. A card set
transfers as answers to the questions that were asked, not as a body that answers new ones.

So: ARA may *read* AA's records, resolve their anchors, and reuse their identity. It may not inherit
their verdicts, their confidence, or their coverage claims. **ARA re-assesses; it does not adopt.** The
shared format makes the input cheap to consume, which is exactly the benefit, and it makes silent
inheritance the failure mode to guard against.

Cross-fixture reuse is also weaker than it looks: `F2a~F2b` 1.000 but `F2a~F2d` 0.143 — identity
recognises agreement, it does not create it. And onboarding a genuinely new source inherited **0%**,
because two unrelated documents share no anchors.

## 11. What would change this decision

The decision rests on ten short synthetic documents, one engine and one reviewer. It would be weakened by:

- **code corpora**, where identifiers repeat constantly and negations are rarer — anchoring and boolean
  handling are both untested there, and they are the two mechanisms this model leans on hardest;
- a **second reviewer** disagreeing with the required sets, since coverage's denominator is exactly the
  thing procedural independence could not audit;
- a demonstrated **automatic conflict resolution** rule that outperforms keeping both — none exists here;
- evidence that **AA and ARA retrieval needs diverge** enough that one resolution contract cannot serve
  both; nothing measured so far suggests it, but nothing measured so far exercises ARA's retrieval at all.

## 12. Consequences

1. ARA's unfinished tables should be built against §3 and §5, not completed as previously designed.
2. AA's memory should be defined by §4's six states, with `observed` explicitly not memory.
3. The shared pieces are a **schema and an algebra**, not a database. No shared table is proposed, because
   no experiment supports one and the write-authority rule is what keeps one system's judgement from
   becoming another's fact.
4. The unanchored rate (**50–60%**) is the number to drive down first. It is upstream of both systems: no
   identity scheme, store or update algebra can retain what the naming instrument cannot name.

No implementation is authorised by this document. It resolves the architectural question; it does not
change any frozen artifact, any threshold, or any pilot.
