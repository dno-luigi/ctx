# Context pack pack-e87f9bccd3ca (small, ~1195 tokens)
Snapshot snap-f9e3bdcd492ec699 · source digest sha256:fcdf85a62401ba84…
Selected context, not complete source truth. Each item cites its source.

## invariants
- // The boundary MUST be inclusive: an object exactly 30 days old is expired.
  - tests/retention.test.js:4 — “// The boundary MUST be inclusive: an object exactly 30 days old is expired.”
- // The store MUST never delete an unexpired object, even under lock contention.
  - src/store.js:4 — “// The store MUST never delete an unexpired object, even under lock contention.”
- Every accepted batch is written exactly once; retries MUST be idempotent.
  - README.md:8 — “- Every accepted batch is written exactly once; retries MUST be idempotent.”
- The service MUST never delete an object before its retention window expires.
  - README.md:7 — “- The service MUST never delete an object before its retention window expires.”

## outstanding
- // TODO(backfill): backfill cannot run until the store exposes a bounded writer.
  - src/ingest.js:11 — “// TODO(backfill): backfill cannot run until the store exposes a bounded writer.”
- The backfill path is not yet implemented. TODO: document backfill before the next release.
  - README.md:12 — “The backfill path is not yet implemented. TODO: document backfill before the next release.”

## architecture
- store` is responsible for durable writes and reads.
  - docs/ARCHITECTURE.md:6 — “- `store` is responsible for durable writes and reads.”
- Components
  - docs/ARCHITECTURE.md:3 — “## Components”
- Open questions
  - docs/ARCHITECTURE.md:18 — “## Open questions”
- Retention check
  - docs/RUNBOOK.md:8 — “## Retention check”
- Dependencies
  - docs/ARCHITECTURE.md:10 — “## Dependencies”
- ingest` is responsible for accepting batches and validating payloads.
  - docs/ARCHITECTURE.md:5 — “- `ingest` is responsible for accepting batches and validating payloads.”
- Architecture
  - docs/ARCHITECTURE.md:1 — “# Architecture”
- Configuration
  - docs/ARCHITECTURE.md:14 — “## Configuration”
- Nimbus ingest
  - README.md:1 — “# Nimbus ingest”

## omitted (25)
- architecture: Legacy retention note → notes/LEGACY-RETENTION.md
- architecture: Invariants → README.md
- dependencies: src/scheduler.js imports src/ingest.js → src/scheduler.js
- dependencies: src/ingest.js references src/store.js → src/ingest.js
- dependencies: src/scheduler.js references src/ingest.js → src/scheduler.js
- dependencies: src/ingest.js imports src/store.js → src/ingest.js
- dependencies: tests/retention.test.js references src/retention.js → tests/retention.test.js
- dependencies: src/store.js imports src/retention.js → src/store.js
- dependencies: README.md references docs/ARCHITECTURE.md → README.md
- dependencies: ingest depends on store. store depends on retention. scheduler depends on ingest. → docs/ARCHITECTURE.md
- dependencies: tests/retention.test.js imports src/retention.js → tests/retention.test.js
- dependencies: README.md references docs/DECISIONS.md → README.md
- dependencies: src/store.js references src/retention.js → src/store.js
- decisions: We decided to keep a fixed 30-day retention window rather than a sliding TTL. → docs/DECISIONS.md
- decisions: retention` owns the expiry decision and nothing else. → docs/ARCHITECTURE.md
- decisions: We chose a batch size of 100 records. Larger batches increased lock contention. → docs/DECISIONS.md
- decisions: // Fixed retention policy. ADR-001 chose a fixed boundary over a sliding window. → src/retention.js
- decisions: We rejected sliding-window TTL because the audit trail requires a fixed boundary. → docs/DECISIONS.md
- decisions: ADR-002 — batch size → docs/DECISIONS.md
- decisions: ADR-001 — fixed retention window → docs/DECISIONS.md
- decisions: This note is superseded by ADR-001. → notes/LEGACY-RETENTION.md
- failures: Known failure: scheduler drops a batch when the store lock is held → docs/RUNBOOK.md
- failures: The scheduler drops a batch instead of retrying when the store lock is held. → docs/RUNBOOK.md
- failures: Alert if the drop counter exceeds 1 per hour. → docs/RUNBOOK.md
- questions: Is backfill allowed to write directly to the store, or only through ingest? → no source ref
