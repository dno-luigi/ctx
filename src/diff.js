import { normalizeClaim } from './canonical.js';
import { occurrencesOf } from './spans.js';

/**
 * Recursive Differential Assessment.
 *
 * A claim is identified by the source it cites and the text it quotes, not by
 * the words of its claim and not by an offset: rephrasing an observation is not
 * a change in what was assessed, and the same quotation at a different offset is
 * the same evidence. Offsets are reported as `span_moves`, so a claim that keeps
 * its evidence while the evidence relocates is visible without being scored as a
 * delta.
 *
 * A delta is justified only if *the evidence it cites* changed. The original
 * version of this file used a whole-source hash, which is too coarse: editing
 * one sentence in a hundred-page document changes the hash and would justify
 * every delta in that document. Justification is therefore computed per cited
 * region, by comparing the quoted text and its immediate surroundings across
 * the two inputs.
 *
 * Two limits are stated rather than hidden:
 *   - the comparison is windowed, not a document diff. An edit inside the
 *     window counts as a change to the evidence neighbourhood, and in a source
 *     shorter than the window the whole source is the neighbourhood.
 *   - image evidence cannot be compared at all, so a delta resting on an image
 *     region is reported as partially justified, never as justified.
 */

/** Characters either side of the quote that make up its evidence neighbourhood. */
export const EVIDENCE_WINDOW = 48;

function primaryRef(observation) {
  const refs = Array.isArray(observation?.refs) ? observation.refs : [];
  if (refs.length === 0) return null;
  return [...refs].sort((a, b) => String(a.source_id).localeCompare(String(b.source_id)))[0];
}

/**
 * Evidence-addressed identity. Position is deliberately excluded: a quotation
 * that moved is the same evidence, and two identical quotations are one
 * citation, not two.
 */
export function claimKey(observation) {
  const ref = primaryRef(observation);
  if (!ref) return `inferred|${normalizeClaim(observation?.claim)}`;
  return `${ref?.source_id}|${normalizeClaim(ref?.quote)}`;
}

function spanMoved(a, b) {
  const left = primaryRef(a)?.span;
  const right = primaryRef(b)?.span;
  if (!left || !right) return false;
  return left.start !== right.start || left.end !== right.end;
}

export function changedSourceIds(inputA, inputB) {
  const before = new Map((inputA?.sources ?? []).map((s) => [s.id, s.hash]));
  const after = new Map((inputB?.sources ?? []).map((s) => [s.id, s.hash]));
  const changed = new Set();
  for (const [id, hash] of after) if (before.get(id) !== hash) changed.add(id);
  for (const id of before.keys()) if (!after.has(id)) changed.add(id);
  return [...changed].sort();
}

function sourceOf(input, sourceId) {
  return (input?.sources ?? []).find((s) => s.id === sourceId) ?? null;
}

function textOf(source) {
  return typeof source?.content?.text === 'string' ? source.content.text : '';
}

function normalizeSpace(text) {
  return text.replace(/\s+/g, ' ');
}

/**
 * The evidence signature: the quote's surroundings, with whitespace folded.
 *
 * Whitespace folding is deliberate. Reflowing a document does not change what it
 * says, so it must not look like changed evidence. Replacing a word does.
 */
function neighbourhood(text, start, end) {
  const before = normalizeSpace(text.slice(Math.max(0, start - EVIDENCE_WINDOW), start));
  const after = normalizeSpace(text.slice(end, end + EVIDENCE_WINDOW));
  return `${before}\u0000${after}`;
}

/**
 * Did the evidence behind this ref change between `ownInput` and `otherInput`?
 *
 *   'changed'   — the quote is gone, or it now sits in different surroundings
 *   'unchanged' — the same quote sits in the same neighbourhood
 *   'unknown'   — the evidence is not text (an image region), so it cannot be compared
 */
