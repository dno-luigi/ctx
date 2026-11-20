/**
 * R-a: a rule-based neutral inventory.
 *
 * This is an independent reference instrument. It takes source material and
 * nothing else: no model output, no decision adapter, no answer key, no accepted
 * snapshot. Every item traces to a span that the frozen resolver can re-derive.
 *
 * What it is not:
 *
 *   - **Not ground truth.** It is a second candidate generator with its own
 *     detection limits, which `inventory/calibration.js` measures against planted
 *     structures. Recall on unlabelled corpora is therefore unknown, and every
 *     report says so.
 *   - **Not cards.** Items are never promoted, scored, merged or ordered into a
 *     snapshot. There is no import path from this module to `snapshot/`.
 *
 * Independence is structural: this file imports only the frozen span resolver and
 * its own corpus module. It cannot see a proposal, an answer or a model id, because
 * none is in scope.
 *
 * Entity detection needs three passes because prose does not cooperate: capitalised
 * names and identifiers are matched lexically, lowercase technical names ("billing
 * service") only become visible as repeated phrases across the corpus, and implicit
 * subjects ("the X depends on the Y") only appear through the relation cue itself.
 */

import { buildCorpus } from './corpus.js';
import { locate } from '../src/spans.js';

export const INVENTORY_SCHEMA = 'gca-inventory/v1';
export const INVENTORY_ORIGIN = 'inventory';

export const INVENTORY_KINDS = [
  'entity',
  'relationship',
  'cross_source_reference',
  'contradiction_candidate',
  'unresolved_proposition',
  'unclaimed_span',
  'missing_connection',
];

const STOPWORDS = new Set([
  'the', 'and', 'that', 'this', 'with', 'from', 'for', 'are', 'was', 'were', 'has', 'have', 'not', 'but',
  'its', 'into', 'than', 'then', 'they', 'their', 'which', 'while', 'when', 'what', 'does', 'did', 'only',
  'also', 'all', 'any', 'can', 'may', 'will', 'would', 'should', 'must', 'been', 'being', 'because', 'about',
  'after', 'before', 'there', 'these', 'those', 'such', 'some', 'more', 'most', 'other', 'per', 'each',
]);

const UNRESOLVED_CUES = /\?|\b(?:tbd|pending|unclear|unknown|undecided|proposed|proposal|draft|may|might|could|possibly|not yet|to be determined|under review)\b/i;
const NORMATIVE_CUES = /\b(?:must|shall|requires?|required|depends?|dependent|blocks?|blocked|because|therefore|unless|only if|in order to|so that)\b/i;
const DEPENDENCY_CUE = /\b(?:depends on|depend on|requires|require|needs|need|blocks|block|replaces|replace)\b/i;

