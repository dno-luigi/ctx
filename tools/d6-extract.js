/**
 * D6 extraction contract — a declared, offline, lexical ESM extractor (v1.1.0).
 *
 * The contract is defined independently of any ARA store: this module returns edges, evidence and a
 * capability/coverage report. Persistence, retrieval and record identity are out of scope.
 *
 * Three things the contract refuses to conflate:
 *   1. an extractor that cannot answer (`edges_unknown`) vs one that answered "none" (`no_edges`)
 *   2. an import edge vs a symbol-reference edge vs a semantic dependency (`depends_on` is declared
 *      unsupported — an import does not establish that the symbol is used, or that the dependency is
 *      necessary)
 *   3. an extractor's evidence/provenance vs the identity of the relationship it reports
 *
 * v1.1.0 adds what held-out code demanded: multiline import syntax, and a refusal to claim a reference
 * when the local binding is shadowed by a declaration in the same file.
 *
 * Usage: node tools/d6-extract.js [scope.json]
 */

import { access, readFile } from 'node:fs/promises';
import { dirname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

import { digest } from '../src/canonical.js';

const ROOT = new URL('../', import.meta.url);
const ROOT_PATH = fileURLToPath(ROOT);
const H = (schema, ...parts) => digest({ schema, parts }).slice(0, 20);

/** Declared capability. Anything not listed here is `edges_unknown`, never `no_edges`. */
export const EXTRACTOR = {
  name: 'code.esm.lexical',
  version: '1.1.0',
  method: 'line-lexical',
  languages: ['.js', '.mjs'],
  capabilities: {
    imports_module: 'supported',
    reexports_symbol: 'supported',
    references_symbol: 'supported',
    depends_on: 'unsupported',
    calls_symbol: 'unsupported',
  },
  limits: [
    'no CommonJS require()',
    'no TypeScript/JSX',
    'no alias or tsconfig path resolution',
    'symbol references are lexical identifier occurrences, not binding resolution',
    'a shadowed local binding is reported as a gap, never as a reference edge',
    're-export chains are not flattened: only the hop with direct evidence is reported',
  ],
};

// ------------------------------------------------------------------ parsing

function bindingsOf(list) {
  if (!list) return [];
  return list
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [imported, local] = entry.split(/\s+as\s+/).map((part) => part.trim());
      return { imported: imported || local, local: local || imported };
    });
}

