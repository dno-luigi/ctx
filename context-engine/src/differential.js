/**
 * Differential reconstruction (RDA).
 *
 * A rescan is a comparison, not a rebuild. Unchanged sources are not sent to the model again; their
 * findings are carried forward and re-checked against the current bytes. A carried citation whose
 * source changed or disappeared is marked stale or invalidated — it is never silently dropped and
 * never silently kept as verified.
 *
 * The delta is the audit of what moved. The source remains authoritative: a carried finding is only
 * as good as the quote it still resolves to.
 */

import { digest } from '../../src/canonical.js';
import { buildSnapshot } from './snapshot.js';
import { scanPartitions } from './scan.js';
import { aggregate } from './aggregate.js';
import { partitionSources, extractReferences } from './partition.js';

export const DELTA_SCHEMA = 'context-engine/delta/v1';

export function diffSources(previous, acquisition) {
  const before = new Map((previous?.subject?.source_facts ?? []).map((fact) => [fact.source_id, fact]));
  const after = new Map(acquisition.sources.map((source) => [source.source_id, source]));
  const added = [];
  const changed = [];
  const unchanged = [];
  const removed = [];
  for (const [sourceId, source] of after) {
    const prior = before.get(sourceId);
    if (!prior) added.push({ source_id: sourceId, sha256: source.sha256, bytes: source.bytes });
    else if (prior.sha256 !== source.sha256) changed.push({ source_id: sourceId, before_sha256: prior.sha256, sha256: source.sha256, bytes: source.bytes });
    else unchanged.push({ source_id: sourceId, sha256: source.sha256 });
  }
  for (const [sourceId, prior] of before) if (!after.has(sourceId)) removed.push({ source_id: sourceId, sha256: prior.sha256 });
  return {
    added: added.sort((a, b) => a.source_id.localeCompare(b.source_id)),
    changed: changed.sort((a, b) => a.source_id.localeCompare(b.source_id)),
    removed: removed.sort((a, b) => a.source_id.localeCompare(b.source_id)),
    unchanged: unchanged.sort((a, b) => a.source_id.localeCompare(b.source_id)),
  };
}

/** Carried findings keep their text; their evidence is re-resolved against the current acquisition. */
export function carryForward(previous, acquisition, diff) {
  const sourcesById = new Map(acquisition.sources.map((source) => [source.source_id, source]));
  const changed = new Set(diff.changed.map((entry) => entry.source_id));
  const removed = new Set(diff.removed.map((entry) => entry.source_id));
  const carried = [];
  for (const finding of previous?.sections?.observations ?? []) {
    const sourceIds = [...new Set((finding.evidence ?? []).map((entry) => entry.source_id))];
    let status = 'preserved';
    let reason = 'all_sources_unchanged';
    if (sourceIds.some((sourceId) => removed.has(sourceId))) {
      status = 'invalidated';
      reason = 'source_removed';
    } else if (sourceIds.some((sourceId) => changed.has(sourceId))) {
      status = 'stale';
      reason = 'source_changed';
    }
    const resolved = (finding.evidence ?? []).map((entry) => {
      const source = sourcesById.get(entry.source_id);
      if (!source) return { ...entry, resolved: false, why: 'source_absent' };
      const found = source.text.indexOf(entry.quote);
      if (found === -1) return { ...entry, resolved: false, why: 'quote_gone' };
      return { ...entry, resolved: true, sha256: source.sha256 };
    });
    if (status === 'preserved' && resolved.some((entry) => !entry.resolved)) {
      status = 'stale';
      reason = 'evidence_moved_within_unchanged_source';
    }
    carried.push({
      ...finding,
      status,
      status_reason: reason,
      carried_forward: true,
      evidence: resolved,
      verification: status === 'preserved' ? finding.verification : 'not_revalidated',
    });
  }
  return carried;
}

const fold = (text) => String(text ?? '').toLowerCase().replace(/\s+/g, ' ').replace(/[.,;:]+$/, '').trim();

/**
 * @returns {{delta, snapshot, calls, acquisition, partitionInfo}}
 */
