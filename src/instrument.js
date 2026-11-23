/**
 * Instrumentation.
 *
 * One record per provider call: model, upstream, generation id, tokens, provider charge, catalogue
 * product, latency, partition, coverage and validation result. Missing numbers stay null; a missing
 * charge is never replaced by an estimate.
 *
 * The engine's total cost is a sum over records that reported a number, plus an explicit count of
 * records that did not. Summing nulls as zero would make an unmeasured run look free.
 */

export class Instrument {
  constructor({ path = null, clock = () => new Date().toISOString() } = {}) {
    this.path = path;
    this.clock = clock;
    this.records = [];
  }

  record(entry) {
    const record = { schema: 'context-engine/instrumentation/v1', at: this.clock(), ...entry };
    this.records.push(record);
    return record;
  }

  summary() {
    const measured = this.records.filter((entry) => typeof entry.cost_usd === 'number');
    const unmeasured = this.records.length - measured.length;
    const input = this.records.filter((entry) => typeof entry.input_tokens === 'number');
    // A run whose only calls are `not_applicable` (the stub) is not a mixed or catalogue-priced run.
    const costSources = new Set(this.records.map((entry) => entry.cost_source ?? 'absent'));
    const costSource = costSources.size === 1 ? [...costSources][0] : 'mixed_or_catalogue';
    return {
      calls: this.records.length,
      measured_calls: measured.length,
      unmeasured_calls: unmeasured,
      input_tokens: input.length ? input.reduce((sum, entry) => sum + entry.input_tokens, 0) : null,
      output_tokens: this.records.some((entry) => typeof entry.output_tokens === 'number')
        ? this.records.reduce((sum, entry) => sum + (entry.output_tokens ?? 0), 0)
        : null,
      cost_usd: measured.length ? Number(measured.reduce((sum, entry) => sum + entry.cost_usd, 0).toFixed(12)) : null,
      cost_source: measured.length ? costSource : 'absent',
      latency_ms: this.records.reduce((sum, entry) => sum + (entry.latency_ms ?? 0), 0),
      partitions: new Set(this.records.map((entry) => entry.partition)).size,
      validation: {
        quotes_checked: this.records.reduce((sum, entry) => sum + (entry.quotes_checked ?? 0), 0),
        quotes_failed: this.records.reduce((sum, entry) => sum + (entry.quotes_failed ?? 0), 0),
      },
      note: unmeasured ? `${unmeasured} call(s) reported no charge; the total is not a complete cost figure` : null,
    };
  }

  toJSONL() {
    return this.records.map((entry) => JSON.stringify(entry)).join('\n') + (this.records.length ? '\n' : '');
  }
}

/** Convert scan calls (from scanPartitions) into instrumentation records. */
export function recordsFromCalls({ calls, providerKind, model, sourcesTotal }) {
  return calls.map((call) => ({
    model: call.model,
    requested_model: call.provider?.requested ?? call.model,
    resolved_model: call.provider?.resolved_model ?? null,
    upstream_provider: call.provider?.upstream ?? null,
    generation_id: call.provider?.generation_id ?? null,
    finish_reason: call.finish_reason ?? call.provider?.finish_reason ?? null,
    input_tokens: call.usage?.input_tokens ?? null,
    output_tokens: call.usage?.output_tokens ?? null,
    cost_usd: call.usage?.cost_usd ?? null,
    cost_source: call.usage?.cost_source ?? 'absent',
    catalogue_cost_usd: call.usage?.catalogue_cost_usd ?? null,
    latency_ms: call.latency_ms ?? null,
    partition: call.partition,
    partitions_total: calls.length,
    sources_examined: call.sources?.length ?? 0,
    sources_total: sourcesTotal ?? null,
    findings: call.findings ?? null,
    quotes_checked: call.findings ?? null,
    quotes_failed: (call.findings ?? 0) - (call.verified ?? 0),
    provider_kind: providerKind ?? null,
    model_slug: model ?? null,
    failed: call.failed ?? false,
  }));
}
