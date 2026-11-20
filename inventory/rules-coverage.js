/**
 * Coverage rules — additive inventory rules for the four classes the current inventory
 * systematically misses.
 *
 * These are **additive**. `inventory/scan.js` is untouched, the identity layer is
 * untouched, and the state classifier is untouched. This module is the thing under test
 * in INVENTORY-COVERAGE-01.
 *
 * Four rules, each written from first principles rather than to fit a fixture:
 *
 *   explicit_fact          numbers, dates, times, versions, identifiers, `key: value`
 *   structural_constraint  deletion, exception, scope, condition, prohibition, requirement
 *   relationship           ownership, dependency, governance, supersession
 *   repeated_role          one fact, more than once, in different surroundings
 *
 * Items use the same shape as the existing scan so they can be compared and anchored
 * without translation: { id, kind, label, spans: [{ source_id, span, quote }], detail }.
 */

// Line-aware splitting. A plain /[^.!?]+/ splitter breaks "## 0.9.2" into "## 0.",
// "9.", "2" and "ghcr.io/northwind/billing:1.14.2" at every dot, which manufactured
// dozens of junk fact items and depressed precision for reasons that had nothing to do
// with the rule's judgement. Sentences end at a period followed by whitespace and a
// capital, or at a line break.
const SENTENCE_END = /(?<=[.!?])[ \t]+(?=[A-Z"'\u2014(-])/g;

function sentences(text) {
  const out = [];
  let lineStart = 0;
  for (const line of text.split('\n')) {
    const push = (start, end) => {
      const raw = text.slice(start, end);
      if (!raw.trim()) return;
      const leading = raw.length - raw.trimStart().length;
      out.push({ start: start + leading, end: start + leading + raw.trim().length, text: raw.trim() });
    };
    let cursor = 0;
    const boundaries = [];
    SENTENCE_END.lastIndex = 0;
    let separator;
    while ((separator = SENTENCE_END.exec(line)) !== null) boundaries.push(separator.index + separator[0].length);
    for (const boundary of boundaries) {
      push(lineStart + cursor, lineStart + boundary);
      cursor = boundary;
    }
    push(lineStart + cursor, lineStart + line.length);
    lineStart += line.length + 1;
  }
  return out;
}

/** A value that carries identity: a number, date, time, version, or identifier. */
const VALUE = /(\b\d[\d.,:/%-]*\b|\b[a-z][a-z0-9]*_[a-z0-9_]+\b|\b\d+\.\d+\.\d+\b)/i;

const KEY_VALUE = /^\s*([a-z][a-z0-9_ ]{1,40}):\s*(.+)$/i;

// No trailing \b: alternatives ending in \w ("no\s+\w", "not\s+\w") could never match
// with a boundary after the captured word, which silently dropped every prohibition
// phrased as "is not yet approved" or "no amendment".
const CONSTRAINT = /\b(?:nothing|never|no\s+|not\s+|cannot|can\s+not|must\s+not|do\s+not|only\s+if|unless|except|within|outside\s+this|is\s+required|are\s+required|required\s+(?:and|field)|prohibited|forbidden|blocks?|blocked\s+by|prevents?)/i;

const RELATION = /\b(owner|owned\s+by|assignee|belongs\s+to|supersedes|superseded\s+by|governs|governing|depends\s+on|required\s+by|blocks|blocked\s+by|reports\s+to|maintained\s+by)\b/i;

const RELATION_KEYS = new Set(['owner', 'assignee', 'project', 'service', 'depends_on', 'supersedes', 'governed_by', 'maintained_by']);

function makeItem(kind, label, spans, detail = {}) {
  return {
    id: null,
    kind,
    label,
    spans: spans.map((span) => ({ source_id: span.source_id, span: { start: span.start, end: span.end }, quote: span.quote })),
    detail,
  };
}

function spanOf(sourceId, text, sentence) {
  return { source_id: sourceId, start: sentence.start, end: sentence.end, quote: text.slice(sentence.start, sentence.end) };
}

export function scanCoverageRules(input, { maxPerSource = 400 } = {}) {
  const items = [];
  const counts = { explicit_fact: 0, structural_constraint: 0, relationship: 0, repeated_role: 0 };

  for (const source of input?.sources ?? []) {
    const text = typeof source.content?.text === 'string' ? source.content.text : '';
    if (!text) continue;
    const parts = sentences(text);
    let emitted = 0;

    for (const sentence of parts) {
      if (emitted >= maxPerSource) break;
      const span = spanOf(source.id, text, sentence);

      // Each class is tested independently and may emit its own item for the same
      // sentence. A single-item-per-sentence precedence order would silently swallow
      // constraint clauses that happen to contain an identifier ("tax_id ... required"),
      // which is exactly the class this experiment exists to recover.
      const kv = sentence.text.match(KEY_VALUE);
      const isFact = VALUE.test(sentence.text) || Boolean(kv);
      const isConstraint = CONSTRAINT.test(sentence.text);
      const isRelation = RELATION.test(sentence.text) || Boolean(kv && RELATION_KEYS.has(kv[1].trim().toLowerCase()));

      if (isFact) {
        const label = kv ? `${kv[1].trim()}: ${kv[2].trim().slice(0, 60)}` : sentence.text.slice(0, 90);
        items.push(makeItem('explicit_fact', label, [span], { key: kv ? kv[1].trim().toLowerCase() : null, value: kv ? kv[2].trim().slice(0, 80) : null }));
        counts.explicit_fact += 1;
        emitted += 1;
      }
      if (isConstraint) {
        items.push(makeItem('structural_constraint', sentence.text.slice(0, 90), [span], { marker: sentence.text.match(CONSTRAINT)?.[0] ?? null }));
        counts.structural_constraint += 1;
        emitted += 1;
      }
      if (isRelation) {
        items.push(makeItem('relationship', sentence.text.slice(0, 90), [span], { marker: sentence.text.match(RELATION)?.[0] ?? kv?.[1] }));
        counts.relationship += 1;
        emitted += 1;
      }
    }

    // repeated_role: the same value twice, in different surroundings.
    const values = new Map();
    const valuePattern = /\b(\d[\d.,:/-]{2,}|[a-z][a-z0-9]*_[a-z0-9_]+)\b/gi;
    let valueMatch;
    while ((valueMatch = valuePattern.exec(text)) !== null) {
      const key = valueMatch[1].toLowerCase();
      if (!values.has(key)) values.set(key, []);
      values.get(key).push(valueMatch.index);
    }
    for (const [key, positions] of values) {
      if (positions.length < 2 || emitted >= maxPerSource) continue;
      const windows = positions.map((position) => text.slice(Math.max(0, position - 45), Math.min(text.length, position + 45)));
      if (new Set(windows).size < 2) continue;
      const first = positions[0];
      const last = positions[positions.length - 1];
      items.push(
        makeItem('repeated_role', `repeated_value: ${key}`, [
          { source_id: source.id, start: first, end: first + key.length, quote: text.slice(first, first + key.length) },
          { source_id: source.id, start: last, end: last + key.length, quote: text.slice(last, last + key.length) },
        ], { value: key, occurrences: positions.length })
      );
      counts.repeated_role += 1;
      emitted += 1;
    }
  }

  return { items: items.map((item, index) => ({ ...item, id: `cov_${String(index + 1).padStart(4, '0')}` })), counts };
}
