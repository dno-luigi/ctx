// Fixed retention policy. ADR-001 chose a fixed boundary over a sliding window.
export const RETENTION_DAYS = 30;
const DAY_MS = 86400000;

export function isExpired(object, now) {
  return now - object.created_at >= RETENTION_DAYS * DAY_MS;
}
