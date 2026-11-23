#!/usr/bin/env node
/**
 * Write pilot/freeze/pilot-prep-01.json, the manifest tools/freeze-verify.js checks.
 *
 * The manifest has to live in the tree. Its predecessor was an untracked file under runs/, so a
 * clone had nothing to verify and CI could not run the check at all.
 *
 * Re-freezing is deliberate: run this, read the diff, commit it with a reason. No timestamp is
 * written, so an unchanged tree produces an unchanged file and the commit records when it was pinned.
 */

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const OUT = 'pilot/freeze/pilot-prep-01.json';

// The data the pilot measures with: the banks it scores against, its own oracles and gold, and the
// fixtures the classifier proof was written over. Code is pinned by commit, not by hash.
const ROOTS = ['banks', 'pilot', 'context-engine/fixtures', 'context-engine/poc/classifier-proof.fixture.json'];

const artifacts = execFileSync('git', ['ls-files', ...ROOTS], { encoding: 'utf8' })
  .split('\n')
  .map((line) => line.trim())
  .filter((file) => file && file !== OUT)
  .sort()
  .map((file) => ({ file, sha256: createHash('sha256').update(readFileSync(file)).digest('hex') }));

const manifest = {
  schema: 'gca/freeze-manifest/v1',
  note:
    'Pins the data the pilot measures with. This replaces an earlier freeze that lived at ' +
    'runs/frozen/pilot-prep/manifest.json and was never committed, so its hashes cannot be recovered: ' +
    'the digests below were computed when this file was added. New freeze, not a restoration.',
  artifacts,
};

writeFileSync(OUT, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`wrote ${OUT}: ${artifacts.length} artifacts`);
