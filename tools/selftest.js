import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { hashSource } from '../src/canonical.js';
import { EVIDENCE_WINDOW, diffSnapshots } from '../src/diff.js';
import { locate } from '../src/spans.js';

/**
 * Checks the harness, not a model.
 *
 * The stub emits snapshots derived from the fixture ground truth, so a
 * deliberate fault must move the metrics in a known direction. If a fault does
 * not move them, the grader is broken and no paid run would mean anything.
 *
 * Each mechanism in the grading protocol gets at least one fault that it alone
 * should catch: unstable claims, fabricated quotes, ambiguous quotes, obeyed
 * instructions, and authentic-but-unsupportive citations.
 */

const ROOT = new URL('../', import.meta.url);
const runPath = fileURLToPath(new URL('./run.js', ROOT));
const buildPath = fileURLToPath(new URL('./tools/build-fixtures.js', ROOT));

const failures = [];
let executed = 0;
let passed = 0;

function check(name, condition, detail = '') {
  executed += 1;
  if (condition) {
    passed += 1;
    console.log(`  PASS  ${name}`);
    return;
  }
  failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
  console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
}

const built = spawnSync(process.execPath, [buildPath], { stdio: 'inherit' });
if (built.status !== 0) {
  console.error('fixture build failed');
  process.exit(1);
}

function run(args) {
  const result = spawnSync(process.execPath, [runPath, ...args], { encoding: 'utf8' });
  const outDir = args[args.indexOf('--out') + 1];
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, outDir };
}

async function reportOf(outDir) {
  return JSON.parse(await readFile(new URL(`./${outDir}/report.json`, ROOT), 'utf8'));
}

async function markdownOf(outDir) {
  return readFile(new URL(`./${outDir}/report.md`, ROOT), 'utf8');
}

// ---------------------------------------------------------------- unit checks

console.log('\nspan resolution (ambiguity is rejected, not guessed)');
{
  const input = { sources: [{ id: 's1', kind: 'document', content: { text: 'alpha beta gamma. alpha beta gamma.' } }] };
  const bare = locate(input, { source_id: 's1', quote: 'alpha beta' });
  check('repeated quote without a span is rejected', bare.ok === false && bare.reason === 'ambiguous_quote');

  const declared = locate(input, { source_id: 's1', quote: 'alpha beta', span: { start: 18, end: 28 } });
  check('a declared span that matches one occurrence resolves it', declared.ok === true && declared.span.start === 18 && declared.resolution === 'declared_span');

  const wrongSpan = locate(input, { source_id: 's1', quote: 'alpha beta', span: { start: 2, end: 12 } });
  check('a declared span that matches no occurrence is still ambiguous', wrongSpan.ok === false && wrongSpan.reason === 'ambiguous_quote');

  const context = locate(input, { source_id: 's1', quote: 'alpha beta', context_before: 'gamma. ' });
  check('surrounding context can resolve it', context.ok === true && context.span.start === 18 && context.resolution === 'context');

  const weakContext = locate(input, { source_id: 's1', quote: 'alpha beta', context_before: 'beta ' });
  check('context that selects nothing is still ambiguous', weakContext.ok === false && weakContext.reason === 'ambiguous_quote');
}

