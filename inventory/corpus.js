/**
 * Corpus preparation for the inventory, and nothing else.
 *
 * Offsets are absolute UTF-16 code units into the source text — the same units
 * `src/spans.js` uses — so every span the inventory emits can be handed straight to
 * the frozen resolver without conversion.
 */

function sentencesOfLine(text, start, end) {
  const out = [];
  let segmentStart = start;
  const boundary = /[.!?](?=\s|$)/g;
  boundary.lastIndex = start;
  let match;
  while ((match = boundary.exec(text)) !== null && match.index < end) {
    out.push({ start: segmentStart, end: match.index + 1, text: text.slice(segmentStart, match.index + 1) });
    segmentStart = match.index + 1;
    while (segmentStart < end && /\s/.test(text[segmentStart])) segmentStart += 1;
    boundary.lastIndex = segmentStart;
  }
  if (segmentStart < end) out.push({ start: segmentStart, end, text: text.slice(segmentStart, end) });
  return out.filter((sentence) => sentence.text.trim().length > 0);
}

/** Sentence spans for the whole text, split on line breaks and end punctuation. */
export function sentencesOf(text) {
  const sentences = [];
  let lineStart = 0;
  for (let index = 0; index <= text.length; index += 1) {
    if (index === text.length || text[index] === '\n') {
      if (index > lineStart) sentences.push(...sentencesOfLine(text, lineStart, index));
      lineStart = index + 1;
    }
  }
  return sentences;
}

/**
 * @returns {{documents: Array<{source_id, kind, label, text, sentences}>, stats: object}}
 */
export function buildCorpus(input) {
  const documents = (input?.sources ?? []).map((source) => {
    const text = typeof source?.content?.text === 'string' ? source.content.text : '';
    return {
      source_id: source.id,
      kind: source.kind ?? 'document',
      label: source.label ?? source.id,
      text,
      sentences: sentencesOf(text),
    };
  });
  return {
    documents,
    stats: {
      sources: documents.length,
      text_sources: documents.filter((document) => document.text.length > 0).length,
      characters: documents.reduce((total, document) => total + document.text.length, 0),
      sentences: documents.reduce((total, document) => total + document.sentences.length, 0),
    },
  };
}

export function findDocument(corpus, sourceId) {
  return corpus.documents.find((document) => document.source_id === sourceId) ?? null;
}
