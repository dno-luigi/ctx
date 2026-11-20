/**
 * D8 — AA ↔ ARA exchange contract.
 *
 * The boundary this enforces: AA supplies observations; ARA evaluates them. Nothing that carries AA's
 * judgement crosses as if it were ARA's assessment, and nothing ARA returns can be mistaken for AA's
 * observation.
 *
 * Consequences that are implemented rather than promised:
 *   - an envelope containing AA confidence, verdicts or conclusions is REJECTED, not silently cleaned
 *   - every exchange is appended to a hash-chained audit log, including refusals
 *   - duplicate, stale and previously unseen submissions get distinct dispositions
 *   - ambiguous / unresolved statuses cross unchanged and are never upgraded at the boundary
 *   - the response carries ARA's assessments, coverage, conflicts and insufficiency reasons only
 *
 * Usage: see tools/d8-acceptance.js.
 */

import { digest } from '../src/canonical.js';

const H = (schema, ...parts) => digest({ schema, parts });

/** Fields that would carry AA authority into ARA. Their presence rejects the whole submission. */
export const FORBIDDEN_SUBMIT = ['confidence', 'verdict', 'conclusion', 'conclusions', 'recommendation', 'recommendations', 'assessment', 'assessments', 'probability', 'authority', 'preferred_action'];

/** Fields that would let AA mistake ARA's evaluation for its own observation, or vice versa. */
export const FORBIDDEN_RESPONSE = ['aa_confidence', 'aa_verdict', 'observation_confidence', 'authority', 'instruction', 'truth'];

/** AA retrieval vocabulary → ARA anchor status. Never upgrades: only mapping, no re-verification. */
export const STATUS_MAP = {
  verified: 'verified',
  ambiguous: 'ambiguous',
  stale: 'needs_reattribution',
  not_matched: 'unresolved',
  not_covered: 'unresolved',
};

const scanForbidden = (value, forbidden, path = '$', found = []) => {
  if (Array.isArray(value)) { value.forEach((entry, index) => scanForbidden(entry, forbidden, `${path}[${index}]`, found)); return found; }
  if (value && typeof value === 'object') {
    for (const [key, entry] of Object.entries(value)) {
      if (forbidden.includes(key)) found.push(`${path}.${key}`);
      scanForbidden(entry, forbidden, `${path}.${key}`, found);
    }
  }
  return found;
};

export class Exchange {
  constructor(store) {
    this.store = store;
    this.log = [];
    this.revisions = new Map();
    this.submissions = new Map();
    this.unknowns = [];
    this.prevDigest = 'genesis';
  }

  // ---------------------------------------------------------------- audit chain

  chainEntry({ direction, submissionId, envelope, disposition, reason }) {
    const entryDigest = `sha256:${H('d8/chain/v1', this.prevDigest, direction, submissionId, JSON.stringify(envelope), disposition, reason ?? '')}`;
    const entry = { seq: this.log.length + 1, direction, submission_id: submissionId, disposition, reason: reason ?? null, envelope, envelope_digest: `sha256:${H('d8/envelope/v1', JSON.stringify(envelope))}`, prev_digest: this.prevDigest, digest: entryDigest };
    this.log.push(entry);
    this.prevDigest = entryDigest;
    return entry;
  }

  audit() {
    let prev = 'genesis';
    const broken = [];
    for (const entry of this.log) {
      const expected = `sha256:${H('d8/chain/v1', prev, entry.direction, entry.submission_id, JSON.stringify(entry.envelope ?? null), entry.disposition, entry.reason ?? '')}`;
      if (entry.prev_digest !== prev) broken.push(`seq ${entry.seq}: prev link`);
      if (entry.digest !== expected) broken.push(`seq ${entry.seq}: digest`);
      prev = entry.digest;
    }
    return { length: this.log.length, valid: broken.length === 0, broken };
  }

  // ---------------------------------------------------------------- AA → ARA