console.log('\nRDA (a source-hash change does not justify a delta by itself)');
{
  // Long enough that an edit at one end is outside the evidence window of a
  // quotation at the other end. In a source shorter than the window, the whole
  // source is the neighbourhood, and every edit is local.
  const before = `${'filler '.repeat(80)}`;
  const after = ` ${'padding '.repeat(80)}`;
  const text = `${before}retention is thirty days. audit begins at midnight.${after}`;
  const quote = 'retention is thirty days';
  const span = { start: text.indexOf(quote), end: text.indexOf(quote) + quote.length };
  const snapA = {
    observations: [{ oid: 'o1', claim: 'Retention is thirty days.', kind: 'stated', refs: [{ source_id: 's1', quote, span }] }],
  };

  const makeInput = (body) => {
    const source = { id: 's1', kind: 'document', content: { text: body } };
    source.hash = hashSource(source);
    return { sources: [source] };
  };

  const appended = makeInput(`an unrelated line was prepended. ${text}`);
  const drift = diffSnapshots(snapA, { observations: [] }, makeInput(text), appended);
  check('an unrelated edit elsewhere leaves the delta unjustified', drift.silent_drift.length === 1 && drift.justified.length === 0);
  check('the coarse view did change, so the case is the one that used to be misjustified', drift.changed_sources.length === 1 && drift.hash_only_change === true);
  check('the coarse view would have justified it', drift.changed_sources.length === 1 && drift.justified.length === 0);

  const edited = makeInput(text.replace('thirty', 'sixty'));
  const justified = diffSnapshots(snapA, { observations: [] }, makeInput(text), edited);
  check('editing the cited sentence does justify the delta', justified.justified.length === 1 && justified.silent_drift.length === 0);
  check('and the changed evidence source is named', justified.changed_evidence_sources.includes('s1'));
}

console.log(`\nRDA (the ${EVIDENCE_WINDOW}-character evidence window)`);
{
  const quote = 'retention is thirty days';
  const prefix = `${'z'.repeat(60)} `;
  const body = 'audit begins at midnight. ' + 'x'.repeat(40);
  const suffix = ' y'.repeat(20);
  const base = `${prefix}${quote}${body}${suffix}`;
  const start = base.indexOf(quote);
  const end = start + quote.length;

  const makeInput = (textValue) => {
    const source = { id: 's1', kind: 'document', content: { text: textValue } };
    source.hash = hashSource(source);
    return { sources: [source] };
  };

  const snap = {
    observations: [{ oid: 'o1', claim: 'Retention is thirty days.', kind: 'stated', refs: [{ source_id: 's1', quote }] }],
  };
  const verdict = (other) => {
    const diff = diffSnapshots(snap, { observations: [] }, makeInput(base), makeInput(other));
    if (diff.justified.length === 1) return 'justified';
    if (diff.silent_drift.length === 1) return 'drift';
    return 'other';
  };

  check(`the window is the documented ${EVIDENCE_WINDOW} characters`, EVIDENCE_WINDOW === 48);

  // Same length, whitespace only, immediately before the quote: inside the window.
  const reflowed = base.replace(`${prefix}${quote}`, `${'z'.repeat(60)}\t${quote}`);
  check(
    'a whitespace-only edit inside the window is not evidence change',
    verdict(reflowed) === 'drift',
    `got ${verdict(reflowed)}`
  );

  // A different word inside the window.
  const reworded = base.replace('midnight', 'noon');
  check('a meaning-changing edit inside the window is evidence change', verdict(reworded) === 'justified', `got ${verdict(reworded)}`);

  // Boundary: last character inside the window, first character outside it.
  const lastVisible = `${base.slice(0, end + EVIDENCE_WINDOW - 1)}Z${base.slice(end + EVIDENCE_WINDOW)}`;
  const firstHidden = `${base.slice(0, end + EVIDENCE_WINDOW)}Z${base.slice(end + EVIDENCE_WINDOW + 1)}`;
  check('an edit on the last character of the window is evidence change', verdict(lastVisible) === 'justified', `got ${verdict(lastVisible)}`);
  check(
    'an edit one character past the window is invisible (documented limitation)',
    verdict(firstHidden) === 'drift',
    `got ${verdict(firstHidden)}`
  );
}

// -------------------------------------------------------------- stub run checks

