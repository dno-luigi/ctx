/**
 * Compaction: contradictions are carried, whole, with their sources; when they cannot fit they are listed
 * as omissions with those same references, never silently dropped.
 *
 * Usage: node context-engine/tests/compaction.test.js
 */

import { compact, renderPack } from '../src/compact.js';

let checks = 0;
let failures = 0;
const check = (name, condition, detail = '') => {
  checks += 1;
  if (!condition) failures += 1;
  console.log(`  ${condition ? 'ok  ' : 'FAIL'} ${name}${condition || !detail ? '' : ` — ${detail}`}`);
};

const evidence = [
  { source_id: 'docs/ARCHITECTURE.md', quote: 'The ingest timeout is 30 seconds in production, set by the platform team.', line: 14, sha256: 'sha256:a' },
  { source_id: 'config/defaults.json', quote: '"timeout_seconds": 5', line: 3, sha256: 'sha256:b' },
];

const snapshot = {
  snapshot_id: 'snap-test',
  subject: { root: 'fixture', source_digest: 'sha256:source' },
  coverage: { citation_coverage: 1, sources_cited: 2, sources_total: 2 },
  sections: {
    verified_conclusions: [{ kind: 'invariant', text: 'The service MUST never delete an unexpired object.', evidence: [evidence[0]] }],
    observations: [],
    inferences: [],
    questions: [],
    current_state: { state: [], outstanding: [], risks: [] },
  },
  architecture: { components: [], dependencies: [], relationships: [] },
  contradictions: [{
    text: 'The ingest timeout is stated as 30 seconds, but config/defaults.json sets timeout_seconds to 5.',
    between: ['docs/ARCHITECTURE.md', 'config/defaults.json'],
    verification: 'citation_verified',
    evidence,
  }],
};

console.log('contradictions carried');
{
  const pack = compact({ snapshot, profile: 'medium' });
  const entry = pack.sections.contradictions?.[0];
  check('a contradiction is a pack section', Boolean(entry));
  check('it is labelled unresolved, not presented as settled', entry?.caveat === 'unresolved');
  check('both source references survive', entry?.sources.length === 2, String(entry?.sources.length));
  check('both paths are present', new Set(entry?.sources.map((ref) => ref.path)).size === 2);
  check('the source index includes the contradiction evidence', pack.source_index.some((ref) => ref.path === 'config/defaults.json'));
  check('the contradiction text is not rewritten', entry?.text === snapshot.contradictions[0].text);
  check('rendered pack shows the contradiction', renderPack(pack).includes('config/defaults.json'));
  check('pack remains reconstructible', pack.reconstructible === true);
}

console.log('omission accounting');
{
  const pack = compact({ snapshot, profile: 'small', maxTokens: 120 });
  const contradictionOmitted = pack.omissions.some((entry) => entry.section === 'contradictions');
  const included = pack.sections.contradictions?.length ?? 0;
  check('an unaffordable contradiction is either included or listed', included + Number(contradictionOmitted) >= 1);
  if (contradictionOmitted) {
    const omission = pack.omissions.find((entry) => entry.section === 'contradictions');
    check('the omission keeps its source references', omission.sources.length === 2, String(omission.sources?.length));
  } else {
    check('the included contradiction stays within budget', pack.used_tokens_estimate <= pack.budget_tokens_estimate);
  }
  check('coverage reports totals regardless of inclusion', pack.coverage.items_total >= pack.coverage.items_included);
}

console.log(`\ncompaction tests: ${checks - failures}/${checks} checks passed`);
process.exit(failures ? 1 : 0);
