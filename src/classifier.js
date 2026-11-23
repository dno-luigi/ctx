/**
 * Claim classification for the decision instruments.
 *
 * Evaluation order is an invariant, not an implementation detail:
 *   1. Resolve the key. Absent -> not_in_state / key_absent. Support evaluation is not run.
 *   2. Evaluate support -> asserts | contradicts | silent.
 *   3. Assign coverage, reason code and S-target.
 *
 * Support is claim-relative and three-valued. For `is_current` claims, a competing value defeats the
 * claim only when the state carries an explicit edge naming the subject, the relation and a
 * successor. Two current values with no edge are silent (competition_unresolved), never defeated:
 * calling that `contradicts` would award a determinate target on a question the state cannot settle.
 *
 * Key and value matching is token-bounded: `retention_days` does not match `archive_retention_days`,
 * and the value 5 does not match 50. Substring matching would invent competitors and false matches.
 *
 * Semantic restoration: a value stated in another unit is the same value. The unit table is data, so
 * a state saying "every 30 seconds" does assert an interval of 30000 ms. Without this, evidence_loss
 * would be an artifact of formatting rather than a real ablation.
 *
 * This module classifies. It does not score model output and it does not establish truth: a state
 * that asserts a false claim is `answerable` for that claim.
 */

export const SUPPORT = Object.freeze({
  ASSERTS: 'asserts',
  CONTRADICTS: 'contradicts',
  SILENT: 'silent',
  ABSENT: 'absent',
});

export const COVERAGE = Object.freeze({
  ANSWERABLE: 'answerable',
  INSUFFICIENT: 'insufficient_evidence',
  NOT_IN_STATE: 'not_in_state',
});

export const REASON = Object.freeze({
  ESTABLISHES: 'establishes_claim',
  DEFEATS: 'defeats_predicate',
  // A competing value refutes an `asserts` claim, but no predicate was defeated. Keeping the two
  // apart stops the audit trail from claiming a supersession that never occurred.
  REFUTED: 'refuted_by_competing_value',
  EVIDENCE_LOST: 'evidence_lost',
  COMPETITION: 'competition_unresolved',
  PREDICATE: 'predicate_undeterminable',
  KEY_ABSENT: 'key_absent',
});

export const DEFAULT_UNITS = Object.freeze([
  { base: 'ms', scale: 1, aliases: ['ms', 'millisecond', 'milliseconds'] },
  { base: 'ms', scale: 1000, aliases: ['s', 'sec', 'secs', 'second', 'seconds'] },
]);

/**
 * Pre-registered degeneracy guard. Zero asserted coverage must be flagged however it arises, not only
 * when refutations are present: a state that refutes nothing and asserts nothing is 0% coverage, and
 * an aggregate that only fires on `defeated > 0` would let it pass.
 */
export function coverageGuard({ asserted = 0, defeated = 0, unresolved = 0, absent = 0 } = {}) {
  if (asserted > 0) return null;
  if (defeated > 0) return 'refutation_only';
  if (unresolved > 0) return 'unresolved_only';
  if (absent > 0) return 'absent_only';
  return null;
}

const DEFEAT = [/superseded by/, /supersedes/, /replaced by/, /deprecated in favou?r of/, /no longer current/];
const NON_COMMITTAL = [/proposed/, /under review/, /no decision/, /\bdraft\b/, /\btbd\b/];
const SUCCESSOR = /(adr-\d+|[a-z0-9_./-]+\.(?:md|json|js))/;
// `001` in `ADR-001` is part of an identifier, not a quantity.
const QUANTITY = /(?<![\w-])(\d+(?:\.\d+)?)\s*([a-z]+)?/gi;

const toText = (value) => (Array.isArray(value) ? value.join('\n') : String(value ?? ''));
const norm = (value) => String(value ?? '').toLowerCase();
const toLines = (value) => toText(value).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
const escapeToken = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Whole-token match: neither adjacent character may be a word character or underscore. */
export function containsToken(text, token) {
  const needle = String(token ?? '');
  if (!needle) return false;
  return new RegExp(`(?<![A-Za-z0-9_])${escapeToken(needle)}(?![A-Za-z0-9_])`, 'i').test(String(text ?? ''));
}

const hasKey = (line, key) => containsToken(line, key);

