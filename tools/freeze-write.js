#!/usr/bin/env node
/**
 * Write a freeze manifest over the data a pilot measures with.
 *
 * `tools/freeze-verify.js` can only check a manifest that exists somewhere the repository can see.
 * Its previous default pointed at runs/frozen/pilot-prep/manifest.json, which was never tracked, so
 * a fresh clone could not verify anything and CI could not run the check at all. This writes the
 * manifest into the tree so the freeze travels with the code.
 *
 * Re-freezing is a deliberate act: it records "these are now the pinned inputs". Run it, read the
 * diff, and commit it with a reason.
 *
 *   node tools/freeze-write.js [--out pilot/freeze/pilot-prep-01.json]
 */

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const args = new Map();
for (let index = 2; index < process.argv.length; index += 1) {
  const [key, inline] = process.argv[index].replace(/^--/, '').split('=');
  if (inline !== undefined) args.set(key, inline);
  else if (process.argv[index + 1] && !process.argv[index + 1].startsWith('--')) args.set(key, process.argv[++index]);
}
const out = String(args.get('out') ?? 'pilot/freeze/pilot-prep-01.json');

// The inputs whose stability the pilot depends on: the banks it scores against, the pilot's own
// oracles and gold data, and the fixtures the proof was written over. Code is pinned by commit, not
// by hash, so it is not in here.
const ROOTS = ['banks', 'pilot', 'context-engine/fixtures', 'context-engine/poc/classifier-proof.fixture.json'];

const files = execFileSync('git', ['ls-files', ...ROOTS], { encoding: 'utf8' })
  .split('\n')
  .map((line) => line.trim())
  .filter((file) => file && file !== out)
  .sort();

const artifacts = files.map((file) => {
  const bytes = readFileSync(file);
  return { file, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
});

const manifest = {
  schema: 'gca/freeze-manifest/v1',
  frozen_at: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
  roots: ROOTS,
  note:
    'Pins the data inputs the pilot measures with. This replaces an earlier freeze that lived at ' +
    'runs/frozen/pilot-prep/manifest.json and was never committed, so its hashes cannot be recovered: ' +
    'the digests below were computed when this file was added. Treat it as a new freeze, not a restoration.',
  artifacts,
};

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`wrote ${out}: ${artifacts.length} artifacts, ${artifacts.reduce((sum, artifact) => sum + artifact.bytes, 0)} bytes`);
