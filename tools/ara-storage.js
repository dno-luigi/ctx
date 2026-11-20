/**
 * D1 — physical storage model for ARA-SCHEMA-02 (A1′).
 *
 * The question this answers is not "can the schema be written down" but "do the logical distinctions
 * survive contact with a database". So the invariants the schema cares about are enforced by the
 * database itself — primary keys, CHECK constraints, triggers, foreign keys — and the acceptance suite
 * tests them by trying to violate them.
 *
 * Where each distinction lives physically:
 *   identity ≠ locator            anchors.anchor_id PK; locator columns mutable; trigger refuses
 *                                 changes to anchor_id / quote / claim_id / context_fingerprint
 *   assessment ≠ assessment       assessments.assessment_id PK (not claim_id+question), so a second
 *                                 model cannot overwrite the first
 *   relationship ≠ proof          relationships PK vs relationship_provenance composite PK per
 *                                 (extractor, version)
 *   unknown ≠ zero                coverage CHECK: measured columns are NULL unless instrument_fit='fit'
 *   unknown ≠ absent (edges)      extractor_declarations decides edges_unknown vs no_edges
 *   history is append-only        events triggers refuse UPDATE and DELETE
 *
 * Usage: see tools/storage-acceptance.js; or `node tools/ara-storage.js` for a smoke run.
 */

import { DatabaseSync } from 'node:sqlite';

import { digest, normalizeClaim } from '../src/canonical.js';

const H = (schema, ...parts) => digest({ schema, parts }).slice(0, 20);

export const SCHEMA_VERSION = 'ara-sqlite/v1';

