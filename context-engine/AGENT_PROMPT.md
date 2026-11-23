# AGENT INSTRUCTION: Build the Context Engine (GCA/RDA)

> This file is guidance, not authorization. Read section 0 before acting on anything below.

## 0. Project State and Precedence

As of 2026-11-20, at the commit that added this file.

| Gate | State |
| --- | --- |
| Classifier proof (`poc/proof-classifier.js`, `poc/coverage-baseline.js`) | Complete and passing; ready for source review. Frozen at `09b9339` |
| `src/classifier.js` | Production code under review; change deliberately and keep the proof passing. Frozen at `09b9339` |
| Benchmark banks (`banks/`) | Frozen at `2931058`; eleven files tracked |
| Estimator (`tools/estimate-bench.js`, `adapters/`) | Frozen at `76dba95`. Its run artifacts live under `runs/`, which is gitignored and so not auditable from the repository |
| Bank authoring | Gated — requires explicit operator authorization |
| Estimator regeneration | Gated — requires explicit operator authorization |
| Stage 0 probes and any paid provider call | Gated — requires explicit operator authorization |
| Auditability of the hashes above | Mirrored to the private repository `dno-luigi/ctx` on `main`; every hash cited in this table resolves there |

- Operator instruction outranks this file. Where section 4 conflicts with a gate above, the gate wins.
- Nothing here authorizes spend. No model call, provider request or benchmark run happens without separate, explicit approval.
- A passing run establishes consistency with authored labels, not that the labels are correct.
- `fixtures/` is generated and gitignored; frozen proof material lives in `poc/`.
- The engine and its tooling were committed in eight checkpoints, `d69ed0c..997706f`. The two files previously held back for lack of a home were placed as follow-ups inside their own subsystems: `tools/ac6-refined.js` at `bd8338f` (ARA anchor identity) and `tools/contract-test.js` at `3ecb33d` (decision adapters).
- The tree is mirrored to the private repository `dno-luigi/ctx` on `main`, so the audit trail no longer depends on a single worktree. `runs/` is gitignored and is in neither repository, so run artifacts remain unauditable from the source tree. The POC fixtures under `context-engine/fixtures/` are tracked, so a fresh clone can run the POC that ships with the engine.
- No Stage 0 record exists in the repository. The Stage 0 row above is a policy statement, not evidence that Stage 0 has run either way.
- The tree in section 3 is the target layout. The current tree also holds `poc/`, `tools/`, `adapters/`, `banks/`, `baseline/`, `cards/`, `inventory/`, `pilot/`, `recorded/`, `snapshot/` and `examples/live-approved/`.

---

## Objective
Develop an inexpensive, model-assisted system for comprehensive contextual scanning, reconstruction, and compaction inside `context-engine/` within the existing combined GCA/RDA project [1].

The central hypothesis: Instead of relying on increasingly lossy summaries as an agent approaches its context limit, use low-cost models (initial baseline: GLM Flash) to repeatedly scan complete source material and reconstruct a structured, verifiable representation of the relevant context [1, 3, 4].

---

## 1. Governing Architectural Principles
1. **Differential Operations**: Preserve what remains valid, identify what has changed, reprocess affected context partitions, and apply only necessary updates [5, 6].
2. **Authoritative Source Truth**: Original repository code, configurations, and logs remain authoritative [4]. AI-generated context is strictly derived data and must be categorized separately [4, 7].
3. **Operator Authority & Verification**: Successful execution alone does not constitute trust [8]. Every transition must be supported by verified truth, traceable provenance, and explicit change assessment [9]. The operator retains decision authority [8].
4. **Read-Only Default**: Operating in scan/read-only mode by default without automatic deployment or production mutations [4].

---

## 2. Core Capabilities to Implement

### A. Context Acquisition & Scanning
- Ingest complete codebases, documentation, conversation histories, logs, and architectural records while preserving identity, paths, hashes, and timestamps [3].
- Extract architecture, dependencies, invariants, confirmed decisions, current state, active tasks, and known risks using configurable scanning models [10].

### B. Structured Context Representation & Differential Updates (RDA)
- Output machine-readable context artifacts that separate source facts, model observations, verified conclusions, inferences, questions, and historical vs. current state [7].
- Compare new scans against previous versioned snapshots to reprocess only modified or affected context partitions [5].

### C. Reversible Context Compaction
- Generate compact working-context packages for context-constrained agents that retain critical instructions, project state, tasks, and decisions [11].
- Ensure compaction is fully reversible via direct source references [11].

---

## 3. Required Directory Deliverables

Inside `context-engine/`, construct the following structure [2]:

```
context-engine/
├── README.md         # Purpose, architecture, and usage [2]
├── ARCHITECTURE.md   # Component design and data flow [2]
├── SCHEMA.md         # Context artifact schemas [2]
├── PROTOCOL.md       # Scanning, reconciliation, and compaction protocol [2]
├── EVALUATION.md     # Evaluation methodology and metrics [2]
├── src/              # Implementation modules [2]
├── tests/            # Unit, integration, and regression tests [2]
├── fixtures/         # Controlled source material and ground truth [2]
└── examples/         # Representative scan and compaction outputs [2]
```

---

## 4. Execution Workflow for the Agent
1. **Phase 1 — Inspection & Reuse**: Inspect the existing repository, GCA/RDA infrastructure, and conventions [12]. Identify reusable components before writing new code [12].
2. **Phase 2 — Proposal**: Output a minimal implementation plan and flag any architectural conflicts [12]. Wait for operator approval before modifying files [12, 13].
3. **Phase 3 — Incremental Build & POC**: Implement modular components and run the 10-step proof-of-concept sequence (scanning, structured representation, compaction, question-answering evaluation, and differential update validation) [12, 14]. Subject to the gates in section 0.
4. **Phase 4 — Instrumentation Report**: Log actual token usage, provider costs, latency, and test validation metrics per scan [4, 14].
