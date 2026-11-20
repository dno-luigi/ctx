/**
 * Structured context artifact.
 *
 * Seven sections, kept separate because merging them is how a model's guess becomes an established
 * fact:
 *
 *   source_facts          read from disk. No model involvement.
 *   observations          model-derived, each with its citation check result.
 *   verified_conclusions  observations whose citation resolved, labelled `stated`, and whose kind
 *                         can be concluded. "Verified" means the citation resolves; it does not
 *                         mean the statement is true.
 *   inferences            derived or inferred observations, and anything with a failed citation.
 *   questions             unresolved questions from the material.
 *   historical_state      the prior snapshot's conclusions, when this is a reconstruction.
 *   current_state         state / outstanding / risk findings of this scan.
 *
 * Only `source_facts` is authoritative. Everything else is derived and says so.
 */

import { digest } from '../../src/canonical.js';
import { CONCLUDABLE } from './scan.js';

export const SNAPSHOT_SCHEMA = 'context-engine/snapshot/v1';

const byKind = (findings, kinds) => findings.filter((finding) => kinds.includes(finding.kind));

export function buildSnapshot({ acquisition, partitionInfo, aggregated, calls, previous = null, scanMeta = {} }) {
  const findings = aggregated.findings;
  // A stale or invalidated finding keeps its place in observations but cannot be a conclusion.
  const verified = findings.filter((finding) => finding.verification === 'citation_verified' && finding.certainty === 'stated' && CONCLUDABLE.has(finding.kind) && finding.status !== 'stale' && finding.status !== 'invalidated');
  const inferences = findings.filter((finding) => !verified.includes(finding));

  const sourceFacts = acquisition.sources.map((source) => ({
    source_id: source.source_id,
    kind: source.kind,
    bytes: source.bytes,
    lines: source.lines,
    sha256: source.sha256,
    mtime: source.mtime,
    authoritative: true,
  }));

  const coverageRatio = acquisition.sources.length ? Number((aggregated.stats.sources_cited / acquisition.sources.length).toFixed(4)) : 0;

  const body = {
    schema: SNAPSHOT_SCHEMA,
    engine: 'context-engine/0.1.0',
    subject: {
      root: acquisition.root,
      acquired_at: new Date().toISOString(),
      source_digest: acquisition.digest,
      files: acquisition.totals.files,
      bytes: acquisition.totals.bytes,
      skipped: acquisition.skipped,
      source_facts: sourceFacts,
    },
    scan: {
      provider: scanMeta.provider ?? null,
      model: scanMeta.model ?? null,
      upstream: calls.map((call) => call.provider?.upstream ?? null).filter(Boolean),
      generation_ids: calls.map((call) => call.provider?.generation_id ?? null).filter(Boolean),
      partitions: partitionInfo?.partition_count ?? calls.length,
      strategy: scanMeta.strategy ?? (calls.length > 1 ? 'partitioned' : 'single_pass'),
      partition_budget_tokens: scanMeta.partition_budget_tokens ?? null,
      partition_budget_source: scanMeta.partition_budget_source ?? null,
      partition_budget_notes: scanMeta.partition_budget_notes ?? [],
      partition_reason: scanMeta.partition_reason ?? null,
      max_output_tokens: scanMeta.max_output_tokens ?? null,
      calls: calls.length,
      usage: {
        input_tokens: sumOrNull(calls.map((call) => call.usage?.input_tokens)),
        output_tokens: sumOrNull(calls.map((call) => call.usage?.output_tokens)),
        cost_usd: sumOrNull(calls.map((call) => call.usage?.cost_usd)),
        cost_source: calls.every((call) => call.usage?.cost_source === 'not_applicable') ? 'not_applicable' : calls.every((call) => call.usage?.cost_source === 'provider') ? 'provider' : 'mixed_or_catalogue',
      },
      latency_ms: calls.reduce((sum, call) => sum + (call.latency_ms ?? 0), 0),
      problems: calls.flatMap((call) => call.problems ?? []),
    },
    sections: {
      source_facts: sourceFacts,
      observations: findings,
      verified_conclusions: verified.map((finding) => ({
        kind: finding.kind,
        text: finding.text,
        evidence: finding.evidence,
        entities: finding.entities,
      })),
      inferences: inferences.map((finding) => ({
        kind: finding.kind,
        text: finding.text,
        certainty: finding.certainty,
        verification: finding.verification,
        evidence: finding.evidence,
        flags: finding.flags,
      })),
      questions: aggregated.questions,
      historical_state: previous
        ? {
            from_snapshot: previous.snapshot_id,
            source_digest: previous.subject?.source_digest ?? null,
            verified_conclusions: previous.sections?.verified_conclusions?.map((entry) => entry.text) ?? [],
            decisions: (previous.sections?.verified_conclusions ?? []).filter((entry) => entry.kind === 'decision').map((entry) => entry.text),
          }
        : null,
      current_state: {
        state: byKind(findings, ['state']).map((finding) => finding.text),
        outstanding: byKind(findings, ['outstanding']).map((finding) => finding.text),
        risks: byKind(findings, ['risk']).map((finding) => finding.text),
      },
    },
    architecture: {
      components: byKind(findings, ['architecture', 'responsibility']).map((finding) => ({ text: finding.text, kind: finding.kind, evidence: finding.evidence })),
      dependencies: byKind(findings, ['dependency']).map((finding) => ({ text: finding.text, evidence: finding.evidence })),
      relationships: aggregated.relationships,
    },
    contradictions: aggregated.contradictions,
    coverage: {
      sources_total: acquisition.sources.length,
      sources_cited: aggregated.stats.sources_cited,
      sources_unexamined: aggregated.unexamined_sources,
      citation_coverage: coverageRatio,
      findings: aggregated.stats.findings,
      verified_citations: aggregated.stats.verified_citations,
      failed_citations: aggregated.stats.failed_citations,
      cross_partition_relationships: aggregated.stats.cross_partition_relationships,
      duplicate_findings_merged: aggregated.stats.duplicates_merged,
    },
    manifest: {
      model_derived: true,
      authoritative_source: 'subject.source_facts',
      notes: [
        'verified_conclusions are citation-verified, not truth-adjudicated',
        'inferences includes every finding that was not citation-verified or was labelled derived/inferred',
        'sources_unexamined is a coverage gap, not evidence that a file is irrelevant',
      ],
    },
  };

  const snapshotDigest = digest(body);
  return {
    ...body,
    snapshot_id: `snap-${snapshotDigest.replace('sha256:', '').slice(0, 16)}`,
    digest: snapshotDigest,
  };
}

function sumOrNull(values) {
  const present = values.filter((value) => typeof value === 'number' && Number.isFinite(value));
  if (!present.length) return null;
  return Number(present.reduce((sum, value) => sum + value, 0).toFixed(12));
}
