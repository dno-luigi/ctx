import { readFile } from 'node:fs/promises';

// The extractor declares .js/.mjs only. This file is a coverage gap, not an absence of relationships.
export const reader: typeof readFile = readFile;
