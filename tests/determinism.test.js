/**
 * Determinism: identical acquisition + identical payloads must produce identical artifacts.
 *
 * This is the invariant PROTOCOL.md §10 has always claimed and no test has checked. It matters for
 * more than tidy bookkeeping: every published number in this folder is a digest or a count taken from
 * one of these artifacts, so a pipeline that reorders findings between runs makes "the result" a
 * property of the run rather than of the evidence.
 *
 * The provider is scripted, so no model and no network are involved. Output is $0.
 *
 * Usage: node context-engine/tests/determinism.test.js
 */

import { rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { scanProject, updateProject } from '../src/pipeline.js';
import { compact, renderPack } from '../src/compact.js';
import { createProvider } from '../src/providers.js';
import { applyDelta, copySubject } from '../poc/apply-delta.js';
import { readFile } from 'node:fs/promises';

const here = path.dirname(fileURLToPath(import.meta.url));
const engineRoot = path.resolve(here, '..');
const fixtureRoot = path.join(engineRoot, 'fixtures/poc-repo');

let checks = 0;
let failures = 0;
const check = (name, condition, detail = '') => {
  checks += 1;
  if (!condition) failures += 1;
  console.log(`  ${condition ? 'ok  ' : 'FAIL'} ${name}${condition || !detail ? '' : ` — ${detail}`}`);
};

const QUOTE_STORE = 'The store MUST never delete an unexpired object, even under lock contention.';
const QUOTE_IMPORT = "import { writeBatch } from './store.js';";

const payload = {
  findings: [
    {
      kind: 'invariant',
      text: 'The store MUST never delete an unexpired object.',
      certainty: 'stated',
      sources: [{ source_id: 'src/store.js', quote: QUOTE_STORE }],
      entities: ['store'],
    },
    {
      kind: 'dependency',
      text: 'Batch ingestion writes through the store module.',
      certainty: 'stated',
      sources: [{ source_id: 'src/ingest.js', quote: QUOTE_IMPORT }],
      entities: ['ingest', 'store'],
    },
    {
      kind: 'outstanding',
      text: 'The backfill path is not yet implemented.',
      certainty: 'stated',
      sources: [{ source_id: 'README.md', quote: 'The backfill path is not yet implemented. TODO: document backfill before the next release.' }],
    },
  ],
  relationships: [
    { from: 'src/ingest.js', to: 'src/store.js', type: 'imports', sources: [{ source_id: 'src/ingest.js', quote: QUOTE_IMPORT }] },
  ],
  contradictions: [],
  questions: ['Does backfill write directly to the store or only through ingest?'],
};

const changedPayload = {
  ...payload,
  findings: payload.findings.map((finding) => (finding.kind === 'outstanding' ? { ...finding, text: 'The backfill path is still not implemented.' } : finding)),
};

const scripted = (entry) => createProvider({ kind: 'scripted', script: [entry] });

const scanWith = (entry) =>
  scanProject({ root: fixtureRoot, rootLabel: 'poc-repo', provider: scripted(entry), partitionPolicy: {}, modelContextTokens: null });

console.log('scan determinism');
const first = await scanWith({ payload });
const second = await scanWith({ payload });
check('the acquisition digest is identical', first.acquisition.digest === second.acquisition.digest);
check('the snapshot digest is identical', first.snapshot.digest === second.snapshot.digest, `${first.snapshot.digest} vs ${second.snapshot.digest}`);
check('the snapshot id derives from the digest', first.snapshot.snapshot_id === `snap-${first.snapshot.digest.replace('sha256:', '').slice(0, 16)}`);
const stableBody = (snapshot) => {
  const copy = JSON.parse(JSON.stringify(snapshot));
  delete copy.subject.acquired_at;
  delete copy.scan.latency_ms;
  return JSON.stringify(copy);
};
check('the body is identical apart from the recorded wall-clock fields', stableBody(first.snapshot) === stableBody(second.snapshot));
check('the wall-clock fields are still recorded in the artifact', Boolean(first.snapshot.subject.acquired_at) && typeof first.snapshot.scan.latency_ms === 'number');
check(
  'the digest declares which fields it excludes',
  JSON.stringify(first.snapshot.manifest.digest_excludes) === JSON.stringify(['subject.acquired_at', 'scan.latency_ms'])
);
check('finding order is stable', JSON.stringify(first.snapshot.sections.observations.map((entry) => entry.text)) === JSON.stringify(second.snapshot.sections.observations.map((entry) => entry.text)));

const different = await scanWith({ payload: changedPayload });
check('a changed payload changes the digest', different.snapshot.digest !== first.snapshot.digest);

console.log('pack determinism');
const packA = compact({ snapshot: first.snapshot, profile: 'medium' });
const packB = compact({ snapshot: first.snapshot, profile: 'medium' });
check('the pack digest is identical', packA.digest === packB.digest);
check('the rendered pack is identical', renderPack(packA) === renderPack(packB));
check('the pack id derives from its digest', packA.pack_id === `pack-${packA.digest.replace('sha256:', '').slice(0, 12)}`);

console.log('differential determinism');
let copy = null;
try {
  const changeSet = JSON.parse(await readFile(path.join(engineRoot, 'fixtures/poc-delta/changes.json'), 'utf8'));
  copy = await copySubject(fixtureRoot, 'ce-determinism-copy-');
  const applied = await applyDelta({ sourceRoot: fixtureRoot, destinationRoot: copy, changeSet });
  const deltaRun = (entry) =>
    updateProject({
      previousSnapshot: first.snapshot,
      root: applied.root,
      rootLabel: 'poc-repo',
      provider: scripted(entry),
      partitionPolicy: {},
      modelContextTokens: null,
    });
  const deltaA = await deltaRun({ payload });
  const deltaB = await deltaRun({ payload });
  check('the delta digest is identical', deltaA.delta.digest === deltaB.delta.digest, `${deltaA.delta.digest} vs ${deltaB.delta.digest}`);
  check('the updated snapshot digest is identical', deltaA.snapshot.digest === deltaB.snapshot.digest);
  check('the rescan set is identical', JSON.stringify(deltaA.delta.rescanned) === JSON.stringify(deltaB.delta.rescanned));
  check('preserved findings are byte-identical', deltaA.delta.verification.preserved_identical === true);
} finally {
  if (copy) rmSync(copy, { recursive: true, force: true });
}

console.log(`\ndeterminism tests: ${checks - failures}/${checks} checks passed`);
process.exit(failures ? 1 : 0);
