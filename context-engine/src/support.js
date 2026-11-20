/**
 * Support checking.
 *
 * `citation_verified` answers one question: does the quoted text exist in the named file? It does not
 * answer the question a consumer actually cares about — does that quote support the sentence next to
 * it? A finding can quote a real line and still be wrong about it.
 *
 * This module adds mechanical, deterministic checks that need no second model and cannot be talked
 * out of their answer:
 *
 *   number_not_in_quote        the claim cites a figure its quote does not contain
 *   identifier_not_in_quote    the claim names a file, path or code identifier its quote does not
 *   negation_not_in_quote      the claim negates ("never", "not", "without") and the quote does not
 *   negation_only_in_quote     the quote negates and the claim states it positively
 *
 * These are checks, not adjudication. A supported finding can still be wrong, and a flagged one can
 * still be right — the claim may legitimately combine several quotes, or rephrase a number as a word.
 * The flags are therefore reported as a metric. They do not yet remove a finding from
 * `verified_conclusions`: changing that rule would silently restate results that are already
 * published. See POC-RESULT.md §5.
 */

export const SUPPORT = {
  supported: 'supported',
  unsupported: 'unsupported',
  noEvidence: 'no_evidence',
};

// Strict boundaries on both sides: "ADR-001" and "30-day" are identifiers, not quantities, and
// treating their digits as figures to look for produced false flags on correct findings.
const NUMBERS = /(?<![A-Za-z0-9_.-])\d+(?:\.\d+)?(?![A-Za-z0-9_.-])/g;
const PATHS = /\b[\w./-]+\.(?:js|mjs|cjs|ts|tsx|json|md|ya?ml|toml)\b/g;
// SHOUTY_SNAKE only: it is a code constant, not prose. Bare words and camelCase are deliberately not
// checked, because flagging ordinary vocabulary would make the metric unusable.
const CONSTANTS = /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g;
// Decision verbs (“rejected”, “dropped”) are not negations: "chose a fixed window over a sliding
// TTL" legitimately restates "rejected a sliding TTL".
const NEGATION = /\b(?:not|never|no|none|cannot|can't|without|disabled)\b/i;

const unique = (values) => [...new Set(values)];

const numbersIn = (text) => unique(String(text).match(NUMBERS) ?? []);

const identifiersIn = (text) => {
  const source = String(text);
  const backticked = [...source.matchAll(/`([^`]{2,80})`/g)].map((match) => match[1].trim());
  const paths = [...source.matchAll(PATHS)].map((match) => match[0]);
  const constants = [...source.matchAll(CONSTANTS)].map((match) => match[0]);
  return unique([...backticked, ...paths, ...constants].filter((token) => token.length > 1));
};

/**
 * @param {{text?: string, evidence?: Array<{quote?: string}>}} finding
 * @returns {{status: string, flags: Array<{code: string, token?: string}>, checked: object}}
 */
export function checkSupport({ text = '', evidence = [] } = {}) {
  const quotes = (Array.isArray(evidence) ? evidence : [])
    .map((entry) => (typeof entry?.quote === 'string' ? entry.quote : ''))
    .filter(Boolean);
  if (!quotes.length) return { status: SUPPORT.noEvidence, flags: [{ code: 'no_evidence' }], checked: { numbers: 0, identifiers: 0 } };

  const quoteText = quotes.join('\n');
  const flags = [];

  const numbers = numbersIn(text);
  for (const token of numbers) {
    if (!quoteText.includes(token)) flags.push({ code: 'number_not_in_quote', token });
  }

  // A path is cited by `source_id`, not necessarily repeated inside the quote: "config/defaults.json"
  // is naming the evidence, and demanding it appear in the quoted line would flag every correct
  // finding that cites a file by name.
  const sourceIds = (Array.isArray(evidence) ? evidence : []).map((entry) => entry?.source_id).filter((value) => typeof value === 'string');
  const namedSource = (token) => sourceIds.some((sourceId) => sourceId === token || sourceId.endsWith(token) || token.endsWith(sourceId));
  const identifiers = identifiersIn(text);
  for (const token of identifiers) {
    if (quoteText.includes(token) || namedSource(token)) continue;
    flags.push({ code: 'identifier_not_in_quote', token });
  }

  const claimNegates = NEGATION.test(String(text));
  const quoteNegates = NEGATION.test(quoteText);
  if (claimNegates && !quoteNegates) flags.push({ code: 'negation_not_in_quote' });
  if (!claimNegates && quoteNegates) flags.push({ code: 'negation_only_in_quote' });

  return {
    status: flags.length ? SUPPORT.unsupported : SUPPORT.supported,
    flags,
    checked: { numbers: numbers.length, identifiers: identifiers.length },
  };
}

/** Aggregate a set of findings into counts by flag, with a few examples each. */
export function summariseSupport({ findings, label, examplesPerFlag = 4 }) {
  const evaluated = findings.map((finding) => {
    const result = checkSupport({ text: finding.text, evidence: finding.evidence });
    return {
      text: finding.text,
      kind: finding.kind ?? null,
      verification: finding.verification ?? null,
      status: result.status,
      flags: result.flags,
    };
  });
  const flagCounts = {};
  for (const entry of evaluated) {
    for (const flag of entry.flags) flagCounts[flag.code] = (flagCounts[flag.code] ?? 0) + 1;
  }
  const examples = {};
  for (const code of Object.keys(flagCounts)) {
    examples[code] = evaluated.filter((entry) => entry.flags.some((flag) => flag.code === code)).slice(0, examplesPerFlag);
  }
  const supported = evaluated.filter((entry) => entry.status === SUPPORT.supported).length;
  const unsupported = evaluated.filter((entry) => entry.status === SUPPORT.unsupported).length;
  const noEvidence = evaluated.filter((entry) => entry.status === SUPPORT.noEvidence).length;
  return {
    label,
    total: evaluated.length,
    supported,
    unsupported,
    no_evidence: noEvidence,
    supported_rate: evaluated.length ? Number((supported / evaluated.length).toFixed(4)) : null,
    flag_counts: flagCounts,
    examples,
    findings: evaluated,
  };
}
