# Context pack pack-fbe1c41a256f (medium, ~2839 tokens)
Snapshot snap-aba96e1d51889f09 · source digest sha256:fcdf85a62401ba84…
Selected context, not complete source truth. Each item cites its source.

## invariants
- The retention expiry boundary is inclusive: an object exactly 30 days old is expired.
  - tests/retention.test.js:4 — “// The boundary MUST be inclusive: an object exactly 30 days old is expired.”
- The store must never delete an unexpired object, even under lock contention.
  - src/store.js:4 — “// The store MUST never delete an unexpired object, even under lock contention.”
- Every accepted batch is written exactly once and retries MUST be idempotent.
  - README.md:8 — “Every accepted batch is written exactly once; retries MUST be idempotent.”
- The service MUST never delete an object before its retention window expires.
  - README.md:7 — “The service MUST never delete an object before its retention window expires.”

## current state
- Retention was previously 14 days before the audit change, and that legacy note is superseded by ADR-001.
  - notes/LEGACY-RETENTION.md:3 — “Retention was 14 days before the audit change.
This note is superseded by ADR-001.”
- The retention window is 30 days, defined as RETENTION_DAYS = 30 in code and matching config/defaults.json.
  - src/retention.js:2 — “export const RETENTION_DAYS = 30;”
  - config/defaults.json:2 — “"retention_days": 30,”
- An unresolved architecture question is whether backfill may write directly to the store or only through ingest.
  - docs/ARCHITECTURE.md:20 — “- Is backfill allowed to write directly to the store, or only through ingest?”
- ingest enforces MAX_BATCH = 100 and throws if a batch exceeds it.
  - src/ingest.js:7 — “if (batch.length > MAX_BATCH) throw new Error(`batch too large: ${batch.length}`);”
- The scheduler runs every 30 seconds and takes batches of 100 from the queue.
  - src/scheduler.js:5 — “return setInterval(() => ingest(queue.take(100)), 30000);”

## outstanding
- The backfill path is not yet implemented and documenting it is a TODO before the next release.
  - README.md:12 — “The backfill path is not yet implemented. TODO: document backfill before the next release.”
- Backfill cannot run until the store exposes a bounded writer.
  - src/ingest.js:11 — “// TODO(backfill): backfill cannot run until the store exposes a bounded writer.”

## architecture
- ingest validates and accepts batches, store handles durable writes and reads, retention owns only the expiry decision, and scheduler drives periodic drain work.
  - docs/ARCHITECTURE.md:5 — “- `ingest` is responsible for accepting batches and validating payloads.
- `store` is responsible for durable writes and reads.
- `retention` owns the expiry de”

## dependencies
- src/scheduler.js imports src/ingest.js
  - src/scheduler.js:2 — “import { ingest } from './ingest.js';”
- docs/DECISIONS.md defines src/ingest.js
  - src/ingest.js:4 — “export const MAX_BATCH = 100;”
- src/ingest.js imports src/store.js
  - src/ingest.js:2 — “import { writeBatch } from './store.js';”
- src/store.js imports src/retention.js
  - src/store.js:2 — “import { isExpired } from './retention.js';”
- README.md references docs/ARCHITECTURE.md
  - README.md:14 — “See [the architecture](docs/ARCHITECTURE.md) and [the decisions](docs/DECISIONS.md).”
- tests/retention.test.js imports src/retention.js
  - tests/retention.test.js:2 — “import { RETENTION_DAYS, isExpired } from '../src/retention.js';”
- README.md references docs/DECISIONS.md
  - README.md:14 — “See [the architecture](docs/ARCHITECTURE.md) and [the decisions](docs/DECISIONS.md).”
- docs/DECISIONS.md defines src/retention.js
  - src/retention.js:1 — “// Fixed retention policy. ADR-001 chose a fixed boundary over a sliding window.”
- config/defaults.json references src/retention.js
  - config/defaults.json:2 — “"retention_days": 30,”
- The dependency chain is ingest -> store -> retention, with scheduler -> ingest.
  - docs/ARCHITECTURE.md:12 — “ingest depends on store. store depends on retention. scheduler depends on ingest.”
- notes/LEGACY-RETENTION.md references docs/DECISIONS.md
  - notes/LEGACY-RETENTION.md:4 — “This note is superseded by ADR-001.”

## decisions
- ADR-001 chose a fixed 30-day retention window over a sliding TTL because the audit trail requires a fixed boundary.
  - docs/DECISIONS.md:5 — “We decided to keep a fixed 30-day retention window rather than a sliding TTL.
We rejected sliding-window TTL because the audit trail requires a fixed boundary.”
- ADR-002 chose a batch size of 100 records because larger batches increased lock contention.
  - docs/DECISIONS.md:10 — “We chose a batch size of 100 records. Larger batches increased lock contention.”

## failures
- The scheduler drops a batch instead of retrying when the store lock is held, and an alert fires if the drop counter exceeds 1 per hour.
  - docs/RUNBOOK.md:5 — “The scheduler drops a batch instead of retrying when the store lock is held.
Alert if the drop counter exceeds 1 per hour.”

## questions
- Which value is the effective ingest timeout, 5 or 30 seconds?
- Is backfill allowed to write directly to the store, or only through ingest?
- Does the scheduler's 30-second interval relate to the 30-second timeout value or is it coincidental?
- Is config/defaults.json's retention_days read by the code, or is the RETENTION_DAYS constant the sole source of truth?

## inferences
- The store's writeBatch stamps each record with written_at but performs no durable-write mechanism in the acquired code. [inferred_reading]
  - src/store.js:6 — “return batch.map((record) => ({ ...record, written_at: Date.now() }));”
