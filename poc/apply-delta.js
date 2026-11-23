/**
 * Apply a declared change set to a temporary copy of a subject.
 *
 * The fixture tree is never modified: the PoC copies it first. Every operation is checked and
 * reports whether its anchor text was found, so a silently mismatched patch fails loudly.
 */

import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

export async function copySubject(sourceRoot, prefix = 'context-engine-') {
  const destination = await mkdtemp(path.join(tmpdir(), prefix));
  await cp(sourceRoot, destination, { recursive: true });
  return destination;
}

export async function applyDelta({ sourceRoot, destinationRoot = null, changeSet }) {
  const root = destinationRoot ?? (await copySubject(sourceRoot));
  const applied = [];
  for (const change of changeSet.changes) {
    const target = path.join(root, change.path);
    if (change.op === 'replace') {
      const before = await readFile(target, 'utf8');
      if (!before.includes(change.find)) throw new Error(`replace anchor not found: ${change.path}`);
      await writeFile(target, before.replace(change.find, change.replace));
      applied.push({ op: 'replace', path: change.path, found: true });
    } else if (change.op === 'add') {
      await writeFile(target, change.content);
      applied.push({ op: 'add', path: change.path });
    } else if (change.op === 'delete') {
      await rm(target, { force: true });
      applied.push({ op: 'delete', path: change.path });
    } else {
      throw new Error(`unknown change op: ${change.op}`);
    }
  }
  return { root, applied };
}
