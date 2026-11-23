// readFile is mentioned here only in a comment: a comment is not a reference.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { locate } from './missing-module.js';

export { digest } from '../../../src/canonical.js';

// readFile is imported and never called. Import is not use.
const directory = join('a', 'b');
const message = 'readFile is mentioned in a string, which is also not a reference';
console.log(directory, message);
