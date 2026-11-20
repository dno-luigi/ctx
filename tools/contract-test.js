/**
 * Adapter contract test — the request body, not the suite verdict.
 *
 * `selftest:decisions` passed while the request field was renamed, which means it does not
 * assert the wire contract. A suite that passes on a broken contract cannot be an oracle
 * for an interface change, so this asserts the boundary directly:
 *
 *   - choice questions carry criteria as a record (object), never an array
 *   - record keys and values are the criteria strings
 *   - noul questions carry type and instructions only
 *   - the state field has the shape the provider declares
 *
 * Exit 0 = contract holds. Exit 1 = contract broken, with the failing assertion named.
 *
 * Usage: node tools/contract-test.js [--verbose]
 */

import { readFile } from 'node:fs/promises';

import { buildState } from '../adapters/decision/interface.js';
import { createPerplexity } from '../adapters/decision/perplexity.js';
import { createScaleDown } from '../adapters/decision/scaledown.js';

const ROOT = new URL('../', import.meta.url);
const verbose = process.argv.includes('--verbose');

const deciders = JSON.parse(await readFile(new URL('deciders.json', ROOT), 'utf8'));
const fixtures = {
  perplexity: deciders.models.find((model) => model.vendor === 'Perplexity' && model.available !== false),
  scaledown: deciders.models.find((model) => model.vendor === 'ScaleDown' && model.available !== false),
};

const input = {
  task: 'contract probe',
  sources: [{ id: 's1', kind: 'text', content: { text: 'The service keeps three replicas. Nothing is deleted early.' } }],
};
const state = buildState(input);
const questions = [
  { name: 'q_choice', type: 'choice', criteria: ['agree', 'disagree'], instructions: 'Do the sources agree?' },
  { name: 'q_noul', type: 'noul', instructions: 'Is the service configured with three replicas?', claim: 'The service keeps three replicas.' },
];

const failures = [];
const check = (name, condition, detail) => {
  if (!condition) failures.push({ name, detail });
  if (verbose) console.log(`  ${condition ? 'ok  ' : 'FAIL'} ${name}${condition ? '' : ` — ${detail}`}`);
};

for (const [label, descriptor] of Object.entries(fixtures)) {
  if (!descriptor) {
    check(`${label}: descriptor available`, false, 'no available model for this vendor');
    continue;
  }
  const adapter = label === 'scaledown' ? createScaleDown(descriptor) : createPerplexity(descriptor);
  const request = adapter.buildRequest({ state, questions });
  const sent = request.body?.questions ?? {};
  const choice = sent.q_choice;
  const noul = sent.q_noul;

  check(`${label}: request carries a questions object`, choice && typeof choice === 'object', JSON.stringify(Object.keys(sent)));
  if (!choice) continue;

  const criteria = choice.criteria;
  const isRecord = criteria !== null && typeof criteria === 'object' && !Array.isArray(criteria);
  check(`${label}: choice criteria is a record, not an array`, isRecord, `got ${Array.isArray(criteria) ? 'array' : typeof criteria}`);
  if (isRecord) {
    check(`${label}: criteria keys are the option strings`, JSON.stringify(Object.keys(criteria)) === JSON.stringify(['agree', 'disagree']), JSON.stringify(Object.keys(criteria)));
    check(`${label}: criteria values equal their keys`, Object.entries(criteria).every(([key, value]) => key === value), JSON.stringify(criteria));
  }
  check(`${label}: choice keeps its type discriminator`, choice.type === 'choice', String(choice.type));
  check(`${label}: noul carries no criteria`, noul && noul.criteria === undefined, JSON.stringify(noul));

  // `state_form` is declared as 'string', 'object', or 'object_text' (an object carrying the
  // text); anything object-shaped takes the object branch.
  const expectedState = String(adapter.capabilities?.state_form ?? '').startsWith('object');
  check(
    `${label}: state has the declared shape`,
    expectedState ? request.body.state !== null && typeof request.body.state === 'object' : typeof request.body.state === 'string',
    `${typeof request.body.state} (declared ${adapter.capabilities?.state_form})`
  );
  if (verbose) console.log(`  ${label} body keys: ${Object.keys(request.body).join(', ')}`);
}

if (failures.length) {
  console.error(`contract test failed: ${failures.length} assertion(s)`);
  for (const failure of failures) console.error(`  - ${failure.name}: ${failure.detail}`);
  process.exit(1);
}
console.log('contract test passed: request shape matches the declared wire contract');