export const DDL = `
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS events (
  event_id   INTEGER PRIMARY KEY,
  at         TEXT NOT NULL,
  actor      TEXT NOT NULL,
  -- Coverage and extractor declarations are events too: anything written outside the log is state the
  -- log cannot rebuild, which is precisely what replay is supposed to prove.
  op         TEXT NOT NULL CHECK (op IN ('append','supersede','conflict','resolve','retract','coverage','declare')),
  subject_id TEXT NOT NULL,
  payload    TEXT NOT NULL,
  basis      TEXT
);
CREATE TRIGGER IF NOT EXISTS events_no_update BEFORE UPDATE ON events
BEGIN SELECT RAISE(ABORT, 'event log is append-only'); END;
CREATE TRIGGER IF NOT EXISTS events_no_delete BEFORE DELETE ON events
BEGIN SELECT RAISE(ABORT, 'event log is append-only'); END;

CREATE TABLE IF NOT EXISTS claims (
  claim_id             TEXT PRIMARY KEY,
  canonical_text       TEXT NOT NULL,
  domain               TEXT NOT NULL,
  state                TEXT NOT NULL CHECK (state IN ('captured','unknown')),
  valid_from           TEXT,
  valid_until          TEXT,
  conflict_open        INTEGER NOT NULL DEFAULT 0 CHECK (conflict_open IN (0,1)),
  conflict_resolved_by TEXT,
  retracted_because    TEXT
);

CREATE TABLE IF NOT EXISTS claim_supersedes (
  claim_id      TEXT NOT NULL REFERENCES claims(claim_id),
  supersedes_id TEXT NOT NULL REFERENCES claims(claim_id),
  PRIMARY KEY (claim_id, supersedes_id)
);

CREATE TABLE IF NOT EXISTS claim_conflicts (
  claim_id TEXT NOT NULL REFERENCES claims(claim_id),
  other_id TEXT NOT NULL REFERENCES claims(claim_id),
  PRIMARY KEY (claim_id, other_id)
);

CREATE TABLE IF NOT EXISTS anchors (
  anchor_id           TEXT NOT NULL,
  claim_id            TEXT NOT NULL REFERENCES claims(claim_id),
  source_id           TEXT NOT NULL,
  source_revision     TEXT,
  context_fingerprint TEXT NOT NULL,
  loc_start           INTEGER NOT NULL,
  loc_end             INTEGER NOT NULL,
  quote               TEXT NOT NULL,
  resolution_status   TEXT NOT NULL CHECK (resolution_status IN ('verified','ambiguous','needs_reattribution','unresolved')),
  -- The row is a citation of an occurrence, so its key is (claim, occurrence). Two claims may cite the
  -- same occurrence; one claim cannot hold two rows for one identity.
  PRIMARY KEY (claim_id, anchor_id),
  CHECK (loc_end >= loc_start)
);
CREATE TRIGGER IF NOT EXISTS anchors_identity_immutable
BEFORE UPDATE OF anchor_id, quote, claim_id, context_fingerprint ON anchors
BEGIN SELECT RAISE(ABORT, 'anchor identity is immutable'); END;
CREATE TRIGGER IF NOT EXISTS anchors_no_delete BEFORE DELETE ON anchors
BEGIN SELECT RAISE(ABORT, 'anchors are retracted, never deleted'); END;

CREATE TABLE IF NOT EXISTS relationships (
  relationship_id TEXT PRIMARY KEY,
  type            TEXT NOT NULL,
  from_claim_id   TEXT NOT NULL REFERENCES claims(claim_id),
  to_claim_id     TEXT NOT NULL REFERENCES claims(claim_id)
);

CREATE TABLE IF NOT EXISTS relationship_provenance (
  relationship_id  TEXT NOT NULL REFERENCES relationships(relationship_id),
  extractor        TEXT NOT NULL,
  extractor_version TEXT NOT NULL,
  method           TEXT NOT NULL,
  evidence         TEXT,
  PRIMARY KEY (relationship_id, extractor, extractor_version)
);

CREATE TABLE IF NOT EXISTS assessments (
  assessment_id TEXT PRIMARY KEY,
  claim_id      TEXT NOT NULL REFERENCES claims(claim_id),
  question_id   TEXT NOT NULL,
  model         TEXT NOT NULL,
  probability   REAL NOT NULL CHECK (probability >= 0 AND probability <= 1),
  verdict       TEXT NOT NULL,
  assessed_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS coverage (
  coverage_id          TEXT PRIMARY KEY,
  scope                TEXT NOT NULL,
  domain               TEXT NOT NULL,
  required_set_digest  TEXT NOT NULL,
  instrument_name      TEXT,
  instrument_domain    TEXT,
  instrument_fit       TEXT NOT NULL CHECK (instrument_fit IN ('fit','mismatch','absent')),
  measured_covered     INTEGER,
  measured_total       INTEGER,
  unanchored_claims    INTEGER NOT NULL,
  CHECK (
    (instrument_fit = 'fit' AND measured_covered IS NOT NULL AND measured_total IS NOT NULL)
    OR (instrument_fit <> 'fit' AND measured_covered IS NULL AND measured_total IS NULL)
  )
);

CREATE TABLE IF NOT EXISTS extractor_declarations (
  scope             TEXT NOT NULL,
  extractor         TEXT NOT NULL,
  extractor_version TEXT NOT NULL,
  PRIMARY KEY (scope, extractor)
);
`;

export class NoProvenanceError extends Error {}
export class IllegalEventError extends Error {}

export class AraStore {
  constructor(path = ':memory:') {
    this.db = new DatabaseSync(path);
    this.db.exec(DDL);
  }

  close() { this.db.close(); }

  // ---------------------------------------------------------------- events

  emit(op, actor, subjectId, payload = {}, basis = null) {
    const row = this.db.prepare('SELECT COALESCE(MAX(event_id), 0) AS last FROM events').get();
    const event = { event_id: row.last + 1, at: `t${row.last + 1}`, actor, op, subject_id: subjectId, payload, basis };
    this.appendEvent(event);
    return event;
  }

  appendEvent(event) {
    this.db.prepare('INSERT INTO events (event_id, at, actor, op, subject_id, payload, basis) VALUES (?,?,?,?,?,?,?)')
      .run(event.event_id, event.at, event.actor, event.op, event.subject_id, JSON.stringify(event.payload), event.basis ?? null);
    this.apply(event);
  }