export function evidenceState(ref, ownInput, otherInput) {
  const own = sourceOf(ownInput, ref?.source_id);
  const other = sourceOf(otherInput, ref?.source_id);
  if (!other) return 'changed';
  if (own?.kind === 'image' || other?.kind === 'image') return 'unknown';

  const quote = String(ref?.quote ?? '');
  if (!quote) return 'changed';

  const ownText = textOf(own);
  const otherText = textOf(other);
  const ownStart = ownText.indexOf(quote);
  if (ownStart < 0) return 'changed';

  const starts = occurrencesOf(otherText, quote);
  if (starts.length === 0) return 'changed';

  const signature = neighbourhood(ownText, ownStart, ownStart + quote.length);
  return starts.some((start) => neighbourhood(otherText, start, start + quote.length) === signature) ? 'unchanged' : 'changed';
}

function evidenceStateOf(observation, ownInput, otherInput) {
  const refs = Array.isArray(observation?.refs) ? observation.refs : [];
  if (refs.length === 0) return { state: 'none', changedRefs: [], changedSources: [] };

  const states = refs.map((ref) => ({ ref, state: evidenceState(ref, ownInput, otherInput) }));
  const changed = states.filter((entry) => entry.state === 'changed');
  const unknown = states.some((entry) => entry.state === 'unknown');

  let state = 'unchanged';
  if (changed.length === refs.length) state = 'changed';
  else if (changed.length > 0) state = 'partial';
  if (unknown && state !== 'changed') state = 'partial';

  return {
    state,
    changedRefs: changed.map((entry) => entry.ref?.source_id ?? null),
    changedSources: [...new Set(changed.map((entry) => entry.ref?.source_id).filter(Boolean))].sort(),
  };
}

export function diffSnapshots(a, b, inputA, inputB) {
  const changed = changedSourceIds(inputA, inputB);
  const before = new Map((a?.observations ?? []).map((o) => [claimKey(o), o]));
  const after = new Map((b?.observations ?? []).map((o) => [claimKey(o), o]));

  const same = [];
  const dropped = [];
  const added = [];
  let spanMoves = 0;
  for (const [key, observation] of before) {
    if (after.has(key)) {
      same.push({ key, claim: observation.claim });
      if (spanMoved(observation, after.get(key))) spanMoves += 1;
    } else {
      dropped.push({ key, claim: observation.claim, obs: observation, from: inputA, against: inputB });
    }
  }
  for (const [key, observation] of after) {
    if (!before.has(key)) added.push({ key, claim: observation.claim, obs: observation, from: inputB, against: inputA });
  }

  const changedEvidenceSources = new Set();
  const classify = (entry) => {
    const verdict = evidenceStateOf(entry.obs, entry.from, entry.against);
    for (const id of verdict.changedSources) changedEvidenceSources.add(id);
    return verdict.state;
  };

  const justified = [];
  const partially_justified = [];
  const silent_drift = [];
  for (const entry of dropped) {
    const state = classify(entry);
    if (state === 'changed') justified.push(entry.claim);
    else if (state === 'partial') partially_justified.push(entry.claim);
    else silent_drift.push(entry.claim);
  }
  const spurious_innovation = [];
  for (const entry of added) {
    const state = classify(entry);
    if (state === 'changed') justified.push(entry.claim);
    else if (state === 'partial') partially_justified.push(entry.claim);
    else spurious_innovation.push(entry.claim);
  }

  const deltas = added.length + dropped.length;

  return {
    // Coarse view, kept for comparison: sources whose whole hash differs.
    changed_sources: changed,
    // Fine view: sources whose cited region actually changed under a delta.
    changed_evidence_sources: [...changedEvidenceSources].sort(),
    same,
    added: added.map((e) => e.claim),
    dropped: dropped.map((e) => e.claim),
    justified,
    partially_justified,
    silent_drift,
    spurious_innovation,
    justified_fraction: deltas === 0 ? 1 : justified.length / deltas,
    monotone_in_evidence: silent_drift.length === 0,
    // The document changed but no delta rests on evidence that changed.
    hash_only_change: changed.length > 0 && changedEvidenceSources.size === 0,
    // Claims that kept their evidence but not their offset: the needle moved.
    span_moves: spanMoves,
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
