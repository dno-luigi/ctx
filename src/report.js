function pct(value) {
  if (value === null || value === undefined) return '—';
  return `${(value * 100).toFixed(0)}%`;
}

function money(value) {
  if (value === null || value === undefined) return '—';
  return `$${Number(value).toFixed(4)}`;
}

export function renderMarkdown(report) {
  const lines = [];
  lines.push(`# GCA run ${report.run.id}`, '');
  lines.push(`- harness: \`${report.harness_version}\` at ${report.run.at}`);
  lines.push(`- provider: \`${report.run.provider}\`${report.run.quality ? ` (stub quality: ${report.run.quality})` : ''}`);
  lines.push(`- repetitions per fixture: ${report.run.repetitions}`);
  lines.push(`- fixtures run: ${report.run.fixtures.join(', ') || 'none'}`);
  if (report.run.skipped.length) {
    lines.push(`- fixtures skipped: ${report.run.skipped.map((s) => `${s.id} (${s.reason})`).join(', ')}`);
  }
  lines.push(`- thresholds: \`${report.thresholds.file}\` \`${report.thresholds.digest}\``, '');
  lines.push(`Total calls: ${report.totals.calls} · valid snapshots: ${report.totals.valid} · invalid: ${report.totals.invalid} · spend: ${money(report.totals.cost_usd)}`, '');

  lines.push('## Verdict against pre-registered thresholds', '');
  lines.push('| model | citation integrity | required coverage | abstention | injection | consistency | forbidden | $/pass | p95 | verdict |');
  lines.push('|---|---|---|---|---|---|---|---|---|---|');
  for (const entry of report.models) {
    const m = entry.grade.metrics;
    lines.push(
      `| \`${entry.slug}\` | ${pct(m.citation_integrity)} | ${pct(m.coverage)} | ${pct(m.abstention_accuracy)} | ${pct(
        m.injection_pass_rate
      )} | ${pct(m.consistency)} | ${m.forbidden_hits} | ${money(m.cost_per_pass_usd)} | ${
        m.p95_latency_ms ?? '—'
      } ms | ${entry.grade.pass ? 'pass' : '**FAIL**'} |`
    );
  }
  lines.push('');

  for (const entry of report.models) {
    lines.push(`### \`${entry.slug}\``, '');
    lines.push('| fixture | valid/reps | coverage | abstain | conflict | injection | jaccard | notes |');
    lines.push('|---|---|---|---|---|---|---|---|');
    for (const grade of entry.grade.per_fixture) {
      const notes = [];
      if (grade.coverage.missing.length) notes.push(`missing: ${grade.coverage.missing.join(', ')}`);
      if (grade.forbidden_hits) notes.push(`forbidden claims: ${grade.forbidden_hits}`);
      if (grade.invalid_snapshots) notes.push(`${grade.invalid_snapshots} invalid`);
      lines.push(
        `| ${grade.fixture} | ${grade.valid_snapshots}/${grade.repetitions} | ${pct(grade.coverage.mean)} | ${pct(
          grade.abstention.pass_rate
        )} | ${pct(grade.conflict.pass_rate)} | ${pct(grade.injection.pass_rate)} | ${pct(
          grade.consistency.jaccard_mean
        )} | ${notes.join('; ') || '—'} |`
      );
    }
    lines.push('');
    lines.push(`placement signal (advisory, not a decision): **${entry.placement.signal}** — ${entry.placement.why}`, '');
  }

  if (report.rda.length) {
    lines.push('## Recursive differential assessment', '');
    lines.push('| model | from → to | changed sources | same | added | dropped | silent drift | spurious | justified |');
    lines.push('|---|---|---|---|---|---|---|---|---|');
    for (const row of report.rda) {
      lines.push(
        `| \`${row.model}\` | ${row.from} → ${row.to} | ${row.changed_sources.length} | ${row.same} | ${row.added} | ${
          row.dropped
        } | ${row.silent_drift} | ${row.spurious_innovation} | ${pct(row.justified_fraction)} |`
      );
    }
    lines.push('');
    lines.push(
      'Silent drift is a claim that vanished while every source it cited stayed identical. Spurious innovation is a claim that appeared with no change to any source it cites. Both should be zero; a model with either is not repeatable enough to sit in a live path.',
      ''
    );
  }

  if (report.invalid_details.length) {
    lines.push('## Rejected snapshots', '');
    for (const detail of report.invalid_details) {
      lines.push(`- \`${detail.model}\` / ${detail.fixture} / repeat ${detail.repeat}:`);
      for (const error of detail.errors.slice(0, 6)) lines.push(`  - ${error}`);
      if (detail.errors.length > 6) lines.push(`  - … ${detail.errors.length - 6} more`);
    }
    lines.push('');
  }

  lines.push('## Not run', '');
  for (const item of report.not_run) lines.push(`- ${item}`);
  lines.push('');
  lines.push('## Limits of this report', '');
  for (const item of report.limitations) lines.push(`- ${item}`);
  lines.push('');
  return lines.join('\n');
}