  apply(event) {
    const { op, subject_id: subjectId, payload, at, basis } = event;
    switch (op) {
      case 'append': {
        this.db.prepare('INSERT OR IGNORE INTO claims (claim_id, canonical_text, domain, state, valid_from) VALUES (?,?,?,?,?)')
          .run(payload.claim_id, payload.canonical_text, payload.domain, 'captured', at);
        for (const anchor of payload.anchors ?? []) {
          this.db.prepare(`INSERT OR IGNORE INTO anchors (anchor_id, claim_id, source_id, source_revision, context_fingerprint, loc_start, loc_end, quote, resolution_status)
            VALUES (?,?,?,?,?,?,?,?,?)`)
            .run(anchor.anchor_id, payload.claim_id, anchor.source_id, anchor.source_revision ?? null, anchor.context, anchor.loc_start, anchor.loc_end, anchor.quote, anchor.resolution_status);
        }
        for (const relationship of payload.relationships ?? []) {
          this.db.prepare('INSERT OR IGNORE INTO relationships (relationship_id, type, from_claim_id, to_claim_id) VALUES (?,?,?,?)')
            .run(relationship.relationship_id, relationship.type, relationship.from_claim_id, relationship.to_claim_id);
          for (const proof of relationship.provenance) {
            this.db.prepare('INSERT OR IGNORE INTO relationship_provenance (relationship_id, extractor, extractor_version, method, evidence) VALUES (?,?,?,?,?)')
              .run(relationship.relationship_id, proof.extractor, proof.extractor_version, proof.method, JSON.stringify(proof.evidence ?? null));
          }
        }
        for (const assessment of payload.assessments ?? []) {
          this.db.prepare('INSERT INTO assessments (assessment_id, claim_id, question_id, model, probability, verdict, assessed_at) VALUES (?,?,?,?,?,?,?)')
            .run(assessment.assessment_id, payload.claim_id, assessment.question_id, assessment.model, assessment.probability, assessment.verdict, assessment.assessed_at);
        }
        break;
      }
      case 'supersede': {
        const old = this.db.prepare('SELECT claim_id FROM claims WHERE claim_id = ?').get(subjectId);
        const next = this.db.prepare('SELECT claim_id FROM claims WHERE claim_id = ?').get(payload.replacement_claim_id);
        if (!old || !next) throw new IllegalEventError('supersede requires both claims');
        this.db.prepare('UPDATE claims SET valid_until = ? WHERE claim_id = ?').run(at, subjectId);
        this.db.prepare('INSERT OR IGNORE INTO claim_supersedes (claim_id, supersedes_id) VALUES (?,?)').run(payload.replacement_claim_id, subjectId);
        break;
      }
      case 'conflict': {
        const a = this.db.prepare('SELECT claim_id FROM claims WHERE claim_id = ?').get(subjectId);
        const b = this.db.prepare('SELECT claim_id FROM claims WHERE claim_id = ?').get(payload.other_claim_id);
        if (!a || !b) throw new IllegalEventError('conflict requires both claims');
        this.db.prepare('INSERT OR IGNORE INTO claim_conflicts (claim_id, other_id) VALUES (?,?)').run(subjectId, payload.other_claim_id);
        this.db.prepare('INSERT OR IGNORE INTO claim_conflicts (claim_id, other_id) VALUES (?,?)').run(payload.other_claim_id, subjectId);
        this.db.prepare('UPDATE claims SET conflict_open = 1 WHERE claim_id IN (?,?)').run(subjectId, payload.other_claim_id);
        break;
      }
      case 'resolve': {
        if (!basis) throw new IllegalEventError('resolve requires a basis');
        this.db.prepare('UPDATE claims SET conflict_open = 0, conflict_resolved_by = ? WHERE claim_id IN (?,?)').run(basis, subjectId, payload.other_claim_id);
        break;
      }
      case 'retract': {
        if (!basis) throw new IllegalEventError('retract requires a cause');
        const claim = this.db.prepare('SELECT claim_id FROM claims WHERE claim_id = ?').get(subjectId);
        if (!claim) throw new IllegalEventError('retract requires an existing claim');
        this.db.prepare('UPDATE claims SET state = ?, retracted_because = ? WHERE claim_id = ?').run('unknown', basis, subjectId);
        break;
      }
      case 'coverage': {
        this.db.prepare(`INSERT OR REPLACE INTO coverage (coverage_id, scope, domain, required_set_digest, instrument_name, instrument_domain, instrument_fit, measured_covered, measured_total, unanchored_claims)
          VALUES (?,?,?,?,?,?,?,?,?,?)`)
          .run(payload.coverage_id, payload.scope, payload.domain, payload.required_set_digest, payload.instrument_name, payload.instrument_domain, payload.instrument_fit, payload.measured_covered, payload.measured_total, payload.unanchored_claims);
        break;
      }
      case 'declare': {
        this.db.prepare('INSERT OR REPLACE INTO extractor_declarations (scope, extractor, extractor_version) VALUES (?,?,?)')
          .run(payload.scope, payload.extractor, payload.extractor_version);
        break;
      }
      default:
        throw new IllegalEventError(`unknown op ${op}`);
    }
  }

