/**
 * Spend guard: one authorised attempt per run id, retries refused at the provider boundary and
 * recorded in a ledger that survives the process.
 *
 * Usage: node context-engine/tests/guard.test.js
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { openSpendGuard, readSpendLedger, SpendRefusal } from '../src/guard.js';
import { createProvider } from '../src/providers.js';

let checks = 0;
let failures = 0;
const check = (name, condition, detail = '') => {
  checks += 1;
  if (!condition) failures += 1;
  console.log(`  ${condition ? 'ok  ' : 'FAIL'} ${name}${condition || !detail ? '' : ` — ${detail}`}`);
};

const refusal = (fn) => {
  try {
    fn();
    return null;
  } catch (error) {
    return error instanceof SpendRefusal ? error : { wrongType: error };
  }
};

const refusalAsync = async (fn) => {
  try {
    await fn();
    return null;
  } catch (error) {
    return error instanceof SpendRefusal ? error : { wrongType: error };
  }
};

const dir = mkdtempSync(path.join(tmpdir(), 'ce-guard-'));
const ledgerPath = path.join(dir, 'spend-ledger.jsonl');
const runId = 'run-guard-test';
let clock = 0;
const now = () => `2026-11-20T00:00:${String(clock++).padStart(2, '0')}Z`;

console.log('authorisation');
{
  const guard = openSpendGuard({ runId, ledgerPath, budgetUsd: 0.05, purpose: 'scan', clock: now });
  check('a fresh run id opens attempt 1', guard.attempt === 1 && guard.authorizedUsd === 0.05);
  check('the ledger records the attempt before any call', readSpendLedger(ledgerPath).some((row) => row.event === 'attempt_opened' && row.run_id === runId));

  const second = refusal(() => openSpendGuard({ runId, ledgerPath, budgetUsd: 0.05, clock: now }));
  check('a second attempt on the same id is refused', second instanceof SpendRefusal && second.code === 'retry_not_authorized', second?.message);
  check('the refusal names the prior spend', second?.detail?.prior_spend_usd === 0 && second?.detail?.prior_attempts === 1);
  const attempts = readSpendLedger(ledgerPath).filter((row) => row.event === 'attempt_opened' && row.run_id === runId);
  check('a refused retry does not create an attempt', attempts.length === 1, String(attempts.length));

  const selfAuthorised = refusal(() => openSpendGuard({ runId, ledgerPath, budgetUsd: 0.05, authorizeRetry: runId, clock: now }));
  check('a run id cannot authorise its own retry', selfAuthorised instanceof SpendRefusal && selfAuthorised.code === 'retry_token_invalid');

  const emptyToken = refusal(() => openSpendGuard({ runId, ledgerPath, budgetUsd: 0.05, authorizeRetry: '', clock: now }));
  check('an empty retry token is not an authorisation', emptyToken instanceof SpendRefusal && emptyToken.code === 'retry_not_authorized');

  guard.close({ outcome: 'test' });
  check('closing writes an attempt_closed row', readSpendLedger(ledgerPath).some((row) => row.event === 'attempt_closed' && row.attempt === 1));
  check('a closed guard refuses further spending', refusal(() => guard.assertCanAfford(0))?.code === 'guard_closed');
}

console.log('explicit retry authorisation');
{
  const authorised = openSpendGuard({ runId, ledgerPath, budgetUsd: 0.02, authorizeRetry: 'operator-approved-run-2', clock: now });
  check('a distinct authorisation opens attempt 2', authorised.attempt === 2);
  const row = readSpendLedger(ledgerPath).find((entry) => entry.event === 'attempt_opened' && entry.attempt === 2);
  check('the ledger records who authorised the retry', row?.authorize_retry === 'operator-approved-run-2');
  check('the retry carries its own budget', row?.authorized_usd === 0.02);
  authorised.close({ outcome: 'test' });
}

console.log('missing authorisation and budget');
{
  check('no run id is refused', refusal(() => openSpendGuard({ runId: null, ledgerPath, budgetUsd: 1 }))?.code === 'run_id_required');
  check('no budget is refused', refusal(() => openSpendGuard({ runId: 'run-x', ledgerPath: path.join(dir, 'b.jsonl'), budgetUsd: 0 }))?.code === 'budget_required');
}

console.log('provider boundary (no network is available to this test)');
{
  const registry = { endpoint: 'http://127.0.0.1:9', key_env: 'GUARD_TEST_KEY' };
  const model = { id: 'test-model', slug: 'z-ai/glm-5.3-flash', pricing: { input_per_mtok: 0.0399, output_per_mtok: 0.0784 }, context_tokens: 1050000 };
  const env = { GUARD_TEST_KEY: 'not-a-real-key' };
  let fetched = 0;
  const fetchImpl = async () => {
    fetched += 1;
    throw new Error('the test must not reach the network');
  };

  const unguarded = refusal(() =>
    createProvider({ kind: 'openai-compatible', registry, model, budget: { usd: 1, spent: 0 }, env, fetchImpl })
  );
  check('a paid provider cannot be constructed without a guard', unguarded instanceof SpendRefusal && unguarded.code === 'guard_required', unguarded?.message);

  const tight = openSpendGuard({ runId: 'run-budget', ledgerPath, budgetUsd: 0.0001, clock: now });
  const tightProvider = createProvider({ kind: 'openai-compatible', registry, model, budget: { usd: 1, spent: 0 }, guard: tight, env, fetchImpl });
  const broke = await refusalAsync(() => tightProvider.complete({ system: 's', user: 'u', maxTokens: 8000 }));
  check('a call that cannot afford the pre-flight is refused before the request', broke instanceof SpendRefusal && broke.code === 'budget_exceeded', broke?.message);
  check('the refusal happened before any fetch', fetched === 0);
  check('the refusal is recorded in the ledger', readSpendLedger(ledgerPath).some((row) => row.event === 'call_refused' && row.run_id === 'run-budget'));

  const funded = openSpendGuard({ runId: 'run-call', ledgerPath, budgetUsd: 0.05, clock: now });
  const provider = createProvider({
    kind: 'openai-compatible',
    registry,
    model,
    budget: { usd: 0.05, spent: 0 },
    guard: funded,
    env,
    purpose: 'scan',
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({
        id: 'gen-test-1',
        model: 'z-ai/glm-5.3-flash',
        provider: 'TestUpstream',
        choices: [{ finish_reason: 'stop', message: { content: '{"findings":[]}' } }],
        usage: { prompt_tokens: 1000, completion_tokens: 100, cost: 0.0001 },
      }),
    }),
  });
  const result = await provider.complete({ system: 's', user: 'u', maxTokens: 100 });
  check('a funded call returns its payload and usage', result.payload?.findings?.length === 0 && result.usage.cost_usd === 0.0001);
  check('the call is recorded in the ledger with its charge', readSpendLedger(ledgerPath).some((row) => row.event === 'call' && row.run_id === 'run-call' && row.cost_usd === 0.0001));
  check('the guard tracks the spend it permitted', funded.spent === 0.0001 && funded.remainingUsd > 0);
  funded.close({ outcome: 'test' });
}

rmSync(dir, { recursive: true, force: true });

console.log(`\nspend guard tests: ${checks - failures}/${checks} checks passed`);
process.exit(failures ? 1 : 0);
