import { readFile } from 'node:fs/promises';

// Outside the extractor's declared languages: a coverage gap, not an absence of relationships.
export const reader: typeof readFile = readFile;
