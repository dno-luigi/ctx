/**
 * Mechanical transcript scorer.
 *
 * Turns one agent transcript into the six measurements both pilots declare. Nothing here
 * judges quality: every number is a set operation against a frozen gold set, except
 * `unsupported_assumptions`, which is a count of claims with no cited file.
 *
 * Measured:
 *   retrieval_precision / retrieval_recall   files read vs gold impacted files
 *   symbol_recall                            gold symbols named
 *   impact_accuracy                          Jaccard of (changed files ∪ named symbols) vs gold
 *   missed_dependencies                      gold edges with neither symbol present
 *   repeated_work                            duplicate read/command with no intervening edit
 *   unsupported_assumptions                  claims with no supporting file the agent read
 *
 * Usage:
 *   node tools/score-transcript.js --transcript <path> --gold <path>
 *   node tools/score-transcript.js --selftest
 */

import { readFile } from 'node:fs/promises';

const ROOT = new URL('../', import.meta.url);

export function scoreTranscript(transcript, gold) {
  const read = new Set(transcript.files_read ?? []);
  const named = new Set(transcript.symbols_named ?? []);
  const changed = new Set(transcript.files_changed ?? []);
  const goldFiles = new Set(gold.impacted_files ?? []);
  const goldSymbols = new Set(gold.impacted_symbols ?? []);

  const hits = [...read].filter((file) => goldFiles.has(file));
  const retrieval_precision = read.size ? Number((hits.length / read.size).toFixed(3)) : null;
  const retrieval_recall = goldFiles.size ? Number((hits.length / goldFiles.size).toFixed(3)) : null;
  const symbolHits = [...named].filter((symbol) => goldSymbols.has(symbol));
  const symbol_recall = goldSymbols.size ? Number((symbolHits.length / goldSymbols.size).toFixed(3)) : null;

  const touched = new Set([...changed, ...named]);
  const goldTouched = new Set([...goldFiles, ...goldSymbols]);
  const intersection = [...touched].filter((item) => goldTouched.has(item)).length;
  const union = new Set([...touched, ...goldTouched]).size;
  const impact_accuracy = union ? Number((intersection / union).toFixed(3)) : null;

  // A dependency edge counts as recalled only when BOTH of its endpoints were reached: both
  // symbols named, or both files read/changed. An earlier version credited the edge when either
  // endpoint appeared, which let an agent that never opened spans.js be scored as having recalled
  // the spans → diff dependency.
  const missed = (gold.dependency_edges ?? []).filter(([from, to]) => {
    const parts = (edge) => {
      const text = String(edge);
      const split = text.lastIndexOf(':');
      return { file: text.slice(0, split), symbol: text.slice(split + 1) };
    };
    const [a, b] = [parts(from), parts(to)];
    const bothNamed = named.has(a.symbol) && named.has(b.symbol);
    const bothTouched = (read.has(a.file) || changed.has(a.file)) && (read.has(b.file) || changed.has(b.file));
    return !(bothNamed || bothTouched);
  });

  // Repeated work: a read or command repeated after it already happened, with no edit to
  // anything in between. Re-running a suite after an edit is not repeated work.
  const seen = new Set();
  let repeated = 0;
  let editsSinceRepeat = 0;
  for (const event of transcript.events ?? []) {
    if (event.type === 'edit') {
      editsSinceRepeat += 1;
      seen.clear();
      continue;
    }
    if (event.type !== 'read' && event.type !== 'command') continue;
    const key = `${event.type}:${event.target}`;
    if (seen.has(key)) repeated += 1;
    else seen.add(key);
  }
  void editsSinceRepeat;

  const supported = new Set([...read, ...changed]);
  const unsupported = (transcript.claims ?? []).filter(
    (claim) => !(claim.supported_by ?? []).some((file) => supported.has(file))
  );

  return {
    arm: transcript.arm ?? null,
    task: transcript.task ?? null,
    oracle_passed: Boolean(transcript.oracle_passed),
    retrieval_precision,
    retrieval_recall,
    symbol_recall,
    impact_accuracy,
    missed_dependencies: missed.length,
    missed_dependency_edges: missed.map(([from, to]) => `${from} → ${to}`),
    repeated_work: repeated,
    unsupported_assumptions: unsupported.length,
    unsupported_claims: unsupported.map((claim) => claim.text),
    tokens: transcript.tokens ?? null,
    tokens_to_first_productive_action: transcript.tokens_to_first_productive_action ?? null,
    turns: transcript.turns ?? null,
  };
}

