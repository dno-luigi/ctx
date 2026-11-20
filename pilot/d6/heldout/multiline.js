import {
  readFile,
  writeFile,
} from 'node:fs/promises';

// A line-start parser sees no import here and reports no_edges: an extraction failure reported as an
// absence of relationships.
export const readers = [readFile, writeFile];
