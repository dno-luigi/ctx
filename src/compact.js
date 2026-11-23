/**
 * Context compaction.
 *
 * A pack is a working set, not a summary. It selects whole items in priority order, never rewrites
 * them, never paraphrases, and records everything it could not fit — with that item's source
 * references — so the agent can go back to the source instead of trusting the absence.
 *
 * Tokens are estimated with ceil(chars/4) for budgeting only. A pack never claims completeness:
 * `coverage.items_total` and `omissions` are always present, and `reconstructible` is true only when
 * every retained item has a resolvable source reference.
 */

import { digest } from '../src/canonical.js';

export const PACK_SCHEMA = 'context-engine/pack/v1';

export const PACK_PROFILES = {
  small: { maxTokens: 1500, reserve_ratio: 0.2 },
  medium: { maxTokens: 4000, reserve_ratio: 0.18 },
  large: { maxTokens: 10000, reserve_ratio: 0.15 },
};

export const estimateTokens = (value) => Math.ceil(String(typeof value === 'string' ? value : JSON.stringify(value)).length / 4);

const refsOf = (evidence = []) =>
  evidence.map((entry) => ({
    path: entry.source_id,
    line: entry.line ?? null,
    quote: entry.quote,
    sha256: entry.sha256 ?? null,
  }));

const item = (section, priority, text, evidence, extra = {}) => ({
  id: extra.id ?? `${section}:${digest({ text }).replace('sha256:', '').slice(0, 10)}`,
  section,
  priority,
  text,
  sources: refsOf(evidence),
  ...extra,
});

export function collectItems(snapshot) {
  const items = [];
  const verified = snapshot.sections?.verified_conclusions ?? [];
  const inferences = snapshot.sections?.inferences ?? [];
  const observations = snapshot.sections?.observations ?? [];
  const usable = (finding) => finding.verification === 'citation_verified' && finding.status !== 'stale' && finding.status !== 'invalidated';

  // 1. Instructions and invariants: the things that must not be silently lost.
  for (const finding of verified.filter((entry) => entry.kind === 'invariant')) items.push(item('invariants', 1, finding.text, finding.evidence));
  for (const finding of observations.filter((entry) => entry.kind === 'invariant' && !usable(entry))) items.push(item('invariants', 1, finding.text, finding.evidence, { caveat: 'citation_not_verified' }));

  // 2. Current state and outstanding work.
  for (const finding of verified.filter((entry) => entry.kind === 'state')) items.push(item('current_state', 2, finding.text, finding.evidence));
  for (const finding of verified.filter((entry) => entry.kind === 'outstanding')) items.push(item('outstanding', 2, finding.text, finding.evidence));
  for (const finding of observations.filter((entry) => entry.kind === 'outstanding' && !usable(entry))) items.push(item('outstanding', 2, finding.text, finding.evidence, { caveat: 'citation_not_verified' }));

  // 3. Architecture and dependencies.
  for (const finding of verified.filter((entry) => ['architecture', 'responsibility'].includes(entry.kind))) items.push(item('architecture', 3, finding.text, finding.evidence));
  for (const finding of verified.filter((entry) => entry.kind === 'dependency')) items.push(item('dependencies', 3, finding.text, finding.evidence));
  for (const relationship of snapshot.architecture?.relationships ?? []) {
    if (!relationship.verification || relationship.verification === 'citation_verified') {
      items.push(item('dependencies', 3, `${relationship.from} ${relationship.type} ${relationship.to}`, relationship.evidence ?? [], { relationship: true }));
    }
  }

  // 4. Decisions and rationale.
  for (const finding of verified.filter((entry) => entry.kind === 'decision')) items.push(item('decisions', 4, finding.text, finding.evidence));

  // 5. Known failures, risks and open contradictions. A contradiction is decision-relevant state:
  // omitting it lets an agent read a one-sided account of something the source disagrees about.
  for (const finding of verified.filter((entry) => entry.kind === 'risk')) items.push(item('failures', 5, finding.text, finding.evidence));
  for (const contradiction of snapshot.contradictions ?? []) {
    items.push(item('contradictions', 5, contradiction.text, contradiction.evidence ?? [], { contradiction: true, caveat: 'unresolved' }));
  }

  // 6. Open questions, explicitly not answers.
  for (const question of snapshot.sections?.questions ?? []) items.push(item('questions', 6, question.text, [], { open_question: true }));

  // Deduplicate by section+text, keeping the highest-priority occurrence.
  const seen = new Map();
  for (const entry of items) {
    const key = `${entry.section}|${entry.text.toLowerCase()}`;
    if (!seen.has(key) || seen.get(key).priority > entry.priority) seen.set(key, entry);
  }

  // 7. Inferences are never mixed into the sections above; they are offered last and labelled.
  for (const finding of inferences.filter((entry) => entry.certainty === 'inferred')) {
    const entry = item('inferences', 8, finding.text, finding.evidence, { caveat: finding.verification === 'citation_verified' ? 'inferred_reading' : 'citation_not_verified' });
    const key = `${entry.section}|${entry.text.toLowerCase()}`;
    if (!seen.has(key)) seen.set(key, entry);
  }
  return [...seen.values()];
}

