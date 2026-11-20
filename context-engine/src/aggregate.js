/**
 * Hierarchical aggregation.
 *
 * Merges partition results without upgrading anything: a duplicate merge keeps the original
 * certainty, and citations are unioned rather than replaced. Cross-partition relationships are
 * identified from the partition map, so a relationship that only becomes visible when two
 * partitions are read together is marked as such instead of disappearing.
 *
 * Sources that produced no finding are reported as `unexamined`, which is a coverage fact, not a
 * claim that they contain nothing.
 */

import { FINDING_KINDS } from './scan.js';
import { digest } from '../../src/canonical.js';

const fold = (text) => String(text ?? '').toLowerCase().replace(/\s+/g, ' ').replace(/[.,;:]+$/, '').trim();

const mergeSources = (left = [], right = []) => {
  const seen = new Set(left.map((entry) => `${entry.source_id}|${entry.quote}`));
  const merged = [...left];
  for (const entry of right) {
    const key = `${entry.source_id}|${entry.quote}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(entry);
  }
  return merged;
};

/** Exact same normalised subject and key with different numeric values is a contradiction candidate. */
export function detectNumericConflicts(findings) {
  const byKey = new Map();
  for (const finding of findings) {
    for (const evidence of finding.evidence ?? []) {
      const pattern = /\b([A-Za-z_][\w.-]{2,})\s*(?:=|:)\s*"?(\d+(?:\.\d+)?)"?/g;
      let match;
      while ((match = pattern.exec(evidence.quote)) !== null) {
        const key = match[1].toLowerCase();
        if (!byKey.has(key)) byKey.set(key, new Map());
        const values = byKey.get(key);
        if (!values.has(match[2])) values.set(match[2], []);
        values.get(match[2]).push({ source_id: evidence.source_id, quote: evidence.quote, line: evidence.line });
      }
    }
  }
  const conflicts = [];
  for (const [key, values] of byKey) {
    if (values.size < 2) continue;
    const entries = [...values.entries()].map(([value, refs]) => ({ value, refs }));
    conflicts.push({
      kind: 'numeric',
      key,
      values: entries,
      text: `${key} is given ${entries.map((entry) => entry.value).join(' and ')} in different places`,
      evidence: entries.flatMap((entry) => entry.refs).slice(0, 8),
    });
  }
  return conflicts;
}

export function aggregate({ partitionResults, acquisition, partitions }) {
  const partitionOf = new Map();
  for (const partition of partitions) for (const sourceId of partition.source_ids) {
    if (!partitionOf.has(sourceId)) partitionOf.set(sourceId, []);
    partitionOf.get(sourceId).push(partition.partition_id);
  }

  const byKey = new Map();
  for (const result of partitionResults) {
    for (const finding of result.findings) {
      const key = `${finding.kind}|${fold(finding.text)}`;
      if (!byKey.has(key)) {
        byKey.set(key, { ...finding, merged_from: [finding.partition], partitions: [finding.partition] });
        continue;
      }
      const existing = byKey.get(key);
      existing.evidence = mergeSources(existing.evidence, finding.evidence);
      existing.flags = [...(existing.flags ?? []), ...(finding.flags ?? [])];
      existing.entities = [...new Set([...(existing.entities ?? []), ...(finding.entities ?? [])])];
      existing.merged_from.push(finding.partition);
      existing.partitions = [...new Set([...existing.partitions, finding.partition])];
      // Never upgrade: a merge does not turn an inference into a stated fact.
      if (existing.verification !== 'citation_verified' && finding.verification === 'citation_verified' && existing.certainty === finding.certainty) existing.verification = 'citation_verified';
    }
  }
  const findings = [...byKey.values()];

  const relationshipKey = (entry) => `${fold(entry.from)}|${fold(entry.to)}|${entry.type}`;
  const relationshipMap = new Map();
  for (const result of partitionResults) {
    for (const relationship of result.relationships) {
      const key = relationshipKey(relationship);
      if (!relationshipMap.has(key)) {
        relationshipMap.set(key, { ...relationship, evidence: [...(relationship.evidence ?? [])], partitions: [relationship.partition] });
        continue;
      }
      const existing = relationshipMap.get(key);
      existing.evidence = mergeSources(existing.evidence, relationship.evidence);
      existing.partitions = [...new Set([...existing.partitions, relationship.partition])];
      if (existing.verification !== 'citation_verified' && relationship.verification === 'citation_verified') existing.verification = 'citation_verified';
    }
  }
  const relationships = [...relationshipMap.values()].map((relationship) => {
    const fromParts = partitionOf.get(relationship.from) ?? [];
    const toParts = partitionOf.get(relationship.to) ?? [];
    return { ...relationship, cross_partition: fromParts.length && toParts.length && fromParts.join() !== toParts.join() };
  });

  const contradictionKey = (entry) => `${fold(entry.text)}`;
  const contradictions = new Map();
  for (const result of partitionResults) for (const entry of result.contradictions) {
    if (!contradictions.has(contradictionKey(entry))) contradictions.set(contradictionKey(entry), { ...entry, evidence: [...(entry.evidence ?? [])] });
    else contradictions.get(contradictionKey(entry)).evidence = mergeSources(contradictions.get(contradictionKey(entry)).evidence, entry.evidence);
  }

  const numericConflicts = detectNumericConflicts(findings);
  for (const conflict of numericConflicts) {
    const key = fold(conflict.text);
    if (!contradictions.has(key)) {
      contradictions.set(key, {
        text: conflict.text,
        between: [...new Set(conflict.evidence.map((entry) => entry.source_id))],
        partition: null,
        verification: 'derived_from_quotes',
        evidence: conflict.evidence,
        numeric: true,
      });
    }
  }

  const questions = new Map();
  for (const result of partitionResults) for (const question of result.questions) {
    if (!questions.has(fold(question.text))) questions.set(fold(question.text), { ...question });
  }

  const cited = new Set(findings.flatMap((finding) => finding.evidence.map((entry) => entry.source_id)));
  const unexamined = acquisition.sources.filter((source) => !cited.has(source.source_id)).map((source) => source.source_id);
  const kinds = Object.fromEntries(FINDING_KINDS.map((kind) => [kind, findings.filter((finding) => finding.kind === kind).length]));

  const stats = {
    findings: findings.length,
    findings_before_merge: partitionResults.reduce((sum, result) => sum + result.findings.length, 0),
    duplicates_merged: partitionResults.reduce((sum, result) => sum + result.findings.length, 0) - findings.length,
    verified_citations: findings.filter((finding) => finding.verification === 'citation_verified').length,
    failed_citations: findings.filter((finding) => finding.verification !== 'citation_verified').length,
    relationships: relationships.length,
    cross_partition_relationships: relationships.filter((relationship) => relationship.cross_partition).length,
    contradictions: contradictions.size,
    questions: questions.size,
    sources_cited: cited.size,
    sources_unexamined: unexamined.length,
    kinds,
  };

  const aggregated = {
    schema: 'context-engine/aggregate/v1',
    findings,
    relationships,
    contradictions: [...contradictions.values()],
    questions: [...questions.values()],
    unexamined_sources: unexamined,
    stats,
  };
  return { ...aggregated, digest: digest(aggregated) };
}
