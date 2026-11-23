/**
 * Partition budget and strategy selection.
 *
 * The claims under test: a 1M window yields a single-pass budget near 782k, an operator ceiling can
 * only lower it, a request above the usable budget is clamped and says so, and a model with no
 * declared context falls back conservatively instead of assuming a large window.
 *
 * Usage: node context-engine/tests/budget.test.js
 */

import { resolvePartitionBudget, chooseStrategy, DEFAULT_PARTITION_POLICY } from '../src/budget.js';

let checks = 0;
let failures = 0;
const check = (name, condition, detail = '') => {
  checks += 1;
  if (!condition) failures += 1;
  console.log(`  ${condition ? 'ok  ' : 'FAIL'} ${name}${condition || !detail ? '' : ` — ${detail}`}`);
};

const GLM_FLASH = { context_tokens: 1048576 };

console.log('1M context, default policy');
{
  const plan = resolvePartitionBudget({ model: GLM_FLASH });
  check('source is the model context', plan.source === 'model_context', plan.source);
  check('budget is capped at the 400k operator ceiling', plan.budget_tokens === 400000, String(plan.budget_tokens));
  check('the model usable window is still computed separately', plan.usable_tokens === 782432, String(plan.usable_tokens));
  check('the ceiling cap is explained', plan.notes.some((note) => note.includes('ceiling')));
}

console.log('operator ceiling');
{
  const plan = resolvePartitionBudget({ model: GLM_FLASH, policy: { hard_ceiling_tokens: 200000 } });
  check('a lower ceiling caps the single pass', plan.budget_tokens === 200000, String(plan.budget_tokens));
  check('the cap is explained', plan.notes.some((note) => note.includes('ceiling')));
}

console.log('explicit request');
{
  const under = resolvePartitionBudget({ model: GLM_FLASH, requestedTokens: 120000 });
  check('a request below the ceiling is honoured', under.budget_tokens === 120000 && under.source === 'requested');
  const over = resolvePartitionBudget({ model: GLM_FLASH, requestedTokens: 2000000 });
  check('a request above the ceiling is clamped', over.budget_tokens === 400000, String(over.budget_tokens));
  check('clamping is reported, not silent', over.source === 'requested_clamped' && over.notes.some((note) => note.includes('clamped')));
  const between = resolvePartitionBudget({ model: GLM_FLASH, requestedTokens: 600000 });
  check('a request between the ceiling and the model window is also clamped', between.budget_tokens === 400000, String(between.budget_tokens));
  const tiny = resolvePartitionBudget({ model: GLM_FLASH, requestedTokens: 10 });
  check('a degenerate request is floored', tiny.budget_tokens === DEFAULT_PARTITION_POLICY.minimum_tokens, String(tiny.budget_tokens));
}

console.log('no declared context');
{
  const plan = resolvePartitionBudget({ model: null });
  check('falls back to the conservative default', plan.budget_tokens === 60000 && plan.source === 'fallback', String(plan.budget_tokens));
  check('does not invent a context length', plan.context_tokens === null);
}

console.log('strategy');
{
  const single = chooseStrategy({ estimatedTokens: 1200, budgetTokens: 400000 });
  check('a subject that fits is single-pass', single.mode === 'single_pass' && single.headroom_tokens > 0);
  const split = chooseStrategy({ estimatedTokens: 900000, budgetTokens: 400000 });
  check('a subject that does not fit is partitioned', split.mode === 'partitioned');
  check('the reason names both numbers', split.reason.includes('900000') && split.reason.includes('400000'));
}

console.log(`\nbudget tests: ${checks - failures}/${checks} checks passed`);
process.exit(failures ? 1 : 0);