/** Quantities in one line, converted to their unit's base. Bare numbers keep `unit: null`. */
export function quantitiesIn(line, units = DEFAULT_UNITS) {
  const found = [];
  QUANTITY.lastIndex = 0;
  let match = QUANTITY.exec(line);
  while (match) {
    const raw = Number(match[1]);
    const unit = units.find((entry) => entry.aliases.includes(norm(match[2])));
    found.push({
      raw,
      unit: unit ? unit.base : null,
      value: unit ? raw * unit.scale : raw,
      converted: Boolean(unit),
    });
    match = QUANTITY.exec(line);
  }
  return found;
}

const matches = (item, quantity) =>
  item.unit
    ? quantity.unit === item.unit && Math.abs(quantity.value - item.value) < 1e-9
    : quantity.unit === null && Math.abs(quantity.raw - item.value) < 1e-9;

const decision = (support, coverage, reason, target, evidence = {}) => ({ support, coverage, reason, target, evidence });

/**
 * @param {{state: string|string[], item: object, units?: object[]}} input
 * @returns {{support: string, coverage: string, reason: string, target: 0|1, evidence: object}}
 */
export function classify({ state, item, units = DEFAULT_UNITS }) {
  const keyLines = toLines(state).filter((line) => hasKey(line, item.key));
  if (!keyLines.length) {
    return decision(SUPPORT.ABSENT, COVERAGE.NOT_IN_STATE, REASON.KEY_ABSENT, 0, { key_present: false });
  }
  return typeof item.value === 'number' ? numeric({ keyLines, item, units }) : nominal({ keyLines, item });
}

function numeric({ keyLines, item, units }) {
  const quantities = keyLines.flatMap((line) => quantitiesIn(line, units).map((quantity) => ({ ...quantity, line })));
  const matching = quantities.filter((quantity) => matches(item, quantity));
  const competitors = [...new Set(quantities.map((quantity) => `${quantity.unit ?? 'raw'}:${quantity.value}`))];

  // Supersession refutes currency, not the assertion that a pair was recorded. An `asserts` claim
  // about a superseded value is still an assertion; only an `is_current` claim is defeated by it.
  const currency = item.predicate === 'is_current';
  const defeatedBy = !currency ? undefined : keyLines.find((line) => {
    const lowered = norm(line);
    if (!DEFEAT.some((pattern) => pattern.test(lowered))) return false;
    if (!SUCCESSOR.test(lowered)) return false;
    return quantitiesIn(line, units).some((quantity) => matches(item, quantity));
  });
  if (defeatedBy) {
    const lowered = norm(defeatedBy);
    return decision(SUPPORT.CONTRADICTS, COVERAGE.ANSWERABLE, REASON.DEFEATS, 0, {
      span: defeatedBy,
      relation: DEFEAT.map((pattern) => pattern.exec(lowered)?.[0]).find(Boolean) ?? null,
      successor: SUCCESSOR.exec(lowered)?.[0] ?? null,
    });
  }

  if (!matching.length) {
    // For an `asserts` claim, another value for the same key refutes the pair claim outright. For an
    // `is_current` claim it merely leaves the currency unresolved.
    if (competitors.length) {
      return currency
        ? decision(SUPPORT.SILENT, COVERAGE.INSUFFICIENT, REASON.COMPETITION, 0, { competitors })
        : decision(SUPPORT.CONTRADICTS, COVERAGE.ANSWERABLE, REASON.REFUTED, 0, { competitors });
    }
    return decision(SUPPORT.SILENT, COVERAGE.INSUFFICIENT, REASON.EVIDENCE_LOST, 0, { key_present: true, values: 0 });
  }

  if (currency && competitors.length >= 2) {
    return decision(SUPPORT.SILENT, COVERAGE.INSUFFICIENT, REASON.COMPETITION, 0, { competitors });
  }

  if (matching.some((quantity) => NON_COMMITTAL.some((pattern) => pattern.test(norm(quantity.line))))) {
    return decision(SUPPORT.SILENT, COVERAGE.INSUFFICIENT, REASON.PREDICATE, 0, { span: matching[0].line });
  }

  const hit = matching[0];
  return decision(SUPPORT.ASSERTS, COVERAGE.ANSWERABLE, REASON.ESTABLISHES, 1, {
    span: hit.line,
    matched: hit.raw,
    unit: hit.unit,
    converted: hit.converted,
  });
}

function nominal({ keyLines, item }) {
  const hit = keyLines.find((line) => containsToken(line, item.value));
  if (hit) return decision(SUPPORT.ASSERTS, COVERAGE.ANSWERABLE, REASON.ESTABLISHES, 1, { span: hit });
  return decision(SUPPORT.SILENT, COVERAGE.INSUFFICIENT, REASON.EVIDENCE_LOST, 0, { key_present: true });
}
