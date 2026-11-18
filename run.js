#!/usr/bin/env node
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { digest } from './src/canonical.js';
import { diffSnapshots, jaccard } from './src/diff.js';
import { gradeFixture, gradeModel, placementSignal } from './src/grade.js';
import { callModel, loadModels } from './src/providers.js';
import { renderMarkdown } from './src/report.js';
import { canonicalizeSnapshot } from './src/spans.js';
import { HARNESS_VERSION, validateInput, validateSnapshot } from './src/validate.js';

const ROOT = new URL('./', import.meta.url);
const FIXTURES = new URL('./fixtures/', ROOT);

function parseArgs(argv) {
  const flags = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith('--')) continue;
    const [key, inline] = arg.slice(2).split('=');
    if (inline !== undefined) flags[key] = inline;
    else if (argv[index + 1] && !argv[index + 1].startsWith('--')) flags[key] = argv[(index += 1)];
    else flags[key] = true;
  }
  return flags;
}

async function readJson(url) {
  return JSON.parse(await readFile(url, 'utf8'));
}

async function loadFixtures() {
  let entries = [];
  try {
    entries = await readdir(FIXTURES, { withFileTypes: true });
  } catch {
    throw new Error('fixtures/ is missing. Run `node tools/build-fixtures.js` first.');
  }
  const fixtures = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = new URL(`./${entry.name}/`, FIXTURES);
    try {
      const meta = await readJson(new URL('fixture.json', dir));
      const input = await readJson(new URL('input.json', dir));
      const groundTruth = await readJson(new URL('ground_truth.json', dir));
      fixtures.push({ meta, input, groundTruth, dir });
    } catch (error) {
      throw new Error(`fixture ${entry.name} is incomplete: ${error.message}`);
    }
  }
  return fixtures.sort((a, b) => (a.meta.order ?? 999) - (b.meta.order ?? 999) || a.meta.id.localeCompare(b.meta.id));
}

function buildSnapshot({ provider, model, input, payload, usage, latency_ms, runId, fixtureId, repeat, options }) {
  return {
    schema: 'gca-snapshot/v1',
    run: {
      id: `${runId}:${model.slug}:${fixtureId}:r${repeat}`,
      at: new Date().toISOString(),
      harness_version: HARNESS_VERSION,
      model: {
        provider,
        slug: model.slug,
        temperature: options.temperature,
        max_tokens: options.max_tokens,
        input_tokens: usage.input_tokens,
        output_tokens: usage.output_tokens,
        cost_usd: usage.cost_usd,
        latency_ms,
      },
    },
    input_digest: digest(input),
    observations: payload?.observations ?? [],
    domains: payload?.domains ?? [],
    gaps: payload?.gaps ?? [],
    checks: payload?.checks ?? [],
    abstentions: payload?.abstentions ?? [],
    ...(Array.isArray(payload?.brief_conflicts) ? { brief_conflicts: payload.brief_conflicts } : {}),
  };
}

