/**
 * Partitioning.
 *
 * Files are never split unless one file alone exceeds the budget, and a split is recorded, not
 * hidden. Relationships that cross partitions are indexed before scanning so aggregation can
 * join findings that no single call could see.
 *
 * Token numbers here are `ceil(chars / 4)`. They are planning figures only: they never enter a
 * cost result, because a character estimate is not a measurement.
 */

import path from 'node:path';

export const PARTITION_SCHEMA = 'context-engine/partitions/v1';

export const estimateTokens = (text) => Math.ceil(String(text ?? '').length / 4);

const IMPORT_PATTERNS = [
  { kind: 'import', re: /\bfrom\s+['"]([^'"]+)['"]/g },
  { kind: 'import', re: /\brequire\(\s*['"]([^'"]+)['"]\s*\)/g },
  { kind: 'import', re: /^\s*import\s+['"]([^'"]+)['"]/gm },
  { kind: 'link', re: /\]\(([^)\s]+)\)/g },
  { kind: 'mention', re: /(?:^|[\s(`'"])((?:[\w.-]+\/)*[\w.-]+\.(?:js|mjs|cjs|ts|json|md|yml|yaml|toml))(?=[\s)`'",:;]|$)/gm },
];

const resolveTarget = (specifier, fromPath, byPath) => {
  if (!specifier || /^[a-z]+:/i.test(specifier) || specifier.startsWith('#')) return null;
  const base = specifier.startsWith('.') ? path.posix.normalize(path.posix.join(path.posix.dirname(fromPath), specifier)) : specifier.replace(/^\/+/, '');
  const candidates = [base, `${base}.js`, `${base}.mjs`, `${base}.json`, `${base}.md`, `${base}/index.js`];
  return candidates.find((candidate) => byPath.has(candidate)) ?? null;
};

/** Deterministic reference index over acquired sources. */
export function extractReferences(sources) {
  const byPath = new Map(sources.map((source) => [source.source_id, source]));
  const edges = [];
  const seen = new Set();
  for (const source of sources) {
    for (const pattern of IMPORT_PATTERNS) {
      pattern.re.lastIndex = 0;
      let match;
      while ((match = pattern.re.exec(source.text)) !== null) {
        const target = resolveTarget(match[1], source.source_id, byPath);
        if (!target || target === source.source_id) continue;
        const key = `${source.source_id}|${target}|${pattern.kind}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const line = source.text.slice(0, match.index).split('\n').length;
        edges.push({ from: source.source_id, to: target, kind: pattern.kind, line, specifier: match[1] });
      }
    }
  }
  return edges.sort((a, b) => a.from.localeCompare(b.from) || a.line - b.line || a.to.localeCompare(b.to));
}

/** @param {object[]} sources @param {{maxTokens?: number, overlapLines?: number}} options */
export function partitionSources(sources, { maxTokens = 60000 } = {}) {
  const partitions = [];
  let current = { sources: [], tokens: 0 };

  const flush = () => {
    if (!current.sources.length) return;
    partitions.push({
      partition_id: `p${String(partitions.length + 1).padStart(3, '0')}`,
      source_ids: current.sources.map((entry) => entry.source_id),
      ranges: current.sources.map((entry) => ({ source_id: entry.source_id, start_line: entry.start_line, end_line: entry.end_line })),
      estimated_tokens: current.tokens,
      split: current.sources.some((entry) => entry.split),
    });
    current = { sources: [], tokens: 0 };
  };

  for (const source of sources) {
    const tokens = estimateTokens(source.text);
    if (tokens > maxTokens) {
      flush();
      const lines = source.text.split('\n');
      const chunkChars = maxTokens * 4;
      let start = 0;
      while (start < lines.length) {
        let end = start;
        let chars = 0;
        while (end < lines.length && (chars + lines[end].length + 1 <= chunkChars || end === start)) {
          chars += lines[end].length + 1;
          end += 1;
        }
        partitions.push({
          partition_id: `p${String(partitions.length + 1).padStart(3, '0')}`,
          source_ids: [source.source_id],
          ranges: [{ source_id: source.source_id, start_line: start + 1, end_line: end }],
          estimated_tokens: estimateTokens(lines.slice(start, end).join('\n')),
          split: true,
        });
        start = end;
      }
      continue;
    }
    if (current.tokens + tokens > maxTokens) flush();
    current.sources.push({ source_id: source.source_id, start_line: 1, end_line: source.lines, split: false });
    current.tokens += tokens;
  }
  flush();

  const partitionOf = new Map();
  for (const partition of partitions) {
    for (const range of partition.ranges) {
      if (!partitionOf.has(range.source_id)) partitionOf.set(range.source_id, []);
      partitionOf.get(range.source_id).push(partition.partition_id);
    }
  }
  const references = extractReferences(sources);
  const crossPartition = references
    .map((edge) => ({ ...edge, from_partitions: partitionOf.get(edge.from) ?? [], to_partitions: partitionOf.get(edge.to) ?? [] }))
    .filter((edge) => edge.from_partitions.length && edge.to_partitions.length && edge.from_partitions.join() !== edge.to_partitions.join());

  return {
    schema: PARTITION_SCHEMA,
    max_tokens_per_partition: maxTokens,
    partitions,
    partition_count: partitions.length,
    estimated_tokens_total: partitions.reduce((sum, partition) => sum + partition.estimated_tokens, 0),
    source_to_partitions: Object.fromEntries(partitionOf),
    references,
    cross_partition_references: crossPartition,
    notes: [
      'estimates use ceil(chars/4) and are planning figures, never cost figures',
      'a file is split only when it alone exceeds the budget; every split is recorded',
      'cross_partition_references are computed from imports, links and path mentions before any scan',
    ],
  };
}

/** Slice a partition's text, with line numbers, for the prompt. */
export function partitionText(partition, sourcesById) {
  return partition.ranges
    .map((range) => {
      const source = sourcesById.get(range.source_id);
      if (!source) return '';
      const lines = source.text.split('\n');
      const start = range.start_line - 1;
      const end = Math.min(range.end_line, lines.length);
      const body = lines.slice(start, end).map((line, index) => `${String(start + index + 1).padStart(5, ' ')}| ${line}`).join('\n');
      return `[${range.source_id} lines ${range.start_line}-${end}]\n<<<\n${body}\n>>>`;
    })
    .join('\n\n');
}
