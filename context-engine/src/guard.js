/**
 * Spend guard.
 *
 * The run-1 retry was authorised in prose, in a document, after the fact. Documentation is not
 * enforcement: the harness that retries on truncation is the same harness that was told not to. This
 * module puts the rule where the money is — in the provider boundary — and keeps the evidence in a
 * ledger that outlives the process.
 *
 * The rule it enforces:
 *
 *   One attempt per run id. A second attempt on the same id is refused unless the operator supplies a
 *   retry authorisation that is distinct from the id itself, and the ledger records that authorisation
 *   next to the spend it permitted.
 *
 * Why the ledger and not a counter: an accidental retry is a *new process*. An in-memory attempt
 * counter would be reset by exactly the act it is supposed to prevent. The ledger is append-only and
 * lives next to the run's artifacts, so the refusal survives `Ctrl-C`, a crash, and a fresh shell.
 *
 * What this is not: a budget. Budget arithmetic stays in `budget.js` and the provider. The guard only
 * decides whether this process is allowed to spend at all.
 */

import { existsSync, mkdirSync, appendFileSync, readFileSync } from 'node:fs';
import path from 'node:path';

export const LEDGER_SCHEMA = 'context-engine/spend-ledger/v1';

export class SpendRefusal extends Error {
  constructor(code, message, detail = {}) {
    super(message);
    this.name = 'SpendRefusal';
    this.code = code;
    this.detail = detail;
  }
}

const readLedger = (ledgerPath) => {
  if (!ledgerPath || !existsSync(ledgerPath)) return [];
  return readFileSync(ledgerPath, 'utf8')
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return { event: 'ledger_row_unreadable' };
      }
    });
};

const appendRow = (ledgerPath, row) => {
  if (!ledgerPath) return;
  try {
    mkdirSync(path.dirname(ledgerPath), { recursive: true });
    appendFileSync(ledgerPath, `${JSON.stringify(row)}\n`);
  } catch (error) {
    throw new SpendRefusal('ledger_unwritable', `cannot write the spend ledger at ${ledgerPath}: ${error.message}`, { ledgerPath });
  }
};

export class SpendGuard {
  constructor({ runId, ledgerPath, budgetUsd, attempt, authorizeRetry, priorSpendUsd, clock }) {
    this.runId = runId;
    this.ledgerPath = ledgerPath;
    this.authorizedUsd = budgetUsd;
    this.attempt = attempt;
    this.authorizeRetry = authorizeRetry;
    this.priorSpendUsd = priorSpendUsd;
    this.clock = clock;
    this.spent = 0;
    this.calls = 0;
    this.closed = false;
    this.refusals = 0;
  }

  get remainingUsd() {
    return Math.max(0, this.authorizedUsd - this.spent);
  }

  assertOpen() {
    if (this.closed) throw new SpendRefusal('guard_closed', `run ${this.runId} attempt ${this.attempt} is closed; spending stopped`, { runId: this.runId });
  }

  /** Refuse before the request, not after the charge. */
  assertCanAfford(estimateUsd) {
    this.assertOpen();
    if (Number(estimateUsd) > this.remainingUsd) {
      this.refusals += 1;
      appendRow(this.ledgerPath, {
        schema: LEDGER_SCHEMA,
        event: 'call_refused',
        run_id: this.runId,
        attempt: this.attempt,
        reason: 'budget_exceeded',
        estimate_usd: estimateUsd,
        spent_usd: this.spent,
        authorized_usd: this.authorizedUsd,
        at: this.clock(),
      });
      throw new SpendRefusal(
        'budget_exceeded',
        `budget_exceeded: attempt ${this.attempt} of ${this.runId} has $${this.remainingUsd.toFixed(6)} of $${this.authorizedUsd.toFixed(2)} left; next call ~$${Number(estimateUsd).toFixed(6)}`,
        { runId: this.runId, attempt: this.attempt, estimate_usd: estimateUsd, spent_usd: this.spent, authorized_usd: this.authorizedUsd }
      );
    }
  }

