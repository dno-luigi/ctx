import { join as pathJoin } from 'node:path';

// Aliased import: identity carries `join`, evidence carries `pathJoin`.
export const full = pathJoin('a', 'b');
