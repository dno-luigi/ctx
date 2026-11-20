import { join } from 'node:path';

// The only `join` here is the parameter. A lexical occurrence count would report a reference to the
// import, which does not exist in this file.
export function resolveName(join) {
  return join('a', 'b');
}