  static replay(events, path = ':memory:') {
    const store = new AraStore(path);
    for (const event of events) store.appendEvent({ ...event, payload: typeof event.payload === 'string' ? JSON.parse(event.payload) : event.payload });
    return store;
  }

  // ---------------------------------------------------------------- write API with preconditions

  appendClaim({ text, domain = 'prose', anchors = [], relationships = [], assessments = [], actor = 'extractor' }) {
    const claimId = `clm_${H('ara/claim/v1', normalizeClaim(text), domain)}`;
    if (anchors.length === 0) throw new NoProvenanceError(`claim ${claimId} has no anchor`);
    for (const anchor of anchors) {
      if (!anchor.source_id || !anchor.quote) throw new NoProvenanceError('anchor missing source or quote');
      if (typeof anchor.context !== 'string' || !anchor.context) throw new NoProvenanceError('anchor missing birth context');
      if (!Number.isInteger(anchor.loc_start) || !Number.isInteger(anchor.loc_end)) throw new NoProvenanceError('anchor missing locator');
    }
    for (const relationship of relationships) {
      if (!relationship.provenance?.length || !relationship.provenance[0].extractor) throw new NoProvenanceError('relationship without extractor');
    }
    return this.emit('append', actor, claimId, {
      claim_id: claimId,
      canonical_text: text,
      domain,
      anchors: anchors.map((anchor) => ({
        anchor_id: `anc_${H('ara/anchor/v2', normalizeClaim(anchor.quote), anchor.source_id, anchor.context)}`,
        source_id: anchor.source_id,
        source_revision: anchor.source_revision ?? null,
        context: anchor.context,
        loc_start: anchor.loc_start,
        loc_end: anchor.loc_end,
        quote: anchor.quote,
        resolution_status: anchor.resolution_status ?? 'verified',
      })),
      relationships,
      assessments,
    });
  }

  supersede(oldClaimId, { text, domain = 'prose', anchor }) {
    const claimId = `clm_${H('ara/claim/v1', normalizeClaim(text), domain)}`;
    this.emit('append', 'extractor', claimId, {
      claim_id: claimId, canonical_text: text, domain,
      anchors: [{
        anchor_id: `anc_${H('ara/anchor/v2', normalizeClaim(anchor.quote), anchor.source_id, anchor.context)}`,
        source_id: anchor.source_id, source_revision: null, context: anchor.context,
        loc_start: anchor.loc_start, loc_end: anchor.loc_end, quote: anchor.quote, resolution_status: anchor.resolution_status ?? 'verified',
      }],
    });
    return this.emit('supersede', 'system', oldClaimId, { replacement_claim_id: claimId });
  }

