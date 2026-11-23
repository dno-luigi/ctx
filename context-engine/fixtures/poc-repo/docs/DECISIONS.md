# Decisions

## ADR-001 — fixed retention window

We decided to keep a fixed 30-day retention window rather than a sliding TTL.
We rejected sliding-window TTL because the audit trail requires a fixed boundary.

## ADR-002 — batch size

We chose a batch size of 100 records. Larger batches increased lock contention.
