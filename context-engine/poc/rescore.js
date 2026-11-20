/**
 * Rescore a recorded live QA run without paying for another model call.
 *
 * The answers are the model's; only the harness's citation parsing changed. Re-running the scorer over
 * the stored answers keeps the measurement honest: no new generation, no new spend, and the artifact
 * records that it was rescored and from which file.
 *
 * Usage: node context-engine/poc/rescore.js --run examples/live
 */

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { scoreAnswers, normalizeCitation } from './qa.js';
import { digest } from '../../src/canonical.js';

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

const runDir = path.resolve(engineRoot, args.run ?? 'examples/live');
const groundTruth = JSON.parse(readFileSync(path.join(engineRoot, 'fixtures/poc-repo.ground-truth.json'), 'utf8'));
const recorded = JSON.parse(readFileSync(path.join(runDir, 'qa-answers.json'), 'utf8'));
const pack = JSON.parse(readFileSync(path.join(runDir, 'pack-medium.json'), 'utf8'));
const reportPath = path.join(runDir, 'poc-report.json');
const report = JSON.parse(readFileSync(reportPath, 'utf8'));

const answers = recorded.answers.map((answer) => ({ ...answer, sources: (answer.sources ?? []).map(normalizeCitation).filter(Boolean) }));
const score = scoreAnswers({ answers, groundTruth });
const packPaths = new Set(pack.source_index.map((entry) => entry.path));
const unknownCitations = answers.flatMap((answer) => answer.sources.filter((source) => !packPaths.has(source)));

const rescored = {
  schema: 'context-engine/qa-rescore/v1',
  at: new Date().toISOString(),
  source_answers: path.relative(engineRoot, path.join(runDir, 'qa-answers.json')),
  source_answers_digest: digest(recorded.answers),
  reason: 'QA citations were returned as path:line; the scorer now normalises formatting before checking membership. Answers are unchanged; no model call was made.',
  score,
  unknown_citations: unknownCitations,
};

writeFileSync(path.join(runDir, 'qa-rescore.json'), JSON.stringify(rescored, null, 2));
report.qa = { ...report.qa, ...score, rescored: { from: rescored.source_answers, digest: rescored.source_answers_digest } };
report.qa_unknown_citations = unknownCitations;
writeFileSync(reportPath, JSON.stringify(report, null, 2));

console.log(`rescored ${score.questions} questions from recorded answers (no model call)`);
console.log(`retention=${score.retention} attribution=${score.attribution} reconstruction=${score.reconstruction} factual_errors=${score.factual_errors}`);
console.log(`unknown citations: ${unknownCitations.length ? unknownCitations.join(', ') : 'none'}`);
for (const entry of score.per_question) {
  console.log(`  ${entry.question_id}: retained=${entry.retained} attributed=${entry.attributed} missing=${entry.missing_sources.join('|') || '-'}`);
}