  conflict(a, b) { return this.emit('conflict', 'adjudicator', a, { other_claim_id: b }); }
  resolve(a, b, basis) { return this.emit('resolve', 'adjudicator', a, { other_claim_id: b }, basis); }
  retract(id, cause) { return this.emit('retract', 'system', id, {}, cause); }

  writeCoverage({ scope, domain, requiredSetDigest, instrument, covered, total, unanchored }) {
    const fit = instrument ? (instrument.domain === domain ? 'fit' : 'mismatch') : 'absent';
    const coverageId = `cov_${H('ara/coverage/v1', scope, requiredSetDigest, instrument?.name ?? 'none', domain)}`;
    this.emit('coverage', 'instrument', scope, {
      coverage_id: coverageId, scope, domain, required_set_digest: requiredSetDigest,
      instrument_name: instrument?.name ?? null, instrument_domain: instrument?.domain ?? null, instrument_fit: fit,
      measured_covered: fit === 'fit' ? covered : null, measured_total: fit === 'fit' ? total : null, unanchored_claims: unanchored,
    });
    return this.coverageOf(scope);
  }

  declareExtractor({ scope, extractor, version }) {
    return this.emit('declare', 'instrument', scope, { scope, extractor, extractor_version: version });
  }

  // ---------------------------------------------------------------- queries: four disjoint answer sets

  static COLUMNS = {
    information: ['claim_id', 'canonical_text', 'domain', 'state'],
    provenance: ['source_id', 'source_revision', 'loc_start', 'loc_end', 'context_fingerprint', 'quote', 'resolution_status'],
    relationships: ['relationship_id', 'type', 'from_claim_id', 'to_claim_id', 'extractor'],
    reliability: ['assessment_id', 'question_id', 'model', 'probability', 'verdict', 'assessed_at'],
  };

  information(scopeIds) {
    const marks = scopeIds.map(() => '?').join(',') || "''";
    return this.db.prepare(`SELECT claim_id, canonical_text, domain, state FROM claims WHERE claim_id IN (${marks}) ORDER BY claim_id`).all(...scopeIds);
  }

  provenance(claimId) {
    return this.db.prepare(`SELECT source_id, source_revision, loc_start, loc_end, context_fingerprint, quote, resolution_status
      FROM anchors WHERE claim_id = ? ORDER BY anchor_id`).all(claimId);
  }

  relationshipsOf(claimId, { extractor = null, scope = 'repo:code' } = {}) {
    if (!extractor) return { status: 'edges_unknown', reason: 'no extractor declared for this scope', edges: [] };
    const declaration = this.db.prepare('SELECT extractor FROM extractor_declarations WHERE scope = ? AND extractor = ?').get(scope, extractor);
    if (!declaration) return { status: 'edges_unknown', reason: `extractor ${extractor} never declared for ${scope}`, edges: [] };
    const edges = this.db.prepare(`SELECT r.relationship_id, r.type, r.from_claim_id, r.to_claim_id, p.extractor
      FROM relationships r JOIN relationship_provenance p ON p.relationship_id = r.relationship_id
      WHERE p.extractor = ? AND (r.from_claim_id = ? OR r.to_claim_id = ?)
      ORDER BY r.relationship_id`).all(extractor, claimId, claimId);
    return edges.length ? { status: 'ok', edges } : { status: 'no_edges', extractor, edges: [] };
  }

  reliability(claimId) {
    return this.db.prepare(`SELECT assessment_id, question_id, model, probability, verdict, assessed_at
      FROM assessments WHERE claim_id = ? ORDER BY assessment_id`).all(claimId);
  }

  coverageOf(scope) {
    return this.db.prepare(`SELECT coverage_id, scope, domain, instrument_name, instrument_domain, instrument_fit, measured_covered, measured_total, unanchored_claims
      FROM coverage WHERE scope = ? ORDER BY coverage_id`).all(scope);
  }

