/**
 * Question answering over a compacted pack, and scoring against controlled ground truth.
 *
 * Two modes, deliberately separate:
 *   retrieval  deterministic selection from pack items. Costs nothing. It measures whether the pack
 *              *contains* what a question needs, not whether a model can reason over it.
 *   model      a separate model call whose prompt contains only the pack. The answer is scored the
 *              same way, and its citations are checked against the pack's source index.
 *
 * Neither mode may consult the source tree. That is the point: the pack has to carry the retrieval.
 */

const STOPWORDS = new Set(['the', 'and', 'what', 'when', 'where', 'which', 'does', 'did', 'how', 'why', 'is', 'are', 'was', 'were', 'a', 'an', 'of', 'to', 'in', 'on', 'for', 'before', 'after', 'with', 'that', 'this', 'it', 'its', 'be', 'can', 'run', 'runs']);

export function packText(pack) {
  return Object.values(pack.sections ?? {}).flat().map((entry) => entry.text).join('\n');
}

const terms = (text) => [...new Set(String(text).toLowerCase().match(/[a-z0-9_.-]{3,}/g) ?? [])].filter((term) => !STOPWORDS.has(term));

/**
 * Citations come back as `path`, `path:line`, `./path` or a fenced path. Normalise the formatting so a
 * correct citation is not scored as an unknown source — but never invent a path that is not in the pack.
 */
export function normalizeCitation(raw) {
  return String(raw ?? '')
    .trim()
    .replace(/^`+|`+$/g, '')
    .replace(/^\.\//, '')
    .replace(/:\d+(?:\s*[-–]\s*\d+)?$/, '')
    .replace(/^\/+/, '')
    .trim();
}

export function retrievalAnswers({ pack, questions }) {
  const entries = Object.entries(pack.sections ?? {}).flatMap(([section, items]) => items.map((entry) => ({ ...entry, section })));
  return questions.map((question) => {
    const query = terms(question.question);
    const scored = entries
      .map((entry) => ({ entry, score: query.filter((term) => entry.text.toLowerCase().includes(term)).length }))
      .filter((row) => row.score > 0)
      .sort((a, b) => b.score - a.score || String(a.entry.id).localeCompare(String(b.entry.id)))
      .slice(0, 4);
    return {
      question_id: question.id,
      answer: scored.map((row) => row.entry.text).join(' ') || 'not_in_pack',
      sources: [...new Set(scored.flatMap((row) => (row.entry.sources ?? []).map((ref) => ref.path)))],
      matched_items: scored.map((row) => row.entry.id),
    };
  });
}

/** The exact prompt a model sees. Exported so the token estimate can be calibrated against it. */
export function buildQaPrompt({ pack, questions }) {
  const packBody = Object.entries(pack.sections ?? {})
    .map(([section, items]) => `## ${section}\n` + items.map((entry) => `- ${entry.text}\n  sources: ${(entry.sources ?? []).map((ref) => `${ref.path}${ref.line ? `:${ref.line}` : ''}`).join(', ') || 'none'}`).join('\n'))
    .join('\n\n');
  const system = [
    'You answer questions using only the supplied context pack.',
    'If the pack does not contain the answer, return exactly "not_in_pack" and cite nothing.',
    'Never use outside knowledge. Never guess a number that is not in the pack.',
    'Cite the source paths of the items you used.',
    'Return JSON only: {"answers":[{"question_id":"…","answer":"…","sources":["path"]}]}',
  ].join('\n');
  const user = `CONTEXT PACK\n${packBody}\n\nQUESTIONS\n${JSON.stringify(questions.map(({ id, question }) => ({ question_id: id, question })), null, 2)}`;
  return { system, user };
}

export async function modelAnswers({ provider, pack, questions, maxTokens = 1400 }) {
  const { system, user } = buildQaPrompt({ pack, questions });
  const result = await provider.complete({ system, user, maxTokens, meta: {} });
  const answers = Array.isArray(result.payload?.answers) ? result.payload.answers : [];
  return {
    answers: questions.map((question) => {
      const found = answers.find((entry) => entry.question_id === question.id);
      const sources = Array.isArray(found?.sources)
        ? [...new Set(found.sources.filter((entry) => typeof entry === 'string').map(normalizeCitation).filter(Boolean))]
        : [];
      return {
        question_id: question.id,
        answer: typeof found?.answer === 'string' ? found.answer : 'not_in_pack',
        sources,
      };
    }),
    usage: result.usage,
    provider: result.provider,
    latency_ms: result.latency_ms,
    problems: result.problems ?? [],
  };
}

export function scoreAnswers({ answers, groundTruth }) {
  const packCitations = new Set();
  const perQuestion = groundTruth.questions.map((question) => {
    const answer = answers.find((entry) => entry.question_id === question.id);
    const text = String(answer?.answer ?? '').toLowerCase();
    const phrasesFound = question.answer_phrases.filter((phrase) => text.includes(String(phrase).toLowerCase()));
    const sources = new Set((answer?.sources ?? []).map(normalizeCitation).filter(Boolean));
    for (const source of sources) packCitations.add(source);
    const retained = phrasesFound.length === question.answer_phrases.length;
    const attributed = question.sources.every((source) => sources.has(source));
    return {
      question_id: question.id,
      retained,
      attributed,
      reconstructed: retained && attributed,
      phrases_found: phrasesFound,
      phrases_expected: question.answer_phrases,
      missing_sources: question.sources.filter((source) => !sources.has(source)),
    };
  });
  const traps = groundTruth.traps ?? [];
  const factualErrors = answers.filter((answer) => traps.some((trap) => String(answer.answer).toLowerCase().includes(String(trap).toLowerCase())));
  const mean = (values) => values.length ? values.filter(Boolean).length / values.length : null;
  return {
    questions: perQuestion.length,
    retention: mean(perQuestion.map((entry) => entry.retained)),
    attribution: mean(perQuestion.map((entry) => entry.attributed)),
    reconstruction: mean(perQuestion.map((entry) => entry.reconstructed)),
    factual_errors: factualErrors.length,
    factual_error_details: factualErrors.map((entry) => ({ question_id: entry.question_id, answer: entry.answer })),
    cited_sources_total: packCitations.size,
    per_question: perQuestion,
  };
}

/** Facts a line-rule scanner is not expected to find are reported separately, never dropped. */
export function scoreFacts({ findings, facts, label }) {
  const text = findings.map((finding) => `${finding.text} ${(finding.evidence ?? []).map((entry) => entry.quote).join(' ')}`).join('\n').toLowerCase();
  const results = facts.map((fact) => ({
    id: fact.id,
    found: fact.phrases.every((phrase) => text.includes(String(phrase).toLowerCase())),
    phrases: fact.phrases,
    sources: fact.sources,
  }));
  return { label, total: results.length, found: results.filter((entry) => entry.found).length, results };
}
