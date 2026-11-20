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
  lines.push(`- thresholds: \`${report.thresholds.file}\` \`${report.thresholds.digest}\``);
  lines.push(`- evidence archive: ${report.snapshots?.length ?? 0} snapshots in \`report.json\` → \`snapshots\` (input to adjudication, not a metric)`, '');
  lines.push(
    `Total calls: ${report.totals.calls} · valid snapshots: ${report.totals.valid} · invalid: ${report.totals.invalid} · spend: ${money(
      report.totals.cost_usd
    )}`,
    ''
  );

  lines.push('## Which hypothesis each metric serves', '');
  lines.push('| hypothesis | metric |');
  lines.push('|---|---|');
  lines.push('| global assessment — extraction across a large context | citation integrity, required coverage, silent drift |');
  lines.push('| contextual reasoning — evidence vs interpretation, contradiction, missing information | relevance (trap citations), conflict, abstention, lexical overreach + adjudication queue |');
  lines.push('| recursive differential reasoning — meaningful change without unexplained drift | consistency, claim stability, justified fraction, silent drift, spurious innovation |');
  lines.push('');
  lines.push(
    'The middle row is the least settled: only declared traps are graded mechanically, and the rest of it is a queue for a human. A run that reports it as scored would be overstating the harness.',
    ''
  );

  lines.push('## Verdict against pre-registered thresholds', '');
  lines.push(
    '| model | citation integrity | relevance | coverage | abstention | injection | consistency | forbidden | $/pass | p95 | verdict |'
  );
  lines.push('|---|---|---|---|---|---|---|---|---|---|---|');
  for (const entry of report.models) {
    const m = entry.grade.metrics;
    lines.push(
      `| \`${entry.slug}\` | ${pct(m.citation_integrity)} | ${pct(m.relevance_support_rate)} | ${pct(m.coverage)} | ${pct(
        m.abstention_accuracy
      )} | ${pct(m.injection_pass_rate)} | ${pct(m.consistency)} | ${m.forbidden_hits} | ${money(
        m.cost_per_pass_usd
      )} | ${m.p95_latency_ms ?? '—'} ms | ${entry.grade.pass ? 'pass' : '**FAIL**'} |`
    );
  }
  lines.push('');

  for (const entry of report.models) {
    lines.push(`### \`${entry.slug}\``, '');
    lines.push('| fixture | valid/reps | coverage | abstain | conflict | injection | jaccard | relevance | overreach | notes |');
    lines.push('|---|---|---|---|---|---|---|---|---|---|');
    for (const grade of entry.grade.per_fixture) {
      const notes = [];
      if (grade.coverage.missing.length) notes.push(`missing: ${grade.coverage.missing.join(', ')}`);
      if (grade.forbidden_hits) notes.push(`forbidden claims: ${grade.forbidden_hits}`);
      if (grade.invalid_snapshots) notes.push(`${grade.invalid_snapshots} invalid`);
      if (grade.evidence.authenticity.ambiguous) notes.push(`${grade.evidence.authenticity.ambiguous} ambiguous refs`);
      const relevance = grade.evidence.relevance.declared ? `${pct(grade.evidence.relevance.pass_rate)} (${grade.evidence.relevance.trap_citations} traps)` : 'not declared';
      lines.push(
        `| ${grade.fixture} | ${grade.valid_snapshots}/${grade.repetitions} | ${pct(grade.coverage.mean)} | ${pct(
          grade.abstention.pass_rate
        )} | ${pct(grade.conflict.pass_rate)} | ${pct(grade.injection.pass_rate)} | ${pct(
          grade.consistency.jaccard_mean
        )} | ${relevance} | ${grade.evidence.inference.overreach_flags} | ${notes.join('; ') || '—'} |`
      );
    }
    lines.push('');
    lines.push(`placement signal (advisory, not a decision): **${entry.placement.signal}** — ${entry.placement.why}`, '');
  }

  lines.push('## Evidence layers', '');
  lines.push('Three things are measured separately and never averaged into one number:', '');
  lines.push('| layer | question | how |');
  lines.push('|---|---|---|');
  lines.push('| 1 authenticity | does the quote exist verbatim in the cited source? | mechanical: exact match, and a repeated quote is rejected as ambiguous unless the ref resolves it |');
  lines.push('| 2 relevance | does the quote support the claim? | mechanical only where the fixture pre-declares a trap quote; otherwise reported as undeclared |');
  lines.push('| 3 inference | is the conclusion valid? | not machine-decidable. Kind distribution, a lexical overreach signal, and the adjudication queue below |');
  lines.push('');
  lines.push('| model | refs | verbatim | fabricated | ambiguous | image (unverifiable) | audit reformulations | trap citations | overreach flags |');
  lines.push('|---|---|---|---|---|---|---|---|---|');
  for (const entry of report.models) {
    const totals = entry.grade.per_fixture.reduce(
      (sum, grade) => ({
        refs: sum.refs + grade.evidence.authenticity.refs,
        verbatim: sum.verbatim + grade.evidence.authenticity.verbatim,
        fabricated: sum.fabricated + grade.evidence.authenticity.fabricated,
        ambiguous: sum.ambiguous + grade.evidence.authenticity.ambiguous,
        image: sum.image + grade.evidence.authenticity.image_unverifiable,
        traps: sum.traps + grade.evidence.relevance.trap_citations,
        overreach: sum.overreach + grade.evidence.inference.overreach_flags,
      }),
      { refs: 0, verbatim: 0, fabricated: 0, ambiguous: 0, image: 0, traps: 0, overreach: 0 }
    );
    lines.push(
      `| \`${entry.slug}\` | ${totals.refs} | ${totals.verbatim} | ${totals.fabricated} | ${totals.ambiguous} | ${totals.image} | ${
        totals.refs - totals.verbatim - totals.fabricated - totals.ambiguous - totals.image
      } | ${totals.traps} | ${totals.overreach} |`
    );
  }
  lines.push('');

  const queue = [];
  for (const entry of report.models) {
    for (const grade of entry.grade.per_fixture) {
      for (const item of grade.evidence.adjudication) {
        queue.push({ model: entry.slug, fixture: grade.fixture, ...item });
      }
    }
  }
  lines.push(`### Adjudication queue (${queue.length} pending — operator review, not a score)`, '');
  lines.push(
    'Every entry below is a citation or conclusion the harness can authenticate but not judge. These are outstanding until a human reads them; they are not counted as passes.',
    ''
  );
  if (queue.length === 0) lines.push('- empty');
  for (const item of queue.slice(0, 40)) {
    lines.push(`- \`${item.model}\` / ${item.fixture} / ${item.oid ?? '?'}: ${item.reason}`);
    if (item.claim) lines.push(`  - claim: ${String(item.claim).slice(0, 240)}`);
  }
  if (queue.length > 40) lines.push(`- … ${queue.length - 40} more`);
  lines.push('');

  if (report.rda.length) {
    lines.push('## Recursive differential assessment', '');
    lines.push(
      'Justification is computed per cited evidence region, not per source hash: a document-wide edit does not justify deltas whose own quote and neighbourhood are unchanged.',
      ''
    );
    lines.push(
      '| model | from → to | hash-changed sources | evidence-changed sources | same | span moves | added | dropped | partially justified | silent drift | spurious | justified | hash-only change |'
    );
    lines.push('|---|---|---|---|---|---|---|---|---|---|---|---|---|');
    for (const row of report.rda) {
      lines.push(
        `| \`${row.model}\` | ${row.from} → ${row.to} | ${row.changed_sources} | ${row.changed_evidence} | ${row.same} | ${
          row.span_moves ?? 0
        } | ${row.added} | ${row.dropped} | ${row.partially_justified} | ${row.silent_drift} | ${row.spurious_innovation} | ${pct(
          row.justified_fraction
        )} | ${row.hash_only_change ? 'yes' : 'no'} |`
      );
    }
    lines.push('');
    lines.push(
      'Silent drift is a claim that vanished while its cited evidence was unchanged. Spurious innovation is a claim that appeared with no change to its evidence. Both should be zero. `partially justified` means only some cited refs changed, or the evidence is an image region that cannot be compared; it is reported and deliberately not counted as justified.',
      ''
    );
    lines.push(
      'A span move is a claim that kept its quotation and changed its offset. It is not a delta: the same evidence found in a different place is the same evidence, which is what F2a→F2b→F2c are built to produce.',
      ''
    );
    lines.push(
      '`hash-only change` marks the case the coarse rule got wrong: the source hash moved but no delta rests on evidence that moved. A model scoring well only because the hash changed is visible here.',
      ''
    );
  }

  if (report.repeat_drift_events) {
    lines.push(`Repeat differential (identical input, so every delta is drift): **${report.repeat_drift_events}** events.`, '');
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