// --------------------------------------------------------------------- self-test

const KNOWN = {
  perfect: {
    transcript: {
      arm: 'treatment',
      task: 'H2-CP1',
      files_read: ['cards/identity.js', 'inventory/scan.js'],
      symbols_named: ['anchorId', 'cardId', 'scanInventory'],
      files_changed: ['cards/identity.js'],
      events: [
        { type: 'read', target: 'cards/identity.js' },
        { type: 'read', target: 'inventory/scan.js' },
        { type: 'edit', target: 'cards/identity.js' },
        { type: 'command', target: 'npm run selftest:inventory' },
      ],
      claims: [{ text: 'identity is content-addressed', supported_by: ['cards/identity.js'] }],
      tokens: { input: 900, output: 200 },
      tokens_to_first_productive_action: 700,
      turns: 4,
      oracle_passed: true,
    },
    gold: {
      impacted_files: ['cards/identity.js', 'inventory/scan.js'],
      impacted_symbols: ['anchorId', 'cardId', 'scanInventory'],
      dependency_edges: [
        ['inventory/scan.js:scanInventory', 'cards/identity.js:identifySnapshot'],
      ],
    },
    expect: { retrieval_recall: 1, symbol_recall: 1, repeated_work: 0, unsupported_assumptions: 0, missed_dependencies: 0, oracle_passed: true },
  },
  missed_and_unsupported: {
    transcript: {
      arm: 'control',
      task: 'H2-CP1',
      files_read: ['cards/identity.js', 'src/spans.js'],
      symbols_named: ['anchorId'],
      files_changed: ['cards/identity.js'],
      events: [{ type: 'read', target: 'cards/identity.js' }],
      claims: [
        { text: 'scanInventory already returns content ids', supported_by: [] },
      ],
      oracle_passed: false,
    },
    gold: {
      impacted_files: ['cards/identity.js', 'inventory/scan.js'],
      impacted_symbols: ['anchorId', 'cardId', 'scanInventory'],
      dependency_edges: [['inventory/scan.js:scanInventory', 'cards/identity.js:identifySnapshot']],
    },
    expect: { retrieval_recall: 0.5, symbol_recall: 0.333, repeated_work: 0, unsupported_assumptions: 1, missed_dependencies: 1, oracle_passed: false },
  },
  repeated_work: {
    transcript: {
      arm: 'control',
      task: 'H2-CP1',
      files_read: ['inventory/scan.js'],
      symbols_named: ['scanInventory'],
      files_changed: [],
      events: [
        { type: 'read', target: 'inventory/scan.js' },
        { type: 'read', target: 'inventory/scan.js' },
        { type: 'command', target: 'npm run selftest' },
        { type: 'command', target: 'npm run selftest' },
      ],
      claims: [],
      oracle_passed: false,
    },
    gold: {
      impacted_files: ['inventory/scan.js'],
      impacted_symbols: ['scanInventory'],
      dependency_edges: [],
    },
    expect: { retrieval_recall: 1, symbol_recall: 1, repeated_work: 2, unsupported_assumptions: 0, missed_dependencies: 0 },
  },
};

function selftest() {
  let checks = 0;
  let failed = 0;
  for (const [name, fixture] of Object.entries(KNOWN)) {
    const result = scoreTranscript(fixture.transcript, fixture.gold);
    for (const [key, expected] of Object.entries(fixture.expect)) {
      checks += 1;
      const ok = result[key] === expected;
      if (!ok) failed += 1;
      console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}.${key} expected ${expected} got ${result[key]}`);
    }
  }
  console.log(`scorer selftest: ${checks - failed}/${checks} checks passed`);
  return failed === 0;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--selftest')) {
    process.exit(selftest() ? 0 : 1);
  }

  const get = (flag) => {
    const index = args.indexOf(flag);
    return index === -1 ? null : args[index + 1];
  };

  const transcriptPath = get('--transcript');
  const goldPath = get('--gold');
  if (!transcriptPath || !goldPath) {
    console.log('usage: node tools/score-transcript.js --transcript <path> --gold <path> | --selftest');
    process.exit(2);
  }

  const transcript = JSON.parse(await readFile(new URL(transcriptPath, ROOT), 'utf8'));
  const gold = JSON.parse(await readFile(new URL(goldPath, ROOT), 'utf8'));
  console.log(JSON.stringify(scoreTranscript(transcript, gold), null, 2));
}

if (process.argv[1]?.endsWith('score-transcript.js')) await main();
