# Context pack pack-56633b3dff88 (small, ~1197 tokens)
Snapshot snap-7758e901b5362ef3 · source digest sha256:fcdf85a62401ba84…
Selected context, not complete source truth. Each item cites its source.

## invariants
- The service must never delete an object before its retention window expires.
  - README.md:7 — “The service MUST never delete an object before its retention window expires.”
- Every accepted batch is written exactly once and retries must be idempotent.
  - README.md:8 — “Every accepted batch is written exactly once; retries MUST be idempotent.”
- The store must never delete an unexpired object even under lock contention.
  - src/store.js:4 — “The store MUST never delete an unexpired object, even under lock contention.”

## current state
- ingest enforces a maximum batch size of 100 by throwing on larger batches.
  - src/ingest.js:7 — “if (batch.length > MAX_BATCH) throw new Error(`batch too large: ${batch.length}`);”
- Retention was 14 days before the audit change and the legacy note is superseded by ADR-001.
  - notes/LEGACY-RETENTION.md:3 — “Retention was 14 days before the audit change.”
  - notes/LEGACY-RETENTION.md:4 — “This note is superseded by ADR-001.”
- Configuration defaults set retention_days 30, timeout_seconds 5, and batch_size 100.
  - config/defaults.json:2 — “"retention_days": 30,”
- Retention expiry uses an inclusive boundary: an object exactly 30 days old is expired.
  - src/retention.js:6 — “return now - object.created_at >= RETENTION_DAYS * DAY_MS;”
  - tests/retention.test.js:4 — “The boundary MUST be inclusive: an object exactly 30 days old is expired.”
- The scheduler drains the queue every 30 seconds in batches of 100.
  - src/scheduler.js:5 — “return setInterval(() => ingest(queue.take(100)), 30000);”

## outstanding
- The backfill path is not yet implemented and must be documented before the next release.
  - README.md:12 — “The backfill path is not yet implemented. TODO: document backfill before the next release.”
- An open question remains whether backfill may write directly to the store or only through ingest.
  - docs/ARCHITECTURE.md:20 — “Is backfill allowed to write directly to the store, or only through ingest?”

## dependencies
- src/scheduler.js imports src/ingest.js
  - src/scheduler.js:2 — “import { ingest } from './ingest.js';”
- src/scheduler.js references docs/DECISIONS.md
  - src/scheduler.js:5 — “return setInterval(() => ingest(queue.take(100)), 30000);”

## omitted (17)
- architecture: ingest accepts batches and validates payloads; store handles durable writes and reads; retention owns only the expiry decision; scheduler drives periodic drain work. → docs/ARCHITECTURE.md, docs/ARCHITECTURE.md, docs/ARCHITECTURE.md, docs/ARCHITECTURE.md
- dependencies: src/ingest.js imports src/store.js → src/ingest.js
- dependencies: src/store.js imports src/retention.js → src/store.js
- dependencies: README.md references docs/ARCHITECTURE.md → README.md
- dependencies: The dependency chain is ingest -> store -> retention, and scheduler -> ingest. → docs/ARCHITECTURE.md
- dependencies: config/defaults.json references docs/DECISIONS.md → config/defaults.json
- dependencies: tests/retention.test.js imports src/retention.js → tests/retention.test.js
- dependencies: docs/ARCHITECTURE.md documents scheduler → docs/ARCHITECTURE.md
- dependencies: README.md references docs/DECISIONS.md → README.md
- dependencies: docs/DECISIONS.md defines src/retention.js → src/retention.js
- dependencies: notes/LEGACY-RETENTION.md references docs/DECISIONS.md → notes/LEGACY-RETENTION.md
- decisions: ADR-002 chose a batch size of 100 because larger batches increased lock contention. → docs/DECISIONS.md
- decisions: ADR-001 chose a fixed 30-day retention window over a sliding TTL because the audit trail requires a fixed boundary. → docs/DECISIONS.md, docs/DECISIONS.md
- failures: The scheduler drops a batch instead of retrying when the store lock is held. → docs/RUNBOOK.md
- questions: Is backfill allowed to write directly to the store, or only through ingest? → no source ref
- questions: Why does config/defaults.json define timeout_seconds at all if the production timeout is set by the platform team? → no source ref
- questions: Does the scheduler dropping a batch when the store lock is held conflict with the exactly-once / idempotent-retry invariant, given dropped batches are not retried? → no source ref
