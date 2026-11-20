/**
 * Contract probe. Not part of the harness path and not imported by it.
 *
 * The live endpoint rejected `criteria` as an array for a choice question. This
 * script sends minimal candidate bodies per engine until the accepted shape is
 * known, so the adapters are written against the engine rather than against a guess.
 * States are tiny, and every rejected probe costs nothing.
 *
 * Run: node tools/probe-decisions.js
 */

const ENDPOINT = 'https://openrouter.ai/api/alpha/decisions';
const KEY = process.env.OPENROUTER_API_KEY;

const STATE = 'The queue consumer committed offset 88113 at 03:12. The retry of batch 512 completed after 7 seconds.';

const MODELS = [
  'scaledown/classify-1',
  'perplexity/pplx-decider-v1.2',
  'perplexity/pplx-decider-flash-v1.2',
  'perplexity/pplx-decider-v1.3',
];

const recordCriteria = { a: 'the offset is 88113', b: 'the offset is 512' };
const arrayCriteria = ['the offset is 88113', 'the offset is 512'];

async function probe(label, body) {
  const response = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${KEY}`,
      'HTTP-Referer': 'https://github.com/Ai-Nspired/gca-experiment',
      'X-Title': 'gca contract probe',
    },
    body: JSON.stringify(body),
  });
  const payload = await response.json().catch(() => null);
  console.log(`\n== ${label}  HTTP ${response.status}`);
  console.log(JSON.stringify(payload).slice(0, 700));
  return { status: response.status, payload };
}

for (const model of MODELS) {
  const base = { model, state: model.startsWith('scaledown') ? { text: STATE } : STATE };

  await probe(`${model} | choice, criteria as record`, {
    ...base,
    questions: { q: { type: 'choice', instructions: 'Which offset was committed?', criteria: recordCriteria } },
  });

  await probe(`${model} | choice, criteria as array`, {
    ...base,
    questions: { q: { type: 'choice', instructions: 'Which offset was committed?', criteria: arrayCriteria } },
  });

  if (model.includes('v1.3')) {
    await probe(`${model} | locate over a state with an offset`, {
      ...base,
      questions: {
        q_span: { type: 'locate', instructions: 'The sentence stating how long the retry took.' },
      },
    });
  }
}
