import { normalizeClaim } from './canonical.js';

/**
 * Recursive Differential Assessment.
 *
 * A claim is identified by the source it cites and the text it cites, not by the
 * words of its claim: rephrasing an observation is not a change in what was
 * assessed. A delta is justified only if a source it cites actually changed.
 * Everything else is either drift (a claim vanished) or innovation (a claim
 * appeared) that the input does not account for.
 */

export function claimKey(observation) {
  const refs = Array.isArray(observation?.refs) ? observation.refs : [];
  if (refs.length === 0) return `inferred|${normalizeClaim(observation?.claim)}`;
  const ref = [...refs].sort((a, b) => String(a.source_id).localeCompare(String(b.source_id)))[0];
  const span = ref?.span ? `${ref.span.start}:${ref.span.end}` : normalizeClaim(ref?.quote);
  return `${ref?.source_id}|${span}`;
}

export function changedSourceIds(inputA, inputB) {
  const before = new Map((inputA?.sources ?? []).map((s) => [s.id, s.hash]));
  const after = new Map((inputB?.sources ?? []).map((s) => [s.id, s.hash]));
  const changed = new Set();
  for (const [id, hash] of after) if (before.get(id) !== hash) changed.add(id);
  for (const id of before.keys()) if (!after.has(id)) changed.add(id);
  return [...changed].sort();
}

function touches(observation, changed) {
  return (observation?.refs ?? []).some((ref) => changed.includes(ref?.source_id));
}

export function diffSnapshots(a, b, inputA, inputB) {
  const changed = changedSourceIds(inputA, inputB);
  const before = new Map((a?.observations ?? []).map((o) => [claimKey(o), o]));
  const after = new Map((b?.observations ?? []).map((o) => [claimKey(o), o]));

  const same = [];
  const dropped = [];
  const added = [];
  for (const [key, observation] of before) {
    if (after.has(key)) same.push({ key, claim: observation.claim });
    else dropped.push({ key, claim: observation.claim, obs: observation });
  }
  for (const [key, observation] of after) {
    if (!before.has(key)) added.push({ key, claim: observation.claim, obs: observation });
  }

  const justified_dropped = dropped.filter((entry) => touches(entry.obs, changed));
  const justified_added = added.filter((entry) => touches(entry.obs, changed));
  const silent_drift = dropped.filter((entry) => !touches(entry.obs, changed));
  const spurious_innovation = added.filter((entry) => !touches(entry.obs, changed));

  const deltas = added.length + dropped.length;
  const justified = justified_added.length + justified_dropped.length;

  return {
    changed_sources: changed,
    same,
    added: added.map((e) => e.claim),
    dropped: dropped.map((e) => e.claim),
    silent_drift: silent_drift.map((e) => e.claim),
    spurious_innovation: spurious_innovation.map((e) => e.claim),
    justified_fraction: deltas === 0 ? 1 : justified / deltas,
    monotone_in_evidence: silent_drift.length === 0,
  };
}

/** Jaccard over claim-key sets: how much two snapshots assert the same things. */
export function jaccard(a, b) {
  const left = new Set((a?.observations ?? []).map(claimKey));
  const right = new Set((b?.observations ?? []).map(claimKey));
  if (left.size === 0 && right.size === 0) return 1;
  let intersection = 0;
  for (const key of left) if (right.has(key)) intersection += 1;
  return intersection / (left.size + right.size - intersection);
}

/**
 * Per-claim stability across repeats: the share of asserted claims that appear
 * in at least 80% of valid repeats. A claim that appears once in five runs is
 * not an assessment.
 */
export function claimStability(snapshots) {
  const counts = new Map();
  for (const snapshot of snapshots) {
    for (const key of new Set((snapshot?.observations ?? []).map(claimKey))) {
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  if (counts.size === 0) return { stability: 1, union: 0, unstable: [] };
  const needed = Math.max(2, Math.ceil(0.8 * snapshots.length));
  const unstable = [...counts.entries()].filter(([, count]) => count < needed).map(([key]) => key);
  return {
    stability: (counts.size - unstable.length) / counts.size,
    union: counts.size,
    unstable,
  };
}