export async function reconstruct({ previous, acquisition, provider, maxTokensPerPartition = 60000, maxCallTokens = 2200, scanMeta = {} }) {
  const diff = diffSources(previous, acquisition);
  const rescanIds = new Set([...diff.added, ...diff.changed].map((entry) => entry.source_id));
  const rescanSources = acquisition.sources.filter((source) => rescanIds.has(source.source_id));
  const references = extractReferences(acquisition.sources);

  let calls = [];
  let rescanAggregate = { findings: [], relationships: [], contradictions: [], questions: [], stats: { sources_cited: 0, sources_unexamined: 0, verified_citations: 0, failed_citations: 0, findings: 0, cross_partition_relationships: 0, duplicates_merged: 0 } };
  let partitionInfo = { partitions: [], partition_count: 0, cross_partition_references: [] };

  if (rescanSources.length) {
    partitionInfo = partitionSources(rescanSources, { maxTokens: maxTokensPerPartition });
    const scan = await scanPartitions({ provider, acquisition, partitions: partitionInfo.partitions, references, maxTokens: maxCallTokens });
    calls = scan.calls;
    const aggregateInput = {
      partitionResults: [{ findings: scan.findings, relationships: scan.relationships, contradictions: scan.contradictions, questions: scan.questions }],
      acquisition: { ...acquisition, sources: rescanSources },
      partitions: partitionInfo.partitions,
    };
    rescanAggregate = aggregate(aggregateInput);
  }

  const carried = carryForward(previous, acquisition, diff);
  const merged = new Map();
  for (const finding of carried) merged.set(`${finding.kind}|${fold(finding.text)}`, finding);
  let addedCount = 0;
  let updatedCount = 0;
  for (const finding of rescanAggregate.findings) {
    const key = `${finding.kind}|${fold(finding.text)}`;
    if (merged.has(key)) {
      updatedCount += 1;
      merged.set(key, { ...finding, updated_from: previous.snapshot_id });
    } else {
      addedCount += 1;
      merged.set(key, finding);
    }
  }
  const findings = [...merged.values()];

  const relationshipMap = new Map();
  for (const relationship of previous?.architecture?.relationships ?? []) relationshipMap.set(`${fold(relationship.from)}|${fold(relationship.to)}|${relationship.type}`, relationship);
  for (const relationship of rescanAggregate.relationships) relationshipMap.set(`${fold(relationship.from)}|${fold(relationship.to)}|${relationship.type}`, relationship);

  // Coverage is over the whole acquisition, not only the files that were rescanned: a carried
  // finding still counts as an examined source, and anything uncited by the merged set is a gap.
  const citedSources = new Set(findings.flatMap((finding) => (finding.evidence ?? []).map((entry) => entry.source_id)));
  const unexamined = acquisition.sources.filter((source) => !citedSources.has(source.source_id)).map((source) => source.source_id);

  const contradictions = [...(previous?.contradictions ?? []), ...(rescanAggregate.contradictions ?? [])];
  const questions = [...new Set([...(previous?.sections?.questions ?? []).map((question) => question.text), ...(rescanAggregate.questions ?? []).map((question) => question.text)])].map((text) => ({ text }));

  const snapshot = buildSnapshot({
    acquisition,
    partitionInfo,
    aggregated: {
      findings,
      relationships: [...relationshipMap.values()],
      contradictions,
      questions,
      unexamined_sources: unexamined,
      stats: {
        ...rescanAggregate.stats,
        sources_cited: citedSources.size,
        sources_unexamined: unexamined.length,
        findings: findings.length,
        verified_citations: findings.filter((finding) => finding.verification === 'citation_verified').length,
        failed_citations: findings.filter((finding) => finding.verification !== 'citation_verified').length,
      },
    },
    calls,
    previous,
    scanMeta,
  });

  const preserved = findings.filter((finding) => finding.status === 'preserved');
  const stale = findings.filter((finding) => finding.status === 'stale');
  const invalidated = findings.filter((finding) => finding.status === 'invalidated');
  const delta = {
    schema: DELTA_SCHEMA,
    from_snapshot: previous.snapshot_id,
    to_snapshot: snapshot.snapshot_id,
    source_digest_before: previous.subject?.source_digest ?? null,
    source_digest_after: acquisition.digest,
    sources: diff,
    rescanned: [...rescanIds],
    operations: [
      ...diff.added.map((entry) => ({ op: 'added', target: entry.source_id })),
      ...diff.changed.map((entry) => ({ op: 'modified', target: entry.source_id, before_sha256: entry.before_sha256, sha256: entry.sha256 })),
      ...diff.removed.map((entry) => ({ op: 'removed', target: entry.source_id })),
      ...preserved.map((finding) => ({ op: 'preserved', target: finding.kind, text: finding.text })),
      ...stale.map((finding) => ({ op: 'stale', target: finding.kind, text: finding.text, why: finding.status_reason })),
      ...invalidated.map((finding) => ({ op: 'invalidated', target: finding.kind, text: finding.text, why: finding.status_reason })),
      ...(rescanAggregate.contradictions ?? []).map((entry) => ({ op: 'conflict_open', target: 'contradiction', text: entry.text })),
    ],
    counts: {
      sources_added: diff.added.length,
      sources_changed: diff.changed.length,
      sources_removed: diff.removed.length,
      sources_unchanged: diff.unchanged.length,
      findings_preserved: preserved.length,
      findings_stale: stale.length,
      findings_invalidated: invalidated.length,
      findings_added: addedCount,
      findings_updated: updatedCount,
      calls: calls.length,
      rescan_files: rescanIds.size,
    },
    verification: {
      preserved_identical: preserved.every((finding) => {
        const prior = (previous.sections.observations ?? []).find((entry) => fold(entry.text) === fold(finding.text) && entry.kind === finding.kind);
        return prior && prior.text === finding.text;
      }),
      stale_retained: stale.every((finding) => finding.text.length > 0),
      invalidated_retained: invalidated.every((finding) => finding.text.length > 0),
      unchanged_sources_rescanned: diff.unchanged.filter((entry) => rescanIds.has(entry.source_id)).length,
      notes: [
        'preserved means the finding text is unchanged and all of its cited sources are byte-identical',
        'stale and invalidated findings remain visible in the snapshot observations but cannot be verified conclusions',
        'a rescan never writes to the source tree',
      ],
    },
  };

  return {
    delta: { ...delta, digest: digest(delta) },
    snapshot,
    calls,
    acquisition,
    partitionInfo,
    rescan: { aggregate: rescanAggregate, sources: rescanSources },
  };
}