  /** Sufficiency reads the stored row: a mismatch cannot be coerced into a zero. */
  mayProceed(coverageRow, support) {
    if (coverageRow.instrument_fit !== 'fit') return { ok: false, side: 'instrument', detail: coverageRow.instrument_fit };
    if (coverageRow.measured_covered / coverageRow.measured_total < 1) return { ok: false, side: 'coverage', detail: `${coverageRow.measured_covered}/${coverageRow.measured_total}` };
    if (support < 0.5) return { ok: false, side: 'support', detail: support };
    return { ok: true };
  }

  // ---------------------------------------------------------------- projection and replay

  projection() {
    const claims = this.db.prepare('SELECT claim_id, canonical_text, domain, state, valid_from, valid_until, conflict_open, conflict_resolved_by, retracted_because FROM claims ORDER BY claim_id').all();
    const supersedes = this.db.prepare('SELECT claim_id, supersedes_id FROM claim_supersedes ORDER BY claim_id, supersedes_id').all();
    const conflicts = this.db.prepare('SELECT claim_id, other_id FROM claim_conflicts ORDER BY claim_id, other_id').all();
    const anchors = this.db.prepare('SELECT anchor_id, claim_id, source_id, source_revision, context_fingerprint, loc_start, loc_end, quote, resolution_status FROM anchors ORDER BY anchor_id').all();
    const relationships = this.db.prepare('SELECT relationship_id, type, from_claim_id, to_claim_id FROM relationships ORDER BY relationship_id').all();
    const provenance = this.db.prepare('SELECT relationship_id, extractor, extractor_version, method, evidence FROM relationship_provenance ORDER BY relationship_id, extractor, extractor_version').all();
    const assessments = this.db.prepare('SELECT assessment_id, claim_id, question_id, model, probability, verdict, assessed_at FROM assessments ORDER BY assessment_id').all();
    const coverage = this.db.prepare('SELECT coverage_id, scope, domain, required_set_digest, instrument_name, instrument_domain, instrument_fit, measured_covered, measured_total, unanchored_claims FROM coverage ORDER BY coverage_id').all();
    const declarations = this.db.prepare('SELECT scope, extractor, extractor_version FROM extractor_declarations ORDER BY scope, extractor').all();
    return JSON.stringify({ claims, supersedes, conflicts, anchors, relationships, provenance, assessments, coverage, declarations });
  }

  events() {
    return this.db.prepare('SELECT event_id, at, actor, op, subject_id, payload, basis FROM events ORDER BY event_id').all()
      .map((row) => ({ ...row, payload: JSON.parse(row.payload) }));
  }

  /** Physical invariants that no single constraint can express, checked as queries. */
  invariants() {
    return {
      relationships_without_provenance: this.db.prepare('SELECT COUNT(*) AS n FROM relationships r WHERE NOT EXISTS (SELECT 1 FROM relationship_provenance p WHERE p.relationship_id = r.relationship_id)').get().n,
      anchors_without_claim: this.db.prepare('SELECT COUNT(*) AS n FROM anchors a WHERE NOT EXISTS (SELECT 1 FROM claims c WHERE c.claim_id = a.claim_id)').get().n,
      claims_without_anchor: this.db.prepare('SELECT COUNT(*) AS n FROM claims c WHERE NOT EXISTS (SELECT 1 FROM anchors a WHERE a.claim_id = c.claim_id)').get().n,
      coverage_with_zero_instead_of_unknown: this.db.prepare("SELECT COUNT(*) AS n FROM coverage WHERE instrument_fit <> 'fit' AND (measured_covered IS NOT NULL OR measured_total IS NOT NULL)").get().n,
    };
  }
}

if (process.argv[1] && process.argv[1].endsWith('ara-storage.js')) {
  const store = new AraStore();
  store.appendClaim({
    text: 'The service keeps three replicas.',
    anchors: [{ source_id: 'svc.md', quote: 'The service keeps three replicas.', context: 'a|b', loc_start: 0, loc_end: 33 }],
  });
  console.log('smoke projection:', store.projection().slice(0, 120));
  console.log('invariants:', store.invariants());
  store.close();
}