  /** One row per paid call: the audit trail of what the attempt actually cost. */
  recordCall({ costUsd = null, inputTokens = null, outputTokens = null, generationId = null, purpose = null, model = null }) {
    this.calls += 1;
    if (typeof costUsd === 'number') this.spent += costUsd;
    appendRow(this.ledgerPath, {
      schema: LEDGER_SCHEMA,
      event: 'call',
      run_id: this.runId,
      attempt: this.attempt,
      purpose,
      model,
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      cost_usd: costUsd,
      generation_id: generationId,
      at: this.clock(),
    });
  }

  close({ outcome = 'completed' } = {}) {
    if (this.closed) return;
    this.closed = true;
    appendRow(this.ledgerPath, {
      schema: LEDGER_SCHEMA,
      event: 'attempt_closed',
      run_id: this.runId,
      attempt: this.attempt,
      outcome,
      calls: this.calls,
      spent_usd: Number(this.spent.toFixed(12)),
      authorized_usd: this.authorizedUsd,
      at: this.clock(),
    });
  }
}

/**
 * Open one authorised attempt.
 *
 * @param {{runId: string, ledgerPath: string, budgetUsd: number, authorizeRetry?: string|null,
 *          purpose?: string|null, clock?: () => string}} options
 * @returns {SpendGuard}
 */
export function openSpendGuard({ runId, ledgerPath, budgetUsd, authorizeRetry = null, purpose = null, clock = () => new Date().toISOString() }) {
  if (!runId || !String(runId).trim()) {
    throw new SpendRefusal('run_id_required', 'paid execution requires --run-id: one authorised attempt per run id, recorded in a ledger');
  }
  if (!(Number(budgetUsd) > 0)) {
    throw new SpendRefusal('budget_required', 'paid execution requires an explicit budget greater than zero');
  }
  const rows = readLedger(ledgerPath);
  const attempts = rows.filter((row) => row.event === 'attempt_opened' && row.run_id === runId);
  const priorSpend = rows
    .filter((row) => row.run_id === runId && typeof row.cost_usd === 'number')
    .reduce((sum, row) => sum + row.cost_usd, 0);

  if (attempts.length >= 1) {
    if (authorizeRetry === null || authorizeRetry === undefined || authorizeRetry === true || authorizeRetry === '') {
      throw new SpendRefusal(
        'retry_not_authorized',
        `run ${runId} already opened ${attempts.length} attempt(s) and $${priorSpend.toFixed(8)} was spent; a retry requires --authorize-retry <token>, recorded in the ledger`,
        { runId, prior_attempts: attempts.length, prior_spend_usd: priorSpend, ledgerPath }
      );
    }
    // An id cannot authorise its own retry: the authorisation has to be something the operator
    // supplied on purpose, not the value the harness already had.
    if (String(authorizeRetry) === String(runId)) {
      throw new SpendRefusal('retry_token_invalid', 'the retry authorisation must be distinct from the run id', { runId });
    }
  }

  const attempt = attempts.length + 1;
  appendRow(ledgerPath, {
    schema: LEDGER_SCHEMA,
    event: 'attempt_opened',
    run_id: runId,
    attempt,
    purpose,
    authorized_usd: Number(budgetUsd),
    authorize_retry: authorizeRetry && authorizeRetry !== true ? String(authorizeRetry) : null,
    prior_spend_usd: Number(priorSpend.toFixed(12)),
    at: clock(),
  });

  return new SpendGuard({
    runId,
    ledgerPath,
    budgetUsd: Number(budgetUsd),
    attempt,
    authorizeRetry,
    priorSpendUsd: priorSpend,
    clock,
  });
}

/** Read a ledger without opening anything; used by reports and the guard's own tests. */
export function readSpendLedger(ledgerPath) {
  return readLedger(ledgerPath);
}
