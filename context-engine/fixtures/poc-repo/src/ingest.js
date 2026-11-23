// Batch ingestion entry point.
import { writeBatch } from './store.js';

export const MAX_BATCH = 100;

export async function ingest(batch) {
  if (batch.length > MAX_BATCH) throw new Error(`batch too large: ${batch.length}`);
  return writeBatch(batch);
}

// TODO(backfill): backfill cannot run until the store exposes a bounded writer.
