/**
 * Re-check QA against a rebuilt pack, using a stored snapshot. No source scan, no new acquisition.
 *
 * Two modes:
 *   retrieval  $0. Measures whether the rebuilt pack contains the evidence.
 *   model      one model call, explicit budget. Measures attribution and reconstruction the way the
 *              pre-registered gate does.
 *
 * Writes a new pack and `qa-recheck.json`; it does not overwrite the original run artifacts.
 *
 * Usage:
 *   node context-engine/poc/recheck-qa.js --run examples/live-approved
 *   node context-engine/poc/recheck-qa.js --run examples/live-approved --qa model --budget-usd 0.01
 */

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { compact, renderPack } from '../src/compact.js';
import { createProvider, loadModels, resolveModel } from '../src/providers.js';
import { retrievalAnswers, modelAnswers, scoreAnswers } from './qa.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const engineRoot = path.resolve(here, '..');

const args = {};
const argv = process.argv.slice(2);
for (let index = 0; index < argv.length; index += 1) {
  if (!argv[index].startsWith('--')) continue;
  const [key, inline] = argv[index].slice(2).split('=');
  if (inline !== undefined) args[key] = inline;
  else if (argv[index + 1] && !argv[index + 1].startsWith('--')) args[key] = argv[++index];
  else args[key] = true;
}

const runDir = path.resolve(engineRoot, args.run ?? 'examples/live-approved');
const groundTruth = JSON.parse(readFileSync(path.join(engineRoot, 'fixtures/poc-repo.ground-truth.json'), 'utf8'));
const snapshot = JSON.parse(readFileSync(path.join(runDir, 'snapshot-poc-repo.json'), 'utf8'));
const profile = args.profile ?? 'medium';

const pack = compact({ snapshot, profile });
writeFileSync(path.join(runDir, `pack-${profile}-contradictions.json`), JSON.stringify(pack, null, 2));
writeFileSync(path.join(runDir, `pack-${profile}-contradictions.md`), renderPack(pack));

const mode = args.qa === 'model' ? 'model' : 'retrieval-from-pack';
let answers;
let usage = null;
let providerInfo = null;
if (mode === 'model') {
  const budget = { usd: Number(args['budget-usd'] ?? 0), spent: 0 };
  if (!(budget.usd > 0)) throw new Error('model QA requires --budget-usd greater than zero');
  const registry = await loadModels();
  const model = resolveModel(registry, args.model);
  const provider = createProvider({ kind: 'openai-compatible', registry, model, budget });
  const result = await modelAnswers({ provider, pack, questions: groundTruth.questions });
  answers = result.answers;
  usage = { ...result.usage, budget_usd: budget.usd, spent: budget.spent };
  providerInfo = result.provider;
} else {
  answers = retrievalAnswers({ pack, questions: groundTruth.questions });
}

const score = scoreAnswers({ answers, groundTruth });
const packPaths = new Set(pack.source_index.map((entry) => entry.path));
const unknownCitations = answers.flatMap((answer) => (answer.sources ?? []).filter((source) => !packPaths.has(source)));

const result = {
  schema: 'context-engine/qa-recheck/v1',
  at: new Date().toISOString(),
  run: path.relative(engineRoot, runDir),
  snapshot_id: snapshot.snapshot_id,
  mode,
  pack: {
    file: `pack-${profile}-contradictions.json`,
    digest: pack.digest,
    items_included: pack.coverage.items_included,
    items_total: pack.coverage.items_total,
    omissions: pack.coverage.items_omitted,
    contradiction_items: pack.sections.contradictions?.length ?? 0,
    reconstructible: pack.reconstructible,
  },
  provider: providerInfo,
  usage,
  score,
  answers,
  unknown_citations: unknownCitations,
};
writeFileSync(path.join(runDir, 'qa-recheck.json'), JSON.stringify(result, null, 2));

console.log(`rechecked ${score.questions} questions from the stored snapshot (${mode}), pack ${pack.pack_id}`);
console.log(`retention=${score.retention} attribution=${score.attribution} reconstruction=${score.reconstruction} factual_errors=${score.factual_errors}`);
console.log(`contradiction items in pack: ${pack.sections.contradictions?.length ?? 0} · omitted: ${pack.coverage.items_omitted}`);
if (usage) console.log(`tokens ${usage.input_tokens}/${usage.output_tokens} · charge $${usage.cost_usd} (${usage.cost_source}) · spent $${usage.spent} of $${usage.budget_usd}`);
for (const entry of score.per_question) {
  console.log(`  ${entry.question_id}: retained=${entry.retained} attributed=${entry.attributed} missing=${entry.missing_sources.join('|') || '-'}`);
}