function stripNoise(line) {
  return line
    .replace(/\/\/.*$/, '')
    .replace(/\/\*.*?\*\//g, '')
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/`(?:[^`\\]|\\.)*`/g, '``');
}

/**
 * Join a declaration that spans lines into one logical unit. A multiline import is valid JavaScript; if
 * the parser only looked at line starts it would report the file as having no imports and call that
 * `no_edges` — an extraction failure silently reported as an absence.
 */
function unitsOf(lines) {
  const units = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const declaration = /^\s*(import|export)\b/.test(line);
    const hasFrom = /from\s*['"]/.test(line);
    const sideEffect = /^\s*import\s+['"]/.test(line);
    if (declaration && !hasFrom && !sideEffect) {
      let text = line;
      let end = index;
      while (end + 1 < lines.length && !/from\s*['"]/.test(text)) {
        end += 1;
        text += ` ${lines[end].trim()}`;
      }
      if (/from\s*['"]/.test(text)) {
        units.push({ text, line: index + 1, lines: end - index + 1 });
        index = end;
        continue;
      }
    }
    units.push({ text: line, line: index + 1, lines: 1 });
  }
  return units;
}

export function parseSource(text) {
  const lines = text.split('\n');
  const units = unitsOf(lines);
  const sanitized = lines.map((line) => stripNoise(line));

  // Continuation lines belong to the joined declaration and must not be searched for references.
  for (const unit of units) {
    if (unit.lines > 1) for (let offset = 1; offset < unit.lines; offset += 1) sanitized[unit.line - 1 + offset] = '';
  }

  const imports = [];
  const reexports = [];
  const dynamic = [];

  for (const unit of units) {
    const line = unit.text;
    const named = line.match(/^import\s+\{([^}]*)\}\s+from\s+(['"])([^'"]+)\2/);
    const namespace = line.match(/^import\s+\*\s+as\s+([\w$]+)\s+from\s+(['"])([^'"]+)\2/);
    const def = line.match(/^import\s+([\w$]+)\s*,\s*\{([^}]*)\}\s+from\s+(['"])([^'"]+)\3/);
    const bare = line.match(/^import\s+([\w$]+)\s+from\s+(['"])([^'"]+)\2/);
    const sideEffect = line.match(/^import\s+(['"])([^'"]+)\1/);
    const reexportNamed = line.match(/^export\s+\{([^}]*)\}\s+from\s+(['"])([^'"]+)\2/);
    const reexportAll = line.match(/^export\s+\*\s+from\s+(['"])([^'"]+)\1/);

    // Only lines actually consumed as a declaration are blanked. Blanking every `export` line also
    // erased `export const full = pathJoin(...)`, which is exactly where a reference lives.
    if (named || namespace || def || bare || sideEffect || reexportNamed || reexportAll) sanitized[unit.line - 1] = '';

    if (named) imports.push({ specifier: named[3], bindings: bindingsOf(named[1]), form: 'named', line: unit.line });
    else if (namespace) imports.push({ specifier: namespace[3], bindings: [{ imported: '*', local: namespace[1] }], form: 'namespace', line: unit.line });
    else if (def) imports.push({ specifier: def[4], bindings: [{ imported: 'default', local: def[1] }, ...bindingsOf(def[2])], form: 'default+named', line: unit.line });
    else if (bare) imports.push({ specifier: bare[3], bindings: [{ imported: 'default', local: bare[1] }], form: 'default', line: unit.line });
    else if (sideEffect) imports.push({ specifier: sideEffect[2], bindings: [], form: 'side-effect', line: unit.line });
    else if (reexportNamed) reexports.push({ specifier: reexportNamed[3], bindings: bindingsOf(reexportNamed[1]), line: unit.line });
    else if (reexportAll) reexports.push({ specifier: reexportAll[2], bindings: [], form: 'all', line: unit.line });

    for (const call of line.matchAll(/\bimport\(\s*(['"])([^'"]+)\1\s*\)/g)) {
      dynamic.push({ specifier: call[2], bindings: [], form: 'dynamic', line: unit.line });
    }
  }

  return { imports: [...imports, ...dynamic], reexports, sanitized };
}

const referencesIn = (sanitized, name) => {
  const pattern = new RegExp(`\\b${name.replace(/[$]/g, '\\$')}\\b`, 'g');
  let count = 0;
  sanitized.forEach((line) => { count += (line.match(pattern) ?? []).length; });
  return count;
};

/** A local name redeclared in the same file no longer refers to the import at every occurrence. */
function shadowedBy(sanitized, name) {
  const body = sanitized.join('\n');
  const escaped = name.replace(/[$]/g, '\\$');
  if (new RegExp(`\\b(?:const|let|var)\\s+${escaped}\\b`).test(body)) return 'local_declaration';
  if (new RegExp(`\\bfunction\\s+${escaped}\\b`).test(body)) return 'local_function';
  for (const match of body.matchAll(/(?:function\s*[^(]*|\([^)]*\)\s*=>|[\w$]+\s*=>)\s*\(([^)]*)\)/g)) {
    if (new RegExp(`(?:^|,)\\s*${escaped}\\s*(?:,|$)`).test(match[1])) return 'parameter';
  }
  return null;
}

// ------------------------------------------------------------------ resolution and identity

async function exists(relative) {
  try { await access(join(ROOT_PATH, relative)); return true; } catch { return false; }
}

export function edgeId(type, from, to, symbol = '') {
  return `rel_${H('ara/relationship/v2', type, from, to, symbol)}`;
}

async function resolveSpecifier(from, specifier) {
  if (!specifier.startsWith('.')) return { to: `external:${specifier}`, resolution: 'external' };
  const target = normalize(join(dirname(from), specifier));
  return (await exists(target))
    ? { to: target, resolution: 'resolved' }
    : { to: target, resolution: 'unresolved', reason: 'specifier_not_found' };
}

// ------------------------------------------------------------------ extraction

const provenance = () => ({ extractor: EXTRACTOR.name, extractor_version: EXTRACTOR.version, method: EXTRACTOR.method });

/** Extract edges from one file. Never throws on an unsupported language: it reports coverage. */
export async function extractFile(path) {
  if (!EXTRACTOR.languages.some((extension) => path.endsWith(extension))) {
    return { file: path, supported: false, reason: `language_not_declared (${path.split('.').pop()})`, edges: [], gaps: [] };
  }
  let text;
  try { text = await readFile(join(ROOT_PATH, path), 'utf8'); }
  catch { return { file: path, supported: false, reason: 'read_failed', edges: [], gaps: [] }; }

  const parsed = parseSource(text);
  const edges = [];
  const gaps = [];

  for (const entry of [...parsed.imports, ...parsed.reexports]) {
    const { to, resolution, reason } = await resolveSpecifier(path, entry.specifier);
    const isReexport = parsed.reexports.includes(entry);
    const type = isReexport ? 'reexports_symbol' : 'imports_module';
    edges.push({
      relationship_id: edgeId(type, path, to),
      type,
      from: path,
      to,
      resolution,
      ...(reason ? { resolution_reason: reason } : {}),
      evidence: { line: entry.line, specifier: entry.specifier, form: entry.form ?? 'named' },
      provenance: provenance(),
    });
  }

  for (const entry of parsed.imports) {
    const { to, resolution, reason } = await resolveSpecifier(path, entry.specifier);
    for (const binding of entry.bindings) {
      if (binding.local === '*' || binding.imported === 'default') continue;
      if (referencesIn(parsed.sanitized, binding.local) === 0) continue;
      const shadow = shadowedBy(parsed.sanitized, binding.local);
      if (shadow) {
        gaps.push({ type: 'references_symbol', symbol: binding.imported, local: binding.local, line: entry.line, reason: `shadowed_binding (${shadow})`, to });
        continue;
      }
      edges.push({
        relationship_id: edgeId('references_symbol', path, to, binding.imported),
        type: 'references_symbol',
        from: path,
        to,
        symbol: binding.imported,
        resolution,
        ...(reason ? { resolution_reason: reason } : {}),
        evidence: { line: entry.line, specifier: entry.specifier, form: 'reference' },
        provenance: provenance(),
      });
    }
  }

  return { file: path, supported: true, edges, gaps };
}

/**
 * Scope-level answer. `status` is the contract's central distinction.
 *   ok            — extracted at least one edge, coverage complete
 *   ok (partial)  — extracted some edges, but coverage has a gap (unsupported file or shadowed binding)
 *   no_edges      — ran successfully over complete coverage and found nothing
 *   edges_unknown — cannot answer: unsupported relation type, or no coverage at all
 */
export async function extractScope({ files, type = 'imports_module' }) {
  const capability = EXTRACTOR.capabilities[type];
  if (!capability) return { status: 'edges_unknown', reason: `capability_not_declared (${type})`, edges: [], coverage: null };
  if (capability === 'unsupported') return { status: 'edges_unknown', reason: `capability_unsupported (${type})`, edges: [], coverage: null };

  const results = [];
  for (const file of files) results.push(await extractFile(file));
  const supported = results.filter((result) => result.supported);
  const skipped = results.filter((result) => !result.supported);
  const edges = supported.flatMap((result) => result.edges).filter((edge) => edge.type === type);
  const gaps = supported.flatMap((result) => result.gaps).filter((gap) => gap.type === type);
  const coverage = {
    files_declared: files.length,
    files_extracted: supported.length,
    files_outside_capability: skipped.map((result) => ({ file: result.file, reason: result.reason })),
    gaps: gaps.map((gap) => ({ file: supported.find((result) => result.gaps.includes(gap))?.file ?? null, ...gap })),
    complete: skipped.length === 0 && gaps.length === 0,
    extractor: EXTRACTOR.name,
    extractor_version: EXTRACTOR.version,
  };

  if (edges.length) return { status: 'ok', edges, coverage };
  if (skipped.length || gaps.length) return { status: 'edges_unknown', reason: 'coverage_incomplete', edges: [], coverage };
  return { status: 'no_edges', edges: [], coverage };
}

// ------------------------------------------------------------------ CLI

if (process.argv[1] && process.argv[1].endsWith('d6-extract.js')) {
  const files = process.argv[2]
    ? JSON.parse(await readFile(process.argv[2], 'utf8')).files
    : ['src/diff.js', 'src/grade.js', 'src/evidence.js', 'src/validate.js', 'src/providers.js'];
  for (const type of ['imports_module', 'references_symbol', 'depends_on']) {
    const scope = await extractScope({ files, type });
    console.log(`${type.padEnd(18)} ${scope.status}${scope.reason ? ` (${scope.reason})` : ''} edges=${scope.edges.length}`);
    if (scope.coverage) console.log(`  coverage ${scope.coverage.files_extracted}/${scope.coverage.files_declared} complete=${scope.coverage.complete} gaps=${scope.coverage.gaps.length}`);
  }
  const sample = await extractScope({ files: ['src/validate.js'], type: 'imports_module' });
  console.log('\nsample edges (src/validate.js):');
  for (const edge of sample.edges) console.log(`  ${edge.type} ${edge.from} -> ${edge.to} [${edge.resolution}] line ${edge.evidence.line} id=${edge.relationship_id.slice(0, 18)}`);
}
