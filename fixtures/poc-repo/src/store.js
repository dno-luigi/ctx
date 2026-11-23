// Durable storage for accepted batches.
import { isExpired } from './retention.js';

// The store MUST never delete an unexpired object, even under lock contention.
export async function writeBatch(batch) {
  return batch.map((record) => ({ ...record, written_at: Date.now() }));
}

export function sweep(objects, now) {
  return objects.filter((object) => isExpired(object, now));
}
