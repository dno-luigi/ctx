/**
 * Freeze / verify the ARA design baseline (A1′).
 *
 * The baseline is the accepted design plus the evidence that supports it. Freezing it does not make it
 * correct; it makes silent change detectable. `--verify` recomputes every digest and reports how many
 * artifacts are intact, so a result can only be cited against the bytes that produced it.
 *
 * Usage:
 *   node tools/ara-freeze.js            write baseline/ara-freeze-01.json
 *   node tools/ara-freeze.js --verify   check every artifact against the manifest
 *   node tools/ara-freeze.js --list     print the baseline without writing
 */

import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';

const ROOT = new URL('../', import.meta.url);
const MANIFEST = new URL('baseline/ara-freeze-01.json', ROOT);

const ARTIFACTS = [
  { path: 'ARA-SCHEMA-02.md', role: 'design baseline (A1′): anchor identity, resolution contract, revised AC-5/AC-6' },
  { path: 'tools/schema-acceptance-v2.js', role: 'acceptance suite for the baseline — 52/52' },
  { path: 'ARA-SCHEMA-01.md', role: 'superseded design, preserved: ordinal rule' },
  { path: 'tools/schema-acceptance.js', role: 'acceptance suite for the superseded design — 39/39' },
  { path: 'ARA-SCHEMA-VALIDATION-01.md', role: 'validation record for the superseded design' },
  { path: 'D3-INSERTION-01.md', role: 'first insertion probe: ordinal misattributes silently' },
  { path: 'D3-INSERTION-02.md', role: 'expanded probe: identity/resolution split, false-flag cost' },
  { path: 'D3-INSERTION-03.md', role: 'structural collision proof; AC-6 re-run under A1′' },
  { path: 'tools/d3-insertion-probe.js', role: 'first probe instrument' },
  { path: 'tools/d3-expanded-probe.js', role: 'expanded probe instrument, including the E12 collision' },
  { path: 'tools/ac6-refined.js', role: 'AC-6 four-count instrument under A1′' },
  { path: 'INFORMATION-MODEL-01.md', role: 'shared AA/ARA information model the schema derives from' },
];

/** Results the baseline is allowed to claim. They are pinned here so a drifting number is visible. */
const RESULTS = {
  'schema-acceptance-v2': '52/52',
  'schema-acceptance-v1': '39/39',
  'ac6-a1prime-verified-occurrences': '94/101',
  'ac6-a1prime-verified-quotes': '90/96',
  'ac6-a1prime-ambiguous': '2',
  'ac6-a1prime-needs-reattribution': '3',
  'ac6-a1prime-unresolved': '2',
  'ac6-a1prime-reattributions': '0',
  'd3-refined-silent-misattributions': '0',
  'd3-content-silent-misattributions': '9',
  'd3-ordinal-silent-misattributions': '7',
  'd3-context-silent-misattributions': '1',
  'd3-refined-false-flags': '3/26',
  'freeze-verify-pilot': '27/27',
  'selftest': '52/52',
};

const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex');

async function digestOf(path) {
  return sha256(await readFile(new URL(path, ROOT)));
}

const mode = process.argv.includes('--verify') ? 'verify' : process.argv.includes('--list') ? 'list' : 'write';

if (mode === 'write' || mode === 'list') {
  const artifacts = [];
  for (const artifact of ARTIFACTS) artifacts.push({ ...artifact, sha256: await digestOf(artifact.path) });
  const manifest = {
    id: 'ARA-FREEZE-01',
    frozen_at: '2026-11-18',
    supersedes: 'ARA-SCHEMA-01 (digest 968a8142c2f86dd0fb330fc8b6ec2314666d3ef253fb0ae7df5fbf255e908d27)',
    note: 'Baseline = accepted A1′ design plus the evidence supporting it. Silent change is a deviation; log it, never re-hash it away.',
    artifacts,
    results: RESULTS,
  };
  if (mode === 'write') {
    await mkdir(new URL('baseline/', ROOT), { recursive: true });
    await writeFile(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`);
    console.log(`wrote baseline/ara-freeze-01.json — ${artifacts.length} artifacts, ${Object.keys(RESULTS).length} pinned results`);
    console.log(`manifest digest ${sha256(await readFile(MANIFEST))}`);
  } else {
    for (const artifact of artifacts) console.log(`${artifact.sha256.slice(0, 16)}  ${artifact.path}`);
  }
} else {
  const manifest = JSON.parse(await readFile(MANIFEST, 'utf8'));
  let intact = 0;
  const drifted = [];
  for (const artifact of manifest.artifacts) {
    const actual = await digestOf(artifact.path);
    if (actual === artifact.sha256) intact += 1;
    else drifted.push({ path: artifact.path, expected: artifact.sha256, actual });
  }
  console.log(`${intact}/${manifest.artifacts.length} baseline artifacts match ${manifest.id}`);
  for (const entry of drifted) console.log(`  DRIFT ${entry.path}\n    expected ${entry.expected}\n    actual   ${entry.actual}`);
  if (drifted.length) {
    console.log('\nA drifted artifact is a deviation, not a new baseline. Record it before citing any result.');
    process.exit(1);
  }
  console.log('baseline intact');
}
