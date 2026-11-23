# Runbook

## Known failure: scheduler drops a batch when the store lock is held

The scheduler drops a batch instead of retrying when the store lock is held.
Alert if the drop counter exceeds 1 per hour.

## Retention check

Verify the retention window is 30 days before every release.
