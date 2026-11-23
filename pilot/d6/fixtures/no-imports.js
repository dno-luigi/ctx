/**
 * A file with no imports at all. Extraction over this file must answer `no_edges` — it ran and found
 * nothing — which is a different answer from `edges_unknown`.
 */
export function double(value) {
  return value * 2;
}

export const LABEL = 'no-dependencies';