const ENTITY_PATTERNS = [
  { rule: 'version_literal', re: /\b\d+\.\d+(?:\.\d+)?\b/g, group: 0 },
  { rule: 'qualified_identifier', re: /\b[A-Za-z][A-Za-z0-9]*(?:[._/-][A-Za-z0-9]+)+\b/g, group: 0 },
  { rule: 'code_span', re: /`([^`\n]{2,60})`/g, group: 1 },
  { rule: 'proper_noun_phrase', re: /\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,3}\b/g, group: 0 },
  { rule: 'acronym', re: /\b[A-Z]{2,6}\b/g, group: 0 },
];

const DEPENDENCY_PATTERN = /\b([A-Za-z][A-Za-z0-9-]*(?:\s+[A-Za-z][A-Za-z0-9-]*){0,2})\s+(depends on|depend on|requires|require|needs|need|blocks|block|replaces|replace)\s+([A-Za-z][A-Za-z0-9-]*(?:\s+[A-Za-z][A-Za-z0-9-]*){0,2})/gi;

function tokensOf(text) {
  // Dotted identifiers (v3.0) keep their interior separators, but a sentence-final
  // period must not become part of the token: "seconds." and "seconds" have to match.
  return (String(text ?? '').toLowerCase().match(/[a-z0-9][a-z0-9'._-]*/g) ?? [])
    .map((token) => token.replace(/^[._-]+|[._-]+$/g, ''))
    .filter((token) => token.length > 0);
}

function contentTokens(text) {
  return new Set(tokensOf(text).filter((token) => token.length >= 4 && !STOPWORDS.has(token)));
}

function numbersIn(text) {
  return (String(text).match(/\b\d+(?:\.\d+)*\b/g) ?? []).filter((value) => value.length > 4 || !/^\d{4}$/.test(value));
}

function stripArticle(value) {
  const match = String(value).match(/^(?:the|a|an)\s+/i);
  return match ? { lead: match[0].length, value: String(value).slice(match[0].length) } : { lead: 0, value: String(value) };
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function overlaps(a, b) {
  return a.start < b.end && b.start < a.end;
}

function appendEntity(record, entity) {
  if (!entity || entity.start >= entity.end) return;
  if (record.entities.some((existing) => overlaps(existing, entity))) return;
  record.entities.push(entity);
  record.entities.sort((a, b) => a.start - b.start);
}

function lexicalEntities(sentence) {
  const found = [];
  for (const pattern of ENTITY_PATTERNS) {
    pattern.re.lastIndex = 0;
    let match;
    while ((match = pattern.re.exec(sentence.text)) !== null) {
      let value = match[pattern.group];
      if (!value || STOPWORDS.has(value.toLowerCase())) continue;
      let offset = pattern.group === 0 ? match.index : match.index + match[0].indexOf(value);
      if (offset < 0) continue;
      // "The Billing Cache" and "Billing Cache" must be the same entity, or a name
      // stated once with an article never links to its other mention.
      if (pattern.rule === 'proper_noun_phrase') {
        const strip = stripArticle(value);
        value = strip.value;
        offset += strip.lead;
      }
      found.push({
        key: value.toLowerCase(),
        label: value,
        rule: pattern.rule,
        start: sentence.start + offset,
        end: sentence.start + offset + value.length,
      });
    }
  }
  found.sort((a, b) => a.start - b.start || b.end - b.start - (a.end - a.start));
  const kept = [];
  let cursor = -1;
  for (const entity of found) {
    if (entity.start < cursor) continue;
    kept.push(entity);
    cursor = entity.end;
  }
  return kept;
}

/** Bigrams repeated at least twice across the corpus: the only way lowercase names surface. */
function repeatedPhrases(records) {
  const counts = new Map();
  for (const record of records) {
    const tokens = tokensOf(record.text);
    for (let index = 0; index + 1 < tokens.length; index += 1) {
      const [left, right] = [tokens[index], tokens[index + 1]];
      if (STOPWORDS.has(left) || STOPWORDS.has(right)) continue;
      if (left.length < 3 || right.length < 3) continue;
      if (/^\d+$/.test(left) || /^\d+$/.test(right)) continue;
      const key = `${left} ${right}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  return [...counts.entries()].filter(([, count]) => count >= 2).map(([key]) => key);
}

/**
 * @returns {{schema: string, origin: string, reference_instrument: true, ground_truth: false,
 *            corpus: object, items: object[], stats: object}}
 */