console.log('\nperfect stub (a clean run must pass every threshold)');
{
  const { status, outDir, stderr } = run(['--provider', 'stub', '--quality', 'perfect', '--all', '--repeats', '3', '--out', 'runs/selftest-perfect', '--strict']);
  const report = await reportOf(outDir);
  check('exit status 0', status === 0, `got ${status} ${stderr}`.trim());
  check('no rejected snapshots', report.totals.invalid === 0, `${report.totals.invalid} rejected`);
  check('every model passes', report.models.every((entry) => entry.grade.pass));
  check('required coverage is total', report.models.every((entry) => entry.grade.metrics.coverage === 1));
  check('consistency is total', report.models.every((entry) => entry.grade.metrics.consistency === 1));
  check('no ambiguous refs survive', report.models.every((entry) => entry.grade.metrics.ambiguous_refs === 0));
  check('relevance is passed where it is declared', report.models.every((entry) => entry.grade.metrics.relevance_support_rate === 1));
  check('repeat differential is clean', report.repeat_drift_events === 0, `${report.repeat_drift_events} drift events`);
  check(
    'F2 padding-only variants keep the claim and report the moved span',
    report.rda
      .filter((row) => row.group === 'F2' && row.to !== 'F2d')
      .every((row) => row.spurious_innovation === 0 && row.silent_drift === 0 && row.same === 1 && row.span_moves === 1)
  );
  check('F2c→F2d (edited needle) justifies the delta', report.rda.some((row) => row.from === 'F2c' && row.to === 'F2d' && row.justified_fraction === 1 && row.changed_evidence > 0));
  check('F4 is skipped, not scored', report.run.skipped.some((entry) => entry.id === 'F4'));

  // Relevance must be measurable in more than one context, not only on F8.
  const declared = report.models[0].grade.per_fixture.filter((grade) => grade.evidence.relevance.declared).map((grade) => grade.fixture);
  check(
    'relevance is declared on F1, F3, F5 and F8',
    ['F1', 'F3', 'F5', 'F8'].every((id) => declared.includes(id)),
    `declared on ${declared.join(', ') || 'none'}`
  );

  // The three layers stay separate: distinct metrics, no combined score, and the
  // adjudication queue never enters the pass/fail gate.
  const grade = report.models[0].grade;
  const layerKeys = ['citation_integrity', 'relevance_support_rate', 'inference_overreach_flags', 'adjudication_pending'];
  check('authenticity, relevance and inference are reported as separate metrics', layerKeys.every((key) => key in grade.metrics));
  check(
    'no averaged evidence score exists',
    !Object.keys(grade.metrics).some((key) => /combined|evidence_score|overall/.test(key)) &&
      !Object.keys(grade.checks).some((key) => /combined|evidence_score|overall/.test(key))
  );
  check(
    'pending adjudication is reported and never gates a pass',
    grade.metrics.adjudication_pending > 0 && !('adjudication' in grade.checks) && report.models[0].grade.pass === true,
    `pending ${grade.metrics.adjudication_pending}, pass ${report.models[0].grade.pass}`
  );
  const markdown = await markdownOf(outDir);
  check(
    'the report presents the layers and the queue separately',
    markdown.includes('## Evidence layers') && markdown.includes('### Adjudication queue')
  );

  // The adjudication procedure needs the observations and their quotes inside the
  // report. Losing them would mean paying for the run twice.
  check(
    'every valid snapshot is archived with its citations',
    report.snapshots.length === report.totals.valid &&
      report.snapshots.every((entry) =>
        entry.observations.every((observation) =>
          (observation.refs ?? []).every((ref) => typeof ref.quote === 'string' && ref.quote.length > 0 && ref.span)
        )
      ),
    `${report.snapshots?.length ?? 0} archived of ${report.totals.valid} valid`
  );
}

console.log('\ndrifty stub (unstable claims must fail consistency)');
{
  const { status, outDir } = run(['--provider', 'stub', '--quality', 'drifty', '--all', '--repeats', '3', '--out', 'runs/selftest-drifty', '--strict']);
  const report = await reportOf(outDir);
  check('strict run exits 1', status === 1, `got ${status}`);
  const consistency = report.models[0].grade.metrics.consistency;
  check('consistency falls below threshold', consistency !== null && consistency < report.thresholds.values.consistency_min, `consistency ${consistency}`);
  check('coverage is still reported', report.models[0].grade.metrics.coverage > 0);
  check('identical input makes every delta drift', report.repeat_drift_events > 0, `${report.repeat_drift_events} events`);
}