async function main() {
  const flags = parseArgs(process.argv.slice(2));
  const provider = String(flags.provider ?? 'stub');
  const repetitions = Number(flags.repeats ?? 3);
  const quality = String(flags.quality ?? 'perfect');
  const temperature = flags.temperature === undefined ? 0 : Number(flags.temperature);
  const maxTokens = Number(flags['max-tokens'] ?? 2000);
  const budget = { usd: Number(flags['budget-usd'] ?? 0), spent: 0 };

  const thresholds = await readJson(new URL('./thresholds.json', ROOT));
  const thresholdsDigest = digest(thresholds);
  const config = await loadModels();

  const catalog = await loadFixtures();
  const wanted = flags.all || !flags.fixtures ? null : String(flags.fixtures).split(',').map((s) => s.trim());
  const selected = catalog.filter((fixture) => !wanted || wanted.includes(fixture.meta.id));
  if (wanted && selected.length !== wanted.length) {
    const found = new Set(selected.map((f) => f.meta.id));
    throw new Error(`unknown fixtures: ${wanted.filter((id) => !found.has(id)).join(', ')}`);
  }
  if (selected.length === 0) throw new Error('no fixtures selected');

  for (const fixture of selected) {
    const check = validateInput(fixture.input);
    if (!check.ok) throw new Error(`fixture ${fixture.meta.id} has an invalid input: ${check.errors.join('; ')}`);
  }

  const chosenModels =
    flags.models === undefined && provider === 'stub'
      ? [{ slug: `stub:${quality}`, class: 'stub', price_in: 0, price_out: 0 }]
      : flags.models === undefined
      ? config.models
      : String(flags.models)
          .split(',')
          .map((slug) => slug.trim())
          .map((slug) => config.models.find((m) => m.slug === slug) ?? { slug, class: 'unlisted', price_in: Number(flags['price-in'] ?? 0), price_out: Number(flags['price-out'] ?? 0) });

  const runId = `${new Date().toISOString().replace(/[:.]/g, '-')}-${provider}${provider === 'stub' ? '-' + quality : ''}`;
  const outDir = new URL(`./${flags.out ?? `runs/${runId}`}/`, ROOT);

  const skipped = selected.filter((fixture) => fixture.meta.skipped_reason).map((fixture) => ({ id: fixture.meta.id, reason: fixture.meta.skipped_reason }));
  const runnable = selected.filter((fixture) => !fixture.meta.skipped_reason);

  const results = [];
  const invalid_details = [];
  let calls = 0;
  let valid = 0;
  let invalid = 0;

  for (const model of chosenModels) {
    for (const fixture of runnable) {
      for (let repeat = 0; repeat < repetitions; repeat += 1) {
        calls += 1;
        let call;
        try {
          call = await callModel({
            provider,
            model,
            input: fixture.input,
            groundTruth: fixture.groundTruth,
            quality,
            repeat,
            options: { temperature, max_tokens: maxTokens },
            budget,
            config,
          });
        } catch (error) {
          invalid_details.push({ model: model.slug, fixture: fixture.meta.id, repeat, errors: [error.message] });
          invalid += 1;
          results.push({ model: model.slug, fixture: fixture.meta.id, repeat, valid: false, errors: [error.message] });
          continue;
        }

        const snapshot = buildSnapshot({
          provider,
          model,
          input: fixture.input,
          payload: call.payload,
          usage: call.usage,
          latency_ms: call.latency_ms,
          runId,
          fixtureId: fixture.meta.id,
          repeat,
          options: { temperature, max_tokens: maxTokens },
        });
        const { snapshot: canonical } = canonicalizeSnapshot(fixture.input, snapshot);
        const validation = validateSnapshot(fixture.input, canonical);
        if (validation.ok) valid += 1;
        else {
          invalid += 1;
          invalid_details.push({ model: model.slug, fixture: fixture.meta.id, repeat, errors: validation.errors });
        }
        results.push({
          model: model.slug,
          fixture: fixture.meta.id,
          repeat,
          valid: validation.ok,
          errors: validation.errors,
          stats: validation.stats,
          snapshot: canonical,
        });
      }
    }
  }

  const models = [];
  const rda = [];
  let repeatDrift = 0;

  for (const model of chosenModels) {
    const per_fixture = [];
    for (const fixture of runnable) {
      const runs = results.filter((r) => r.model === model.slug && r.fixture === fixture.meta.id);
      const validForFixture = runs.filter((r) => r.valid).map((r) => r.snapshot);
      per_fixture.push(
        gradeFixture({
          fixture: fixture.meta.id,
          groundTruth: fixture.groundTruth,
          snapshots: validForFixture,
          invalidSnapshots: runs.length - validForFixture.length,
          repetitions,
        })
      );

      if (validForFixture.length >= 2) {
        const diff = diffSnapshots(validForFixture[0], validForFixture[1], fixture.input, fixture.input);
        repeatDrift += diff.silent_drift.length + diff.spurious_innovation.length;
      }
    }

    const grade = gradeModel({ model, grades: per_fixture, thresholds });
    grade.per_fixture = per_fixture;
    models.push({
      slug: model.slug,
      class: model.class ?? null,
      grade,
      placement: placementSignal({ grade, thresholds }),
    });

    const byVariant = runnable.filter((f) => f.meta.variant_of);
    const groups = new Map();
    for (const fixture of byVariant) {
      const key = fixture.meta.variant_of;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(fixture);
    }
    for (const [group, members] of groups) {
      for (let index = 1; index < members.length; index += 1) {
        const from = members[index - 1];
        const to = members[index];
        const a = results.find((r) => r.model === model.slug && r.fixture === from.meta.id && r.valid);
        const b = results.find((r) => r.model === model.slug && r.fixture === to.meta.id && r.valid);
        if (!a || !b) continue;
        const diff = diffSnapshots(a.snapshot, b.snapshot, from.input, to.input);
        rda.push({
          model: model.slug,
          from: from.meta.id,
          to: to.meta.id,
          group,
          changed_sources: diff.changed_sources,
          same: diff.same.length,
          added: diff.added.length,
          dropped: diff.dropped.length,
          silent_drift: diff.silent_drift.length,
          spurious_innovation: diff.spurious_innovation.length,
          justified_fraction: diff.justified_fraction,
        });
      }
    }
  }

  const report = {
    harness_version: HARNESS_VERSION,
    run: {
      id: runId,
      at: new Date().toISOString(),
      provider,
      quality: provider === 'stub' ? quality : null,
      repetitions,
      fixtures: runnable.map((f) => f.meta.id),
      skipped,
      options: { temperature, max_tokens: maxTokens, budget_usd: budget.usd },
    },
    thresholds: { file: 'thresholds.json', digest: thresholdsDigest, values: thresholds },
    models,
    fixtures: Object.fromEntries(catalog.map((f) => [f.meta.id, { title: f.meta.title ?? null, variant_of: f.meta.variant_of ?? null, skipped_reason: f.meta.skipped_reason ?? null }])),
    rda,
    repeat_drift_events: repeatDrift,
    totals: { calls, valid, invalid, cost_usd: budget.spent },
    invalid_details,
    not_run: [
      ...skipped.map((s) => `${s.id}: skipped (${s.reason})`),
      provider === 'stub' ? 'real models: not called. Stub snapshots come from the fixture ground truth, so they test the graders, not a model.' : 'stub baseline: not run in this invocation.',
      'image citations: unverifiable as text; they require operator adjudication.',
      'no network traces, no KV, no journal, no preference store, no deployment.',
    ],
    limitations: [
      'Citation integrity is mechanical. Everything else is measured, not judged: no model scores another model.',
      'Entailment is approximated by citation overlap. A model that draws a wrong conclusion from a right quote is not caught by the citation gate.',
      'Image refs cannot be verified verbatim; a run containing them cannot reach full citation integrity without operator review.',
      'Stub runs validate the harness, not any model. Only a paid run against a real provider produces model evidence.',
    ],
  };

  await mkdir(outDir, { recursive: true });
  await writeFile(new URL('report.json', outDir), JSON.stringify(report, null, 2) + '\n');
  await writeFile(new URL('report.md', outDir), renderMarkdown(report));

  console.log(`report: ${fileURLToPath(new URL('report.md', outDir))}`);
  for (const entry of models) {
    const m = entry.grade.metrics;
    console.log(
      `  ${entry.slug.padEnd(34)} citation ${(m.citation_integrity * 100).toFixed(0).padStart(3)}%  coverage ${(
        m.coverage * 100
      ).toFixed(0).padStart(3)}%  consistency ${m.consistency === null ? ' —' : (m.consistency * 100).toFixed(0).padStart(3) + '%'}  ` +
        `${entry.grade.pass ? 'PASS' : 'FAIL'}  → ${entry.placement.signal}`
    );
  }
  if (invalid) console.log(`  ${invalid} snapshot(s) rejected — see "Rejected snapshots" in the report`);

  const failed = models.some((entry) => !entry.grade.pass);
  if (invalid > 0) process.exitCode = 1;
  else if (flags.strict && failed) process.exitCode = 1;
}

main().catch((error) => {
  console.error(`harness error: ${error.message}`);
  process.exitCode = 2;
});
