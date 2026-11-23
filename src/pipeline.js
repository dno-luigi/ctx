/**
 * Orchestration.
 *
 * Three entry points, each returning the artifacts it produced so a caller never has to infer what
 * happened:
 *   scanProject    acquire → partition → scan → verify → aggregate → snapshot
 *   updateProject  acquire → diff → rescan changed only → carry forward → delta + snapshot
 *   pack           snapshot → budgeted working set with omissions
 *
 * Nothing here writes to the source tree.
 */

import { acquire } from './source.js';
import { partitionSources, extractReferences } from './partition.js';
import { scanPartitions } from './scan.js';
import { aggregate } from './aggregate.js';
import { buildSnapshot } from './snapshot.js';
import { reconstruct } from './differential.js';
import { compact } from './compact.js';
import { Instrument, recordsFromCalls } from './instrument.js';
import { resolvePartitionBudget, chooseStrategy } from './budget.js';

export async function scanProject({
  root,
  provider,
  include,
  exclude,
  maxFiles = 500,
  maxFileBytes = 262144,
  partitionTokens = null,
  partitionPolicy = {},
  modelContextTokens = null,
  maxCallTokens = 8000,
  rootLabel = null,
  instrumentPath = null,
}) {
  const acquisition = await acquire({ root, include, exclude, maxFiles, maxFileBytes, rootLabel: rootLabel ?? undefined });
  const plan = resolvePartitionBudget({ policy: partitionPolicy, model: { context_tokens: modelContextTokens }, requestedTokens: partitionTokens });
  const partitionInfo = partitionSources(acquisition.sources, { maxTokens: plan.budget_tokens });
  const strategy = chooseStrategy({ estimatedTokens: partitionInfo.estimated_tokens_total, budgetTokens: plan.budget_tokens, partitions: partitionInfo.partition_count });
  const references = extractReferences(acquisition.sources);
  const scan = await scanPartitions({ provider, acquisition, partitions: partitionInfo.partitions, references, maxTokens: maxCallTokens });
  const aggregated = aggregate({ partitionResults: [{ ...scan }], acquisition, partitions: partitionInfo.partitions });
  const snapshot = buildSnapshot({
    acquisition,
    partitionInfo,
    aggregated,
    calls: scan.calls,
    scanMeta: {
      provider: provider.kind,
      model: provider.model?.slug ?? provider.id,
      strategy: strategy.mode,
      partition_budget_tokens: plan.budget_tokens,
      partition_budget_source: plan.source,
      partition_budget_notes: plan.notes,
      partition_reason: strategy.reason,
      max_output_tokens: maxCallTokens,
    },
  });

  const instrument = new Instrument({ path: instrumentPath });
  for (const record of recordsFromCalls({ calls: scan.calls, providerKind: provider.kind, model: provider.model?.slug ?? provider.id, sourcesTotal: acquisition.totals.files })) {
    instrument.record(record);
  }

  return { acquisition, partitionInfo, plan, strategy, scan, aggregated, snapshot, instrument };
}

export async function updateProject({ previousSnapshot, root, provider, include, exclude, maxFiles = 500, maxFileBytes = 262144, partitionTokens = null, partitionPolicy = {}, modelContextTokens = null,   maxCallTokens = 8000, rootLabel = null }) {
  const acquisition = await acquire({ root, include, exclude, maxFiles, maxFileBytes, rootLabel: rootLabel ?? undefined });
  const plan = resolvePartitionBudget({ policy: partitionPolicy, model: { context_tokens: modelContextTokens }, requestedTokens: partitionTokens });
  const result = await reconstruct({
    previous: previousSnapshot,
    acquisition,
    provider,
    maxTokensPerPartition: plan.budget_tokens,
    maxCallTokens,
    scanMeta: { provider: provider.kind, model: provider.model?.slug ?? provider.id, partition_budget_tokens: plan.budget_tokens, partition_budget_source: plan.source, max_output_tokens: maxCallTokens },
  });
  const instrument = new Instrument();
  for (const record of recordsFromCalls({ calls: result.calls, providerKind: provider.kind, model: provider.model?.slug ?? provider.id, sourcesTotal: acquisition.totals.files })) {
    instrument.record(record);
  }
  return { ...result, plan, instrument };
}

export function pack({ snapshot, profile = 'medium', maxTokens }) {
  return compact({ snapshot, profile, maxTokens });
}