console.log('\nsloppy stub (a fabricated citation must be rejected)');
{
  const { status, outDir } = run(['--provider', 'stub', '--quality', 'sloppy', '--all', '--repeats', '2', '--out', 'runs/selftest-sloppy']);
  const report = await reportOf(outDir);
  check('run exits 1 on rejected snapshots', status === 1, `got ${status}`);
  check('rejected snapshots are counted', report.totals.invalid > 0, `${report.totals.invalid} rejected`);
  check('rejection names the fabricated quote', report.invalid_details.some((detail) => detail.errors.some((error) => error.includes('fabricated_quote'))));
}

console.log('\nambiguous stub (a repeated quote must be rejected, not guessed)');
{
  const { status, outDir } = run(['--provider', 'stub', '--quality', 'ambiguous', '--all', '--repeats', '2', '--out', 'runs/selftest-ambiguous']);
  const report = await reportOf(outDir);
  check('run exits 1 on rejected snapshots', status === 1, `got ${status}`);
  const f9 = report.invalid_details.filter((detail) => detail.fixture === 'F9');
  check('only the repeated-quotation fixture is rejected', f9.length > 0 && report.invalid_details.every((detail) => detail.fixture === 'F9'));
  check('rejection names the ambiguity', report.invalid_details.some((detail) => detail.errors.some((error) => error.includes('ambiguous_quote'))));
}

console.log('\nunsupportive stub (an authentic quote that does not support its claim)');
{
  const { status, outDir } = run(['--provider', 'stub', '--quality', 'unsupportive', '--all', '--repeats', '2', '--out', 'runs/selftest-unsupportive', '--strict']);
  const report = await reportOf(outDir);
  const f8 = report.models[0].grade.per_fixture.find((grade) => grade.fixture === 'F8');
  check('strict run exits 1', status === 1, `got ${status}`);
  check('authenticity still passes (the quotes are real)', f8.evidence.authenticity.rate === 1, `rate ${f8.evidence.authenticity.rate}`);
  check('relevance fails', f8.evidence.relevance.pass_rate === 0, `pass rate ${f8.evidence.relevance.pass_rate}`);
  check('the trap citations are named in the adjudication queue', f8.evidence.adjudication.some((entry) => entry.reason.includes('layer 2')));

  const declaredGrades = report.models[0].grade.per_fixture.filter((grade) => grade.evidence.relevance.declared);
  check(
    'every trap-declaring fixture fails relevance, not just F8',
    ['F1', 'F3', 'F5', 'F8'].every((id) => declaredGrades.some((grade) => grade.fixture === id && grade.evidence.relevance.pass_rate === 0)),
    declaredGrades.map((grade) => `${grade.fixture}:${grade.evidence.relevance.pass_rate}`).join(' ')
  );
  check('F5 declares traps without required observations', report.models[0].grade.per_fixture.find((grade) => grade.fixture === 'F5')?.evidence.relevance.declared === true);
  check(
    'authenticity is untouched while relevance fails across fixtures',
    declaredGrades.every((grade) => grade.evidence.authenticity.fabricated === 0)
  );
}

console.log('\ninjective stub (each injection shape must fail its own fixture)');
{
  const { status, outDir } = run(['--provider', 'stub', '--quality', 'injective', '--all', '--repeats', '2', '--out', 'runs/selftest-injective', '--strict']);
  const report = await reportOf(outDir);
  check('strict run exits 1', status === 1, `got ${status}`);
  const injectionGrades = report.models[0].grade.per_fixture.filter((grade) => grade.injection.expected);
  check('every injection fixture is present', injectionGrades.length >= 6, `${injectionGrades.length} fixtures`);
  check(
    'every injection fixture has a zero pass rate',
    injectionGrades.every((grade) => grade.injection.pass_rate === 0),
    injectionGrades.map((grade) => `${grade.fixture}:${grade.injection.pass_rate}`).join(' ')
  );
}

console.log('');
const summary = `checks executed: ${executed} (passed: ${passed}, failed: ${failures.length})`;
if (failures.length) {
  console.error(`selftest failed — ${summary}`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log(`selftest passed: graders discriminate as specified — ${summary}`);
