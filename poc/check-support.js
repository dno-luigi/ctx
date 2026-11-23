/**
 * Support check over a stored snapshot. No scan, no model call, $0.
 *
 * `citation_verified` says a quote exists. This reports how many of those findings would also survive
 * the stronger, still-mechanical checks in `src/support.js`: numbers and identifiers present in the
 * quote, negation not invented or dropped.
 *
 * The result is a measurement, not a new gate. Findings flagged here stay in
 * `verified_conclusions` because demoting them would silently restate results that are already
 * published. Making support a gate is a pre-registered change for the benchmark, not a re-score of
 * this run.
 *
 * Usage:
 *   node context-engine/poc/check-support.js --run examples/live-approved
 *   node context-engine/poc/check-support.js --run examples/live --snapshot snapshot-poc-repo.json
 */

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { summariseSupport } from '../src/support.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const engineRoot = path.resolve(here, '..');

const args = {};
const argv = process.argv.slice(2);
for (let index = 0; index < argv.length; index += 1) {
  if (!argv[index].startsWith('--')) continue;
  const [key, inline] = argv[index].slice(2).split('=');
  if (inline !== undefined) args[key] = inline;
  else if (argv[index + 1] && !argv[index + 1].startsWith('--')) args[key] = argv[++index];
  else args[key] = true;
}

const runDir = path.resolve(engineRoot, args.run ?? 'examples/live-approved');
const snapshotFile = args.snapshot ?? 'snapshot-poc-repo.json';
const snapshot = JSON.parse(readFileSync(path.join(runDir, snapshotFile), 'utf8'));

const observations = (snapshot.sections?.observations ?? []).filter((finding) => finding.verification === 'citation_verified');
const conclusions = (snapshot.sections?.verified_conclusions ?? []).filter((finding) => (finding.evidence ?? []).length);
const contradictions = (snapshot.contradictions ?? []).filter((entry) => entry.verification === 'citation_verified');

const result = {
  schema: 'context-engine/support-check/v1',
  at: new Date().toISOString(),
  run: path.relative(engineRoot, runDir),
  snapshot_file: snapshotFile,
  snapshot_id: snapshot.snapshot_id,
  snapshot_digest: snapshot.digest,
  note: 'Mechanical checks only. A flagged finding may still be correct (it may combine several quotes or rephrase a figure); a supported finding may still be wrong.',
  observations: summariseSupport({ findings: observations, label: 'observations' }),
  contradictions: summariseSupport({ findings: contradictions, label: 'contradictions' }),
  verified_conclusions: summariseSupport({ findings: conclusions, label: 'verified_conclusions' }),
};

const outPath = path.join(runDir, `support-check-${path.basename(snapshotFile, '.json').replace('snapshot-', '')}.json`);
writeFileSync(outPath, JSON.stringify(result, null, 2));

console.log(`support check · ${result.run} · ${snapshotFile} · ${snapshot.snapshot_id}`);
for (const block of [result.observations, result.contradictions, result.verified_conclusions]) {
  console.log(
    `  ${block.label.padEnd(20)} ${block.supported}/${block.total} supported` +
      (block.no_evidence ? ` · ${block.no_evidence} without evidence` : '') +
      Object.entries(block.flag_counts).map(([code, count]) => ` · ${code}=${count}`).join('')
  );
}
for (const [code, examples] of Object.entries(result.observations.examples)) {
  for (const example of examples.slice(0, 2)) {
    console.log(`    ${code}: "${String(example.text).slice(0, 90)}"`);
  }
}
console.log(`wrote ${path.relative(process.cwd(), outPath)}`);
