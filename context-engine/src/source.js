/**
 * Context acquisition.
 *
 * Reads source material and records what it read: path, kind, byte length, sha256, mtime and
 * line count. It never writes, never normalises, and never decides relevance — skipping a file
 * is recorded in `skipped` with a reason so coverage cannot be overstated by silence.
 *
 * `digest` covers identity and content only: two acquisitions of unchanged files produce the same
 * digest, which is what makes differential reconstruction meaningful.
 */

import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';

import { digest } from '../../src/canonical.js';

export const SOURCES_SCHEMA = 'context-engine/sources/v1';

/** Directory names never descended into. A caller may add more, never remove these. */
export const DEFAULT_EXCLUDES = ['.git', 'node_modules', 'runs', '.next', 'dist', 'build', 'coverage', '.cache', '.turbo'];

const KIND_BY_EXT = {
  '.js': 'code', '.mjs': 'code', '.cjs': 'code', '.ts': 'code', '.tsx': 'code', '.jsx': 'code',
  '.py': 'code', '.go': 'code', '.rs': 'code', '.java': 'code', '.rb': 'code', '.sh': 'code',
  '.json': 'config', '.jsonc': 'config', '.yaml': 'config', '.yml': 'config', '.toml': 'config', '.ini': 'config',
  '.md': 'doc', '.mdx': 'doc', '.txt': 'doc', '.rst': 'doc',
  '.sql': 'query', '.graphql': 'query',
  '.csv': 'data', '.tsv': 'data', '.log': 'log', '.xml': 'data',
};

const globToRegExp = (pattern) =>
  new RegExp('^' + String(pattern).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '\u0000').replace(/\*/g, '[^/]*').replace(/\u0000/g, '.*') + '$');

export function isBinary(buffer) {
  const limit = Math.min(buffer.length, 4096);
  for (let index = 0; index < limit; index += 1) if (buffer[index] === 0) return true;
  return false;
}

export function classify(relativePath) {
  const extension = path.extname(relativePath).toLowerCase();
  return KIND_BY_EXT[extension] ?? 'other';
}

async function walk(root, current, options, state) {
  const entries = await readdir(current, { withFileTypes: true });
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    const absolute = path.join(current, entry.name);
    const relative = path.relative(root, absolute).split(path.sep).join('/');
    if (state.excluded(relative, entry.isDirectory())) {
      state.skipped.push({ path: relative, reason: entry.isDirectory() ? 'excluded_directory' : 'excluded_path' });
      continue;
    }
    if (entry.isSymbolicLink()) {
      state.skipped.push({ path: relative, reason: 'symlink_not_followed' });
      continue;
    }
    if (entry.isDirectory()) {
      await walk(root, absolute, options, state);
      continue;
    }
    if (!entry.isFile()) {
      state.skipped.push({ path: relative, reason: 'not_a_regular_file' });
      continue;
    }
    if (state.sources.length >= options.maxFiles) {
      state.skipped.push({ path: relative, reason: 'max_files_reached' });
      continue;
    }
    const info = await stat(absolute);
    if (info.size > options.maxFileBytes) {
      state.skipped.push({ path: relative, reason: `too_large:${info.size}` });
      continue;
    }
    const buffer = await readFile(absolute);
    if (isBinary(buffer)) {
      state.skipped.push({ path: relative, reason: 'binary' });
      continue;
    }
    const text = buffer.toString('utf8');
    state.sources.push({
      source_id: relative,
      path: relative,
      kind: classify(relative),
      bytes: buffer.length,
      lines: text.length ? text.split('\n').length : 0,
      sha256: digest({ text }),
      mtime: info.mtime.toISOString(),
      text,
    });
  }
}

/**
 * @param {{root: string, include?: string[]|null, exclude?: string[], maxFileBytes?: number, maxFiles?: number, rootLabel?: string}} options
 */
export async function acquire(options) {
  const root = path.resolve(options.root);
  const include = options.include?.length ? options.include.map(globToRegExp) : null;
  const exclude = [...DEFAULT_EXCLUDES, ...(options.exclude ?? [])].map(globToRegExp);
  const state = {
    sources: [],
    skipped: [],
    excluded: (relative, isDirectory) => {
      if (exclude.some((pattern) => pattern.test(relative))) return true;
      if (exclude.some((pattern) => pattern.test(path.posix.basename(relative)))) return true;
      if (include && !isDirectory && !relative.split('/').some((part) => include.some((pattern) => pattern.test(part))) && !include.some((pattern) => pattern.test(relative))) return true;
      return false;
    },
  };
  await walk(root, root, { maxFileBytes: options.maxFileBytes ?? 262144, maxFiles: options.maxFiles ?? 500 }, state);

  const sources = state.sources.sort((a, b) => a.source_id.localeCompare(b.source_id));
  const totals = {
    files: sources.length,
    bytes: sources.reduce((sum, source) => sum + source.bytes, 0),
    skipped: state.skipped.length,
    by_kind: sources.reduce((counts, source) => ({ ...counts, [source.kind]: (counts[source.kind] ?? 0) + 1 }), {}),
  };
  return {
    schema: SOURCES_SCHEMA,
    root: options.rootLabel ?? path.basename(root),
    root_path: root,
    sources,
    skipped: state.skipped,
    totals,
    digest: digest({ root: options.rootLabel ?? path.basename(root), files: sources.map(({ source_id, sha256, bytes }) => ({ source_id, sha256, bytes })) }),
  };
}
