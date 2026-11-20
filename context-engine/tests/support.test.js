/**
 * Support checks: numbers and identifiers must come from the quote, negation must not be invented.
 * The false-positive cases are asserted as carefully as the true positives — a checker that flags
 * correct findings is worse than no checker, because it teaches the reader to ignore it.
 *
 * Usage: node context-engine/tests/support.test.js
 */

import { checkSupport, summariseSupport } from '../src/support.js';

let checks = 0;
let failures = 0;
const check = (name, condition, detail = '') => {
  checks += 1;
  if (!condition) failures += 1;
  console.log(`  ${condition ? 'ok  ' : 'FAIL'} ${name}${condition || !detail ? '' : ` — ${detail}`}`);
};

const evidence = (quote, sourceId = 'config/defaults.json') => [{ source_id: sourceId, quote }];

console.log('numbers');
{
  check('a figure present in the quote is supported', checkSupport({ text: 'Retention is 30 days.', evidence: evidence('retention_days: 30') }).status === 'supported');
  const missing = checkSupport({ text: 'Retention is 45 days.', evidence: evidence('retention_days: 30') });
  check('a figure absent from the quote is flagged', missing.status === 'unsupported' && missing.flags[0].code === 'number_not_in_quote' && missing.flags[0].token === '45');
  check('an identifier with digits is not read as a figure', checkSupport({ text: 'ADR-001 chose a fixed window.', evidence: evidence('ADR-001 chose a fixed 30-day window.') }).status === 'supported');
  check('a hyphenated quantity is not read as a figure', checkSupport({ text: 'A 30-day window was chosen.', evidence: evidence('chosen: 30-day window') }).status === 'supported');
}

console.log('identifiers');
{
  check('an identifier present in the quote is supported', checkSupport({ text: 'The limit is MAX_BATCH.', evidence: evidence('export const MAX_BATCH = 100;', 'src/ingest.js') }).status === 'supported');
  const missing = checkSupport({ text: 'The limit is MAX_BATCH.', evidence: evidence('export const LIMIT = 100;', 'src/ingest.js') });
  check('an identifier absent from the quote is flagged', missing.flags.some((flag) => flag.code === 'identifier_not_in_quote'));

  // The path is the citation, not quote content: requiring it inside the quote would flag every
  // correct finding that names the file it cites.
  const selfCited = checkSupport({ text: 'config/defaults.json sets the timeout to 5.', evidence: evidence('"timeout_seconds": 5', 'config/defaults.json') });
  check('a cited path need not appear inside its own quote', selfCited.status === 'supported', JSON.stringify(selfCited.flags));

  const foreign = checkSupport({ text: 'src/store.js sets the timeout to 5.', evidence: evidence('"timeout_seconds": 5', 'config/defaults.json') });
  check('a path that is not a cited source is flagged', foreign.flags.some((flag) => flag.code === 'identifier_not_in_quote'));
}

console.log('negation');
{
  check('a negative claim on a positive quote is flagged', checkSupport({ text: 'The store never deletes objects.', evidence: evidence('The store deletes expired objects.') }).flags.some((flag) => flag.code === 'negation_not_in_quote'));
  check('a positive claim on a negative quote is flagged', checkSupport({ text: 'The store deletes expired objects.', evidence: evidence('The store MUST never delete an unexpired object.') }).flags.some((flag) => flag.code === 'negation_only_in_quote'));
  check('agreement on negation is supported', checkSupport({ text: 'The store MUST never delete an unexpired object.', evidence: evidence('The store MUST never delete an unexpired object.') }).status === 'supported');
  check('a decision verb is not a negation', checkSupport({ text: 'A fixed window was chosen over a sliding TTL.', evidence: evidence('rejected a sliding TTL; chose a fixed window') }).status === 'supported');
}

console.log('evidence and aggregation');
{
  check('a finding with no evidence is reported as such', checkSupport({ text: 'anything', evidence: [] }).status === 'no_evidence');
  const summary = summariseSupport({
    label: 'test',
    findings: [
      { text: 'Retention is 30 days.', kind: 'state', evidence: evidence('retention_days: 30') },
      { text: 'Retention is 45 days.', kind: 'state', evidence: evidence('retention_days: 30') },
    ],
  });
  check('the summary counts supported and flagged findings', summary.supported === 1 && summary.unsupported === 1 && summary.supported_rate === 0.5);
  check('the summary keeps examples of each flag', summary.examples.number_not_in_quote.length === 1);
}

console.log(`\nsupport tests: ${checks - failures}/${checks} checks passed`);
process.exit(failures ? 1 : 0);