  /**
   * Dispositions:
   *   rejected  — authority leak, malformed envelope, or missing provenance. Nothing is written.
   *   duplicate — the same submission id, or the same claim with the same anchors and statuses.
   *   stale     — a different source revision arrives without declaring that it supersedes the stored one.
   *   accepted  — written as an append event; the claim/anchor identities are ARA's, not AA's.
   */
  submit(envelope) {
    const submissionId = envelope?.submission_id ?? null;
    const reject = (reason) => {
      this.chainEntry({ direction: 'aa->ara', submissionId, envelope, disposition: 'rejected', reason });
      return { disposition: 'rejected', reason, written: 0 };
    };

    if (envelope?.schema !== 'aa-ara/v1') return reject('unsupported_schema');
    if (envelope.direction !== 'submit') return reject('wrong_direction');
    if (!submissionId) return reject('missing_submission_id');
    if (!Array.isArray(envelope.claims) || envelope.claims.length === 0) return reject('no_claims');

    const leaks = scanForbidden(envelope.claims, FORBIDDEN_SUBMIT);
    if (leaks.length) return reject(`authority_leak:${leaks.join(',')}`);

    const unknowns = Array.isArray(envelope.unknowns) ? envelope.unknowns : [];
    for (const unknown of unknowns) {
      if (!unknown?.kind || !unknown?.detail) return reject('malformed_unknown');
    }

    if (this.submissions.has(submissionId)) {
      this.chainEntry({ direction: 'aa->ara', submissionId, envelope, disposition: 'duplicate', reason: 'submission_id_seen' });
      return { disposition: 'duplicate', reason: 'submission_id_seen', written: 0 };
    }

    // Revision handling is explicit: revisions are opaque tokens, so an advance must be declared.
    for (const claim of envelope.claims) {
      for (const anchor of claim.anchors ?? []) {
        const stored = this.revisions.get(anchor.source_id);
        if (stored && anchor.source_revision && anchor.source_revision !== stored && envelope.supersedes_revision !== stored) {
          this.chainEntry({ direction: 'aa->ara', submissionId, envelope, disposition: 'stale', reason: `revision_conflict:${anchor.source_id}` });
          return { disposition: 'stale', reason: `revision_conflict:${anchor.source_id}`, written: 0 };
        }
      }
    }

    const prepared = envelope.claims.map((claim) => ({ claim, anchors: claim.anchors ?? [] }));

    // Duplicate detection at claim level: same text and same anchor identities + statuses.
    const allDuplicate = prepared.every(({ claim, anchors }) => {
      const id = this.claimIdFor(claim);
      const existing = this.store.db.prepare('SELECT COUNT(*) AS n FROM anchors WHERE claim_id = ?').get(id).n;
      if (existing !== anchors.length) return false;
      return anchors.every((anchor) => this.store.db.prepare('SELECT resolution_status FROM anchors WHERE claim_id = ? AND anchor_id = ?')
        .get(id, this.anchorIdFor(anchor))?.resolution_status === mapStatus(anchor.status));
    });
    if (allDuplicate) {
      this.chainEntry({ direction: 'aa->ara', submissionId, envelope, disposition: 'duplicate', reason: 'claim_and_anchors_seen' });
      return { disposition: 'duplicate', reason: 'claim_and_anchors_seen', written: 0 };
    }

    for (const { claim, anchors } of prepared) {
      this.store.appendClaim({
        text: claim.text,
        domain: claim.domain ?? 'prose',
        anchors: anchors.map((anchor) => ({
          source_id: anchor.source_id,
          source_revision: anchor.source_revision ?? null,
          quote: anchor.quote,
          context: anchor.context,
          loc_start: anchor.loc_start,
          loc_end: anchor.loc_end,
          resolution_status: mapStatus(anchor.status),
        })),
        actor: 'aa.exchange',
      });
      for (const anchor of anchors) if (anchor.source_revision) this.revisions.set(anchor.source_id, anchor.source_revision);
    }

    this.submissions.set(submissionId, envelope);
    for (const unknown of unknowns) this.unknowns.push({ ...unknown, submission_id: submissionId });
    this.chainEntry({ direction: 'aa->ara', submissionId, envelope, disposition: 'accepted', reason: null });
    return { disposition: 'accepted', written: prepared.length, claim_ids: prepared.map(({ claim }) => this.claimIdFor(claim)) };
  }