export function compact({ snapshot, profile = 'medium', maxTokens }) {
  const chosenProfile = PACK_PROFILES[profile] ?? PACK_PROFILES.medium;
  const budget = maxTokens ?? chosenProfile.maxTokens;
  const reserve = Math.ceil(budget * chosenProfile.reserve_ratio);
  const contentBudget = Math.max(0, budget - reserve);

  const items = collectItems(snapshot).sort((a, b) => a.priority - b.priority || String(a.id).localeCompare(String(b.id)));
  const included = [];
  const omissions = [];
  let used = estimateTokens({ profile, budget });
  for (const entry of items) {
    const cost = estimateTokens(entry);
    if (used + cost <= contentBudget) {
      included.push(entry);
      used += cost;
    } else {
      omissions.push({
        id: entry.id,
        section: entry.section,
        priority: entry.priority,
        text: entry.text,
        sources: entry.sources,
        reason: 'budget',
      });
    }
  }

  const sections = {};
  for (const entry of included) {
    if (!sections[entry.section]) sections[entry.section] = [];
    sections[entry.section].push({ id: entry.id, text: entry.text, sources: entry.sources, ...(entry.caveat ? { caveat: entry.caveat } : {}), ...(entry.relationship ? { relationship: true } : {}), ...(entry.contradiction ? { contradiction: true } : {}) });
  }

  const sourceIndex = [];
  const seenSources = new Set();
  for (const entry of included) {
    for (const ref of entry.sources) {
      const key = `${ref.path}|${ref.line ?? ''}`;
      if (seenSources.has(key)) continue;
      seenSources.add(key);
      sourceIndex.push(ref);
    }
  }

  const body = {
    schema: PACK_SCHEMA,
    profile,
    budget_tokens_estimate: budget,
    used_tokens_estimate: used,
    subject: {
      root: snapshot.subject?.root ?? null,
      snapshot_id: snapshot.snapshot_id ?? null,
      source_digest: snapshot.subject?.source_digest ?? null,
      authoritative_source: 'the source tree, not this pack',
    },
    sections,
    source_index: sourceIndex,
    omissions,
    coverage: {
      items_total: items.length,
      items_included: included.length,
      items_omitted: omissions.length,
      citation_coverage: snapshot.coverage?.citation_coverage ?? null,
      sources_cited: snapshot.coverage?.sources_cited ?? null,
      sources_total: snapshot.coverage?.sources_total ?? null,
    },
    reconstructible: included.every((entry) => entry.open_question || entry.sources.length > 0),
    disclaimer: 'Selected context, not complete source truth. Omitted items remain listed with their source references.',
  };

  const packDigest = digest(body);
  return { ...body, pack_id: `pack-${packDigest.replace('sha256:', '').slice(0, 12)}`, digest: packDigest };
}

/** Render a pack for a human or an agent prompt. Whole items only; nothing is re-worded. */
export function renderPack(pack) {
  const lines = [`# Context pack ${pack.pack_id} (${pack.profile}, ~${pack.used_tokens_estimate} tokens)`,
    `Snapshot ${pack.subject.snapshot_id} · source digest ${String(pack.subject.source_digest).slice(0, 23)}…`,
    'Selected context, not complete source truth. Each item cites its source.', ''];
  const order = ['invariants', 'current_state', 'outstanding', 'architecture', 'dependencies', 'decisions', 'failures', 'contradictions', 'questions', 'inferences'];
  for (const section of order) {
    if (!pack.sections[section]?.length) continue;
    lines.push(`## ${section.replace(/_/g, ' ')}`);
    for (const entry of pack.sections[section]) {
      const caveat = entry.caveat ? ` [${entry.caveat}]` : '';
      lines.push(`- ${entry.text}${caveat}`);
      for (const ref of entry.sources) lines.push(`  - ${ref.path}${ref.line ? `:${ref.line}` : ''} — “${String(ref.quote).slice(0, 160)}”`);
    }
    lines.push('');
  }
  if (pack.omissions.length) {
    lines.push(`## omitted (${pack.omissions.length})`);
    for (const entry of pack.omissions) lines.push(`- ${entry.section}: ${entry.text} → ${entry.sources.map((ref) => ref.path).join(', ') || 'no source ref'}`);
    lines.push('');
  }
  return lines.join('\n');
}
