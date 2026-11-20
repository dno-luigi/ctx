/**
 * Freeze verifier.
 *
 * A freeze that is not checked is a claim, not a guarantee. This recomputes every recorded digest
 * and reports deviations by name. It never repairs anything: a mismatch is a deviation to be logged
 * in the current phase, not silently re-hashed.
 *
 * Usage: node tools/freeze-verify.js [manifest-path]
 *   default: runs/frozen/pilot-prep/manifest.json
 * Exit 0 = every artifact matches. Exit 1 = at least one mismatch or missing file.
 */

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const ROOT = new URL('../', import.meta.url);
const manifestPath = process.argv[2] ?? 'runs/frozen/pilot-prep/manifest.json';

const manifest = JSON.parse(await readFile(new URL(manifestPath, ROOT), 'utf8'));
const artifacts = manifest.artifacts ?? manifest.files ?? [];
if (!artifacts.length) {
  console.error(`no artifacts listed in ${manifestPath}`);
  process.exit(1);
}

const manifestDigest = createHash('sha256').update(await readFile(new URL(manifestPath, ROOT))).digest('hex');
console.log(`manifest: ${manifestPath}`);
console.log(`schema:   ${manifest.schema}`);
console.log(`frozen:   ${manifest.frozen_at}`);
console.log(`digest:   ${manifestDigest}`);
console.log('');

let mismatched = 0;
let missing = 0;
for (const artifact of artifacts) {
  const file = artifact.file;
  const expected = artifact.sha256;
  try {
    const actual = createHash('sha256').update(await readFile(new URL(file, ROOT))).digest('hex');
    if (actual !== expected) {
      mismatched += 1;
      console.log(`  DEVIATION ${file}`);
      console.log(`            expected ${expected}`);
      console.log(`            actual   ${actual}`);
    }
  } catch {
    missing += 1;
    console.log(`  MISSING   ${file}`);
  }
}

const ok = artifacts.length - mismatched - missing;
console.log(`${ok}/${artifacts.length} artifacts match${mismatched ? `, ${mismatched} deviated` : ''}${missing ? `, ${missing} missing` : ''}`);
if (mismatched || missing) {
  console.log('a deviation must be logged in the current phase and invalidates runs that predate it');
  process.exit(1);
}
console.log('freeze intact');
