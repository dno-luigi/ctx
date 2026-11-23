// Boundary tests for the retention window.
import { RETENTION_DAYS, isExpired } from '../src/retention.js';

// The boundary MUST be inclusive: an object exactly 30 days old is expired.
export function testBoundary() {
  const object = { created_at: 0 };
  return isExpired(object, RETENTION_DAYS * 86400000);
}
