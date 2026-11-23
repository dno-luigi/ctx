# Nimbus ingest

Nimbus accepts uploads and keeps them for a fixed retention period.

## Invariants

- The service MUST never delete an object before its retention window expires.
- Every accepted batch is written exactly once; retries MUST be idempotent.

## Status

The backfill path is not yet implemented. TODO: document backfill before the next release.

See [the architecture](docs/ARCHITECTURE.md) and [the decisions](docs/DECISIONS.md).
