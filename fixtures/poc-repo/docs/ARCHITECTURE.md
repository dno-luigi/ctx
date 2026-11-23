# Architecture

## Components

- `ingest` is responsible for accepting batches and validating payloads.
- `store` is responsible for durable writes and reads.
- `retention` owns the expiry decision and nothing else.
- `scheduler` drives periodic drain work.

## Dependencies

ingest depends on store. store depends on retention. scheduler depends on ingest.

## Configuration

The ingest timeout is 30 seconds in production, set by the platform team.

## Open questions

- Is backfill allowed to write directly to the store, or only through ingest?
