/**
 * The decision path does not get its own definition of a valid snapshot.
 *
 * It runs the frozen ones: canonicalise spans from the quote, then the five
 * invariants. If the decision path ever needs a different validator, that is a
 * protocol change and must go through change control — not a quiet fork here.
 */

import { canonicalizeSnapshot } from '../src/spans.js';
import { validateSnapshot as validateFrozen } from '../src/validate.js';

export { validateFrozen };

/** Canonicalise then validate; returns the snapshot that would be graded. */
export function validateAssembled({ input, snapshot }) {
  const { snapshot: canonical, stats } = canonicalizeSnapshot(input, snapshot);
  const validation = validateFrozen(input, canonical);
  return {
    ok: validation.ok,
    errors: validation.errors,
    snapshot: canonical,
    stats: { ...validation.stats, canonicalisation: stats },
  };
}