export function scanInventory(input, { maxItems = 500, maxSpansPerItem = 8 } = {}) {
  const corpus = buildCorpus(input);
  const records = [];

  for (const document of corpus.documents) {
    for (const sentence of document.sentences) {
      const record = {
        source_id: document.source_id,
        start: sentence.start,
        end: sentence.end,
        text: sentence.text,
        entities: lexicalEntities(sentence),
        dependency_pairs: [],
      };
      records.push(record);
    }
  }

  for (const phrase of repeatedPhrases(records)) {
    const pattern = new RegExp(`\\b${phrase.split(' ').map(escapeRegExp).join('[\\s-]+')}\\b`, 'gi');
    for (const record of records) {
      pattern.lastIndex = 0;
      let match;
      while ((match = pattern.exec(record.text)) !== null) {
        const value = match[0];
        appendEntity(record, {
          key: value.toLowerCase().replace(/\s+/g, ' '),
          label: value,
          rule: 'repeated_phrase',
          start: record.start + match.index,
          end: record.start + match.index + value.length,
        });
      }
    }
  }

  for (const record of records) {
    DEPENDENCY_PATTERN.lastIndex = 0;
    let match;
    while ((match = DEPENDENCY_PATTERN.exec(record.text)) !== null) {
      const leftRaw = match[1];
      const rightRaw = match[3];
      const leftIndex = match.index + match[0].indexOf(leftRaw);
      const rightIndex = match.index + match[0].lastIndexOf(rightRaw);
      const left = stripArticle(leftRaw);
      const right = stripArticle(rightRaw);
      const leftEntity = {
        key: left.value.toLowerCase(),
        label: left.value,
        rule: 'dependency_phrase',
        start: record.start + leftIndex + left.lead,
        end: record.start + leftIndex + left.lead + left.value.length,
      };
      const rightEntity = {
        key: right.value.toLowerCase(),
        label: right.value,
        rule: 'dependency_phrase',
        start: record.start + rightIndex + right.lead,
        end: record.start + rightIndex + right.lead + right.value.length,
      };
      appendEntity(record, leftEntity);
      appendEntity(record, rightEntity);
      record.dependency_pairs.push({ cue: match[2].toLowerCase(), left: leftEntity, right: rightEntity });
    }
  }

  const occurrences = new Map();
  for (const record of records) {
    for (const entity of record.entities) {
      if (!occurrences.has(entity.key)) {
        occurrences.set(entity.key, { key: entity.key, label: entity.label, rules: new Set(), occurrences: [] });
      }
      const entry = occurrences.get(entity.key);
      entry.rules.add(entity.rule);
      entry.occurrences.push({ source_id: record.source_id, start: entity.start, end: entity.end, quote: entity.label });
    }
  }

  const items = [];
  const emit = (item) => {
    items.push({ id: `inv_${String(items.length + 1).padStart(4, '0')}`, origin: INVENTORY_ORIGIN, ...item });
  };
  const span = (sourceId, start, end, quote) => ({ source_id: sourceId, quote, span: { start, end } });

  // Rule 1 — entities.
  for (const entry of [...occurrences.values()].sort((a, b) => a.key.localeCompare(b.key))) {
    const sources = [...new Set(entry.occurrences.map((occurrence) => occurrence.source_id))];
    emit({
      kind: 'entity',
      rule: [...entry.rules].sort()[0],
      label: entry.label,
      spans: entry.occurrences.slice(0, maxSpansPerItem).map((occurrence) => span(occurrence.source_id, occurrence.start, occurrence.end, occurrence.quote)),
      detail: { key: entry.key, occurrences: entry.occurrences.length, sources, rules: [...entry.rules].sort() },
      reason: `matched by ${[...entry.rules].sort().join(', ')} in ${entry.occurrences.length} place(s) across ${sources.length} source(s)`,
    });
  }

  // Rule 2 — relationships the corpus states: an explicit dependency phrase, or two
  // names in one sentence.
  const pairIndex = new Map();
  for (const record of records) {
    for (const pair of record.dependency_pairs) {
      const [a, b] = [pair.left.key, pair.right.key].sort();
      const key = `${record.source_id}|${a}|${b}`;
      if (!pairIndex.has(key)) pairIndex.set(key, { source_id: record.source_id, a, b, records: [], via: 'dependency_phrase' });
      pairIndex.get(key).records.push(record);
      emit({
        kind: 'relationship',
        rule: 'dependency_phrase',
        label: `${pair.left.label} — ${pair.right.label}`,
        spans: [
          span(record.source_id, record.start, record.end, record.text),
          span(record.source_id, pair.left.start, pair.left.end, pair.left.label),
          span(record.source_id, pair.right.start, pair.right.end, pair.right.label),
        ],
        detail: { entities: [a, b], cue: pair.cue, text: record.text.slice(0, 200) },
        reason: `the sentence states "${pair.left.label} ${pair.cue} ${pair.right.label}"`,
      });
    }
    const keys = [...new Set(record.entities.map((entity) => entity.key))];
    for (let i = 0; i < keys.length; i += 1) {
      for (let j = i + 1; j < keys.length; j += 1) {
        const [a, b] = [keys[i], keys[j]].sort();
        const key = `${record.source_id}|${a}|${b}`;
        if (!pairIndex.has(key)) pairIndex.set(key, { source_id: record.source_id, a, b, records: [], via: 'shared_sentence' });
        if (!pairIndex.get(key).records.includes(record)) pairIndex.get(key).records.push(record);
      }
    }
  }
  const coveredSentences = new Set();
  for (const pair of pairIndex.values()) {
    for (const record of pair.records) coveredSentences.add(`${record.source_id}:${record.start}`);
  }
  for (const pair of pairIndex.values()) {
    if (pair.via === 'dependency_phrase') continue;
    const first = pair.records[0];
    const entitySpans = first.entities
      .filter((entity) => entity.key === pair.a || entity.key === pair.b)
      .map((entity) => span(first.source_id, entity.start, entity.end, entity.label));
    emit({
      kind: 'relationship',
      rule: 'shared_sentence',
      label: `${pair.a} — ${pair.b}`,
      spans: [span(first.source_id, first.start, first.end, first.text), ...entitySpans].slice(0, maxSpansPerItem),
      detail: { entities: [pair.a, pair.b], sentences: pair.records.length, text: first.text.slice(0, 200) },
      reason: `both named in one sentence of ${pair.source_id}, in ${pair.records.length} sentence(s)`,
    });
  }

  // Rule 3 — one name, several sources, no stated relation between the treatments.
  for (const entry of [...occurrences.values()].sort((a, b) => a.key.localeCompare(b.key))) {
    const bySource = new Map();
    for (const occurrence of entry.occurrences) {
      if (!bySource.has(occurrence.source_id)) bySource.set(occurrence.source_id, occurrence);
    }
    if (bySource.size < 2) continue;
    emit({
      kind: 'cross_source_reference',
      rule: 'shared_entity_across_sources',
      label: entry.label,
      spans: [...bySource.values()].slice(0, maxSpansPerItem).map((occurrence) => span(occurrence.source_id, occurrence.start, occurrence.end, occurrence.quote)),
      detail: { key: entry.key, sources: [...bySource.keys()] },
      reason: `named in ${bySource.size} sources; no item states how the mentions relate`,
    });
  }

  // Rule 4 — the same subject with different numbers in two sources.
  for (const record of records) {
    const recordTokens = contentTokens(record.text);
    const recordNumbers = numbersIn(record.text);
    if (recordNumbers.length === 0 || recordTokens.size < 2) continue;
    for (const other of records) {
      if (other.source_id === record.source_id) continue;
      const otherNumbers = numbersIn(other.text);
      if (otherNumbers.length === 0) continue;
      const otherTokens = contentTokens(other.text);
      const shared = [...recordTokens].filter((token) => otherTokens.has(token));
      if (shared.length < 2) continue;
      if (shared.length / new Set([...recordTokens, ...otherTokens]).size < 0.5) continue;
      if (recordNumbers.some((value) => otherNumbers.includes(value))) continue;
      emit({
        kind: 'contradiction_candidate',
        rule: 'numeric_attribute_conflict',
        label: `${shared.join('/')}: ${recordNumbers[0]} vs ${otherNumbers[0]}`,
        spans: [span(record.source_id, record.start, record.end, record.text), span(other.source_id, other.start, other.end, other.text)],
        detail: { shared_tokens: shared, left: recordNumbers, right: otherNumbers, text: record.text.slice(0, 200), other_text: other.text.slice(0, 200) },
        reason: `two sources say ${recordNumbers.join(',')} and ${otherNumbers.join(',')} about the same ${shared.length} terms`,
      });
    }
  }

  // Rule 5 — propositions the corpus itself leaves open.
  for (const record of records) {
    if (!UNRESOLVED_CUES.test(record.text)) continue;
    const cue = record.text.match(UNRESOLVED_CUES)?.[0] ?? '?';
    emit({
      kind: 'unresolved_proposition',
      rule: 'unresolved_cue',
      label: record.text.slice(0, 80),
      spans: [span(record.source_id, record.start, record.end, record.text)],
      detail: { cue: cue.trim().toLowerCase(), entities: record.entities.map((entity) => entity.key), text: record.text.slice(0, 200) },
      reason: `contains the unresolved cue "${cue.trim()}"`,
    });
  }

  // Rule 6 — an obligation or dependency sentence that no relationship item covers.
  for (const record of records) {
    if (record.entities.length === 0) continue;
    if (!NORMATIVE_CUES.test(record.text)) continue;
    if (coveredSentences.has(`${record.source_id}:${record.start}`)) continue;
    emit({
      kind: 'unclaimed_span',
      rule: 'normative_without_relation',
      label: record.text.slice(0, 80),
      spans: [span(record.source_id, record.start, record.end, record.text)],
      detail: { entities: record.entities.map((entity) => entity.key), text: record.text.slice(0, 200) },
      reason: 'states an obligation or dependency that no relationship item covers',
    });
  }

  // Rule 7 — two sources discussing the same subject in the same words without ever
  // pairing the named things. Weakest rule here; calibration measures it.
  for (const record of records) {
    const recordTokens = contentTokens(record.text);
    if (recordTokens.size < 2 || record.entities.length === 0) continue;
    for (const other of records) {
      if (other.source_id === record.source_id) continue;
      if (other.entities.length === 0) continue;
      const otherTokens = contentTokens(other.text);
      const shared = [...recordTokens].filter((token) => otherTokens.has(token));
      if (shared.length < 2) continue;
      const leftKeys = [...new Set(record.entities.map((entity) => entity.key))];
      const rightKeys = [...new Set(other.entities.map((entity) => entity.key))];
      const alreadyPaired = [...pairIndex.values()].some(
        (pair) =>
          pair.records.some((r) => r === record) &&
          leftKeys.some((key) => pair.a === key || pair.b === key) &&
          rightKeys.some((key) => pair.a === key || pair.b === key)
      );
      if (alreadyPaired) continue;
      emit({
        kind: 'missing_connection',
        rule: 'shared_context_unpaired',
        label: `${leftKeys[0]} — ${rightKeys[0]} via "${shared[0]}"`,
        spans: [span(record.source_id, record.start, record.end, record.text), span(other.source_id, other.start, other.end, other.text)],
        detail: { entities: [leftKeys[0], rightKeys[0]], shared_tokens: shared, text: record.text.slice(0, 200), other_text: other.text.slice(0, 200) },
        reason: `both discuss ${shared.join(', ')} but no sentence names the two together`,
      });
    }
  }

  const truncated = Math.max(0, items.length - maxItems);
  const kept = items.slice(0, maxItems);
  const byKind = {};
  const byRule = {};
  for (const item of kept) {
    byKind[item.kind] = (byKind[item.kind] ?? 0) + 1;
    byRule[item.rule] = (byRule[item.rule] ?? 0) + 1;
  }

  return {
    schema: INVENTORY_SCHEMA,
    origin: INVENTORY_ORIGIN,
    reference_instrument: true,
    ground_truth: false,
    corpus: corpus.stats,
    items: kept,
    stats: {
      items: kept.length,
      derived: items.length,
      truncated,
      distinct_entities: occurrences.size,
      sentences: records.length,
      by_kind: byKind,
      by_rule: byRule,
      rules: [...new Set(kept.map((item) => item.rule))].sort(),
    },
  };
}

/**
 * Re-derive every span through the frozen resolver. A quote that cannot be found at
 * the stated span is a defect in the instrument, not in the source.
 */
export function verifySpans(input, items) {
  const report = { spans: 0, resolved: 0, unverifiable: 0, failures: [] };
  for (const item of items) {
    for (const ref of item.spans ?? []) {
      report.spans += 1;
      const found = locate(input, ref);
      if (!found.ok) {
        report.failures.push({ item: item.id, source_id: ref.source_id, reason: found.reason });
        continue;
      }
      if (!found.verifiable) {
        report.unverifiable += 1;
        continue;
      }
      if (found.span.start !== ref.span.start || found.span.end !== ref.span.end) {
        report.failures.push({ item: item.id, source_id: ref.source_id, reason: 'span_moved' });
        continue;
      }
      report.resolved += 1;
    }
  }
  return { ...report, exact: report.failures.length === 0 };
}
