/**
 * Patch fixture validator.
 *
 * Two questions per patch, and the second is the one that matters:
 *
 *   1. does every mutation's `find` string occur exactly once, so the patch is applicable?
 *   2. does the declared oracle actually fail in the patched state?
 *
 * A patch whose oracle passes while patched is not a task: there is nothing to fix and a
 * run against it measures nothing. That is the pilot's own stop rule S3, applied here to
 * the fixtures rather than to the results.
 *
 * Application is in-memory: every touched file is read first and restored in a finally
 * block, then verified by hash. No git operations, no checkout, nothing left behind.
 *
 * Usage: node tools/patch-check.js [--apply] [--only C1,C5]
 */

import { createHash } from 'node:crypto';
import { execSync } from 'node:child_process';
import { readdir, readFile, writeFile } from 'node:fs/promises';

const ROOT = new URL('../', import.meta.url);
const ROOT_PATH = new URL('./', ROOT).pathname;
const options = { apply: false, only: null, out: 'pilot/patches/results.json' };
for (let index = 0; index < process.argv.length; index += 1) {
  const [flag, inline] = String(process.argv[index]).split('=');
  if (flag === '--apply') options.apply = true;
  else if (flag === '--only') options.only = (inline ?? process.argv[++index]).split(',');
  else if (flag === '--out') options.out = inline ?? process.argv[++index];
}

const dir = new URL('pilot/patches/', ROOT);
const files = (await readdir(dir)).filter((file) => /^C\d+\.json$/.test(file)).sort();
const patches = [];
for (const file of files) patches.push(JSON.parse(await readFile(new URL(file, dir), 'utf8')));
const selected = options.only ? patches.filter((patch) => options.only.includes(patch.id)) : patches;

const hash = (text) => createHash('sha256').update(text).digest('hex');

function run(command) {
  try {
    const stdout = execSync(command, { cwd: ROOT_PATH, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120000 });
    return { command, exit: 0, output: stdout };
  } catch (error) {
    return { command, exit: error.status ?? 1, output: `${error.stdout ?? ''}${error.stderr ?? ''}` };
  }
}

const report = [];

for (const patch of selected) {
  const entry = { id: patch.id, class: patch.class, applicable: true, problems: [], oracle: null };

  // 1. applicability: every find string occurs exactly once
  const originals = new Map();
  for (const mutation of patch.mutations) {
    if (!originals.has(mutation.file)) {
      try {
        originals.set(mutation.file, await readFile(new URL(mutation.file, ROOT), 'utf8'));
      } catch {
        entry.applicable = false;
        entry.problems.push(`${mutation.file}: file not found`);
        continue;
      }
    }
    const text = originals.get(mutation.file);
    const occurrences = text.split(mutation.find).length - 1;
    if (occurrences !== 1) {
      entry.applicable = false;
      entry.problems.push(`${mutation.file}: find string occurs ${occurrences} time(s), expected exactly 1 — ${JSON.stringify(mutation.find.slice(0, 60))}`);
    }
  }

  if (!entry.applicable) {
    report.push(entry);
    console.log(`${patch.id}: NOT APPLICABLE — ${entry.problems[0]}`);
    continue;
  }

  const before = new Map([...originals].map(([file, text]) => [file, hash(text)]));
  console.log(`${patch.id}: applicable (${patch.mutations.length} mutation(s))`);

  if (!options.apply) {
    entry.oracle = { skipped: true };
    report.push(entry);
    continue;
  }

  // 2. oracle: patch, run, restore
  const patched = new Map();
  try {
    for (const [file, text] of originals) {
      let next = text;
      for (const mutation of patch.mutations.filter((candidate) => candidate.file === file)) next = next.replace(mutation.find, mutation.replace);
      patched.set(file, next);
      await writeFile(new URL(file, ROOT), next);
    }
    const initial = patch.oracle.commands.map(run);
    entry.oracle = {
      commands: initial.map((result) => ({
        command: result.command,
        exit: result.exit,
        tail: result.output.trim().split('\n').slice(-4).join(' | ').slice(0, 400),
      })),
      fails_as_declared: initial.some((result) => result.exit !== 0),
      expected_initial: patch.oracle.expected_initial,
    };
    console.log(`  oracle patched: ${initial.map((result) => `${result.command} exit ${result.exit}`).join(', ')}`);
  } finally {
    // Restore first, unconditionally, then verify by re-reading. Verification must never be
    // able to prevent the write-back.
    for (const [file, text] of originals) await writeFile(new URL(file, ROOT), text);
    const afterMap = new Map();
    for (const file of originals.keys()) afterMap.set(file, hash(await readFile(new URL(file, ROOT), 'utf8')));
    entry.restored = [...before].every(([file, digest]) => afterMap.get(file) === digest);
    console.log(`  restored: ${entry.restored ? 'yes' : 'NO — CHECK WORKING TREE'}`);
  }

  report.push(entry);
}

await writeFile(new URL(options.out, ROOT), `${JSON.stringify({ schema: 'gca-patch-check/v1', generated_at: new Date().toISOString(), applied: options.apply, patches: report }, null, 2)}\n`);
console.log(`\nwrote ${options.out}`);
