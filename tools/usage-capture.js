/**
 * Usage capture for one agent run.
 *
 * Self-reported totals are not a measurement: a number the agent computes about itself can be
 * wrong in the direction that flatters it. This captures what the runtime actually reports,
 * keeps agent consumption separate from GCA processing cost, and records what was *not*
 * available rather than estimating it.
 *
 * Fields:
 *   input_tokens, output_tokens      required; null if the runtime did not report them
 *   cached_input_tokens              optional; null if not exposed
 *   tool_context_tokens              optional; null if not exposed
 *   agent_total_tokens               input + output only, never mixed with GCA cost
 *   gca_processing_usd               measured provider cost of building the context pack
 *   unavailable                      explicit list of fields the runtime did not supply
 *
 * GCA cost and agent tokens are never summed into one figure.
 *
 * Usage: node tools/usage-capture.js --selftest
 */

const FIELD_MAP = {
  input_tokens: ['input_tokens', 'prompt_tokens', 'usage.input_tokens', 'usage.prompt_tokens'],
  output_tokens: ['output_tokens', 'completion_tokens', 'usage.output_tokens', 'usage.completion_tokens'],
  cached_input_tokens: ['cached_input_tokens', 'cache_read_input_tokens', 'usage.cached_input_tokens'],
  tool_context_tokens: ['tool_context_tokens', 'tool_tokens', 'usage.tool_context_tokens'],
};

const read = (raw, path) => path.split('.').reduce((value, key) => (value === null || value === undefined ? undefined : value[key]), raw);

export function captureUsage(raw, { gcaProcessingUsd = null } = {}) {
  const captured = {};
  const unavailable = [];
  for (const [field, paths] of Object.entries(FIELD_MAP)) {
    let value;
    for (const path of paths) {
      const candidate = read(raw, path);
      if (typeof candidate === 'number' && Number.isFinite(candidate)) {
        value = candidate;
        break;
      }
    }
    captured[field] = value ?? null;
    if (value === undefined || value === null) {
      const required = field === 'input_tokens' || field === 'output_tokens';
      unavailable.push({ field, required, reason: required ? 'runtime did not report a required total' : 'not exposed by this runtime' });
    }
  }

  const agentTotal =
    captured.input_tokens !== null && captured.output_tokens !== null ? captured.input_tokens + captured.output_tokens : null;

  return {
    schema: 'gca-usage/v1',
    input_tokens: captured.input_tokens,
    output_tokens: captured.output_tokens,
    cached_input_tokens: captured.cached_input_tokens,
    tool_context_tokens: captured.tool_context_tokens,
    agent_total_tokens: agentTotal,
    gca_processing_usd: typeof gcaProcessingUsd === 'number' ? gcaProcessingUsd : null,
    unavailable,
    completeness: unavailable.filter((entry) => entry.required).length === 0 ? 'required_fields_present' : 'incomplete',
    notes: [
      'agent_total_tokens is input + output only; GCA processing cost is never added to it',
      'null means not reported, never zero and never an estimate',
    ],
  };
}

// ------------------------------------------------------------------ self-test

const CASES = [
  {
    name: 'full runtime report',
    raw: { input_tokens: 1200, output_tokens: 340, cached_input_tokens: 800, tool_context_tokens: 512 },
    gca: 0.000124,
    expect: { input_tokens: 1200, output_tokens: 340, cached_input_tokens: 800, tool_context_tokens: 512, agent_total_tokens: 1540, gca_processing_usd: 0.000124, completeness: 'required_fields_present', unavailable: 0 },
  },
  {
    name: 'openai-style nested usage, no cache',
    raw: { usage: { prompt_tokens: 900, completion_tokens: 120 } },
    gca: null,
    expect: { input_tokens: 900, output_tokens: 120, cached_input_tokens: null, agent_total_tokens: 1020, completeness: 'required_fields_present', unavailable: 2 },
  },
  {
    name: 'runtime reports nothing',
    raw: {},
    gca: 0.0002,
    expect: { input_tokens: null, output_tokens: null, agent_total_tokens: null, completeness: 'incomplete', unavailable: 4 },
  },
];

function selftest() {
  let checks = 0;
  let failed = 0;
  for (const testCase of CASES) {
    const result = captureUsage(testCase.raw, { gcaProcessingUsd: testCase.gca });
    for (const [key, expected] of Object.entries(testCase.expect)) {
      checks += 1;
      const actual = key === 'unavailable' ? result.unavailable.length : result[key];
      const ok = actual === expected;
      if (!ok) failed += 1;
      console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${testCase.name}.${key} expected ${expected} got ${actual}`);
    }
  }
  console.log(`usage capture selftest: ${checks - failed}/${checks} checks passed`);
  return failed === 0;
}

function main() {
  if (process.argv.includes('--selftest')) process.exit(selftest() ? 0 : 1);
  console.log(JSON.stringify(captureUsage({ input_tokens: 0, output_tokens: 0 }, { gcaProcessingUsd: 0 }), null, 2));
}

if (process.argv[1]?.endsWith('usage-capture.js')) main();
