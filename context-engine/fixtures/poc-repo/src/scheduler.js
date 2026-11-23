// Periodic drain. Runs every 30 seconds.
import { ingest } from './ingest.js';

export function start(queue) {
  return setInterval(() => ingest(queue.take(100)), 30000);
}