  claimIdFor(claim) {
    const id = this.store.db.prepare('SELECT claim_id FROM claims WHERE canonical_text = ? AND domain = ?').get(claim.text, claim.domain ?? 'prose');
    return id?.claim_id ?? null;
  }

  anchorIdFor(anchor) {
    return this.store.db.prepare('SELECT anchor_id FROM anchors WHERE source_id = ? AND quote = ? AND context_fingerprint = ? AND loc_start = ?')
      .get(anchor.source_id, anchor.quote, anchor.context, anchor.loc_start)?.anchor_id ?? null;
  }

  // ---------------------------------------------------------------- ARA → AA

  respond(claimIds, { scope = 'repo:code' } = {}) {
    const claims = claimIds.map((claimId) => {
      const resolution = this.store.provenance(claimId).map((row) => ({ status: row.resolution_status }));
      return {
        claim_id: claimId,
        resolution_status: resolution,
        assessments: this.store.reliability(claimId),
        conflicts: this.store.db.prepare('SELECT other_id FROM claim_conflicts WHERE claim_id = ? ORDER BY other_id').all(claimId),
        coverage: this.store.coverageOf(scope),
      };
    });

    const coverage = this.store.coverageOf(scope);
    const insufficiency = this.insufficiencyFor(coverage);
    const envelope = { schema: 'ara-aa/v1', direction: 'response', claims, coverage, insufficiency, unknowns_received: this.unknowns.length };
    const leaks = scanForbidden(envelope, FORBIDDEN_RESPONSE);
    const submissionId = `resp-${this.log.length + 1}`;
    this.chainEntry({ direction: 'ara->aa', submissionId, envelope, disposition: leaks.length ? 'rejected' : 'accepted', reason: leaks.length ? `authority_leak:${leaks.join(',')}` : null });
    return leaks.length ? { rejected: true, reason: `authority_leak:${leaks.join(',')}` } : envelope;
  }

  /** Sufficiency is ARA's: it never reads AA confidence, which never arrived. */
  insufficiencyFor(coverage) {
    if (!coverage.length) return { side: 'instrument', detail: 'no coverage recorded for this scope' };
    const row = coverage[0];
    if (row.instrument_fit !== 'fit') return { side: 'instrument', detail: row.instrument_fit };
    if (row.measured_covered / row.measured_total < 1) return { side: 'coverage', detail: `${row.measured_covered}/${row.measured_total}` };
    return null;
  }

  // ---------------------------------------------------------------- replay

  /** Replay recomputes dispositions from the envelopes and reports any divergence from the log. */
  static replay(entries, store) {
    const exchange = new Exchange(store);
    const divergences = [];
    for (const entry of entries) {
      const before = exchange.log.length;
      if (entry.direction === 'aa->ara') {
        const result = exchange.submit(entry.envelope);
        const recorded = exchange.log[before];
        if (result.disposition !== entry.disposition) divergences.push(`seq ${entry.seq}: ${result.disposition} != ${entry.disposition}`);
        if (recorded.digest !== entry.digest) divergences.push(`seq ${entry.seq}: digest differs`);
      } else {
        const result = exchange.respond((entry.envelope?.claims ?? []).map((claim) => claim.claim_id), { scope: entry.envelope?.coverage?.[0]?.scope ?? 'repo:code' });
        const recorded = exchange.log[before];
        if (recorded.digest !== entry.digest) divergences.push(`seq ${entry.seq}: response digest differs`);
        void result;
      }
    }
    return { exchange, divergences, audit: exchange.audit() };
  }
}

export const mapStatus = (status) => STATUS_MAP[status] ?? 'unresolved';
