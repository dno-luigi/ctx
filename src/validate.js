import { digest, hashSource } from './canonical.js';
import { locate } from './spans.js';

export const INPUT_SCHEMA = 'gca-input/v1';
export const SNAPSHOT_SCHEMA = 'gca-snapshot/v1';
export const HARNESS_VERSION = '0.1.0';

const SOURCE_KINDS = new Set(['document', 'image', 'page', 'transcript', 'note']);
const OBSERVATION_KINDS = new Set(['stated', 'derived', 'inferred']);
const ROLES = new Set(['primary', 'secondary', 'supporting']);
const COSTS = new Set(['low', 'medium', 'high']);

/**
 * Invariant 1: a snapshot may not decide, recommend, prefer or instruct.
 * Checked structurally, so a model cannot smuggle authority in a field name.
 */
const FORBIDDEN_KEYS = new Set([
  'action',
  'actions',
  'approval',
  'approve',
  'approved',
  'decision',
  'decisions',
  'execute',
  'instruction',
  'instructions',
  'preference',
  'preferences',
  'recommendation',
  'recommendations',
  'tool_call',
  'tool_calls',
  'verdict',
]);

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function forbiddenKeys(value, path, errors) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => forbiddenKeys(item, `${path}[${index}]`, errors));
    return;
  }
  if (!isObject(value)) return;
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_KEYS.has(key.toLowerCase())) {
      errors.push(
        `${path}.${key}: forbidden field — an assessment may not decide, recommend, prefer or instruct`
      );
    }
    forbiddenKeys(child, `${path}.${key}`, errors);
  }
}

export function validateInput(input) {
  const errors = [];
  if (!isObject(input)) return { ok: false, errors: ['input is not an object'] };
  if (input.schema !== INPUT_SCHEMA) errors.push(`schema: expected ${INPUT_SCHEMA}, got ${input.schema}`);
  if (!input.run?.id) errors.push('run.id is required');
  if (!input.run?.operator_ref) errors.push('run.operator_ref is required');
  if (!input.task?.question) errors.push('task.question is required');
  if (!Array.isArray(input.sources) || input.sources.length === 0) {
    errors.push('sources must be a non-empty array');
    return { ok: errors.length === 0, errors };
  }

  const ids = new Set();
  input.sources.forEach((source, index) => {
    const path = `sources[${index}]`;
    if (!source?.id) errors.push(`${path}.id is required`);
    else if (ids.has(source.id)) errors.push(`${path}.id is duplicated: ${source.id}`);
    else ids.add(source.id);

    if (!SOURCE_KINDS.has(source?.kind)) errors.push(`${path}.kind is not one of ${[...SOURCE_KINDS]}`);
    if (!source?.label) errors.push(`${path}.label is required`);
    if (!source?.media_type) errors.push(`${path}.media_type is required`);
    if (source?.observation !== 'observed') {
      errors.push(`${path}.observation must be "observed"`);
    }
    if (source?.origin?.supplied_by !== 'operator') {
      errors.push(`${path}.origin.supplied_by must be "operator"`);
    }
    if (!source?.origin?.method) errors.push(`${path}.origin.method is required`);
    if (!source?.origin?.captured_at) errors.push(`${path}.origin.captured_at is required`);

    if (source?.status === 'pending_capture') return;

    if (source?.kind === 'image') {
      if (!source?.content?.data_url) errors.push(`${path}.content.data_url is required for an image`);
    } else if (typeof source?.content?.text !== 'string' || source.content.text.length === 0) {
      errors.push(`${path}.content.text is required for a ${source?.kind ?? 'source'}`);
    }

    if (source?.hash !== hashSource(source)) {
      errors.push(`${path}.hash does not match the content it claims to describe`);
    }
  });

  const question = input.task?.question;
  if (typeof question === 'string' && question.trim().length === 0) {
    errors.push('task.question is empty');
  }

  return { ok: errors.length === 0, errors };
}

/**
 * Validates a snapshot against its input.
 *
 * Invariant 2: every citation must resolve to verbatim text in the cited source.
 * Invariant 3: kind is mandatory and separated from claim.
 * Invariant 4: gaps and abstentions are first-class arrays.
 * Invariant 5: confidence dimensions stay independent; they are never summed.
 */
export function validateSnapshot(input, snapshot) {
  const errors = [];
  const stats = { observations: 0, refs: 0, verifiable_refs: 0, unverifiable_refs: 0, corrected_spans: 0 };

  if (!isObject(snapshot)) return { ok: false, errors: ['snapshot is not an object'], stats };

  forbiddenKeys(snapshot, 'snapshot', errors);

  if (snapshot.schema !== SNAPSHOT_SCHEMA) {
    errors.push(`schema: expected ${SNAPSHOT_SCHEMA}, got ${snapshot.schema}`);
  }
  if (!snapshot.run?.model?.slug) errors.push('run.model.slug is required');
  if (!snapshot.run?.model?.provider) errors.push('run.model.provider is required');
  if (snapshot.input_digest !== digest(input)) {
    errors.push('input_digest does not match the input this snapshot claims to describe');
  }
  for (const key of ['observations', 'domains', 'gaps', 'checks', 'abstentions']) {
    if (!Array.isArray(snapshot[key])) errors.push(`${key} must be an array`);
  }

  const observations = Array.isArray(snapshot.observations) ? snapshot.observations : [];
  const oids = new Set();

  observations.forEach((observation, index) => {
    stats.observations += 1;
    const path = `observations[${index}]`;

    if (!observation?.oid) errors.push(`${path}.oid is required`);
    else if (oids.has(observation.oid)) errors.push(`${path}.oid is duplicated: ${observation.oid}`);
    else oids.add(observation.oid);

    if (typeof observation?.claim !== 'string' || !observation.claim.trim()) {
      errors.push(`${path}.claim is required`);
    }
    if (!OBSERVATION_KINDS.has(observation?.kind)) {
      errors.push(`${path}.kind must be stated, derived or inferred`);
    }
    if (!isObject(observation?.confidence)) {
      errors.push(`${path}.confidence is required`);
    } else {
      for (const dimension of ['extraction', 'interpretation']) {
        const value = observation.confidence[dimension];
        if (typeof value !== 'number' || value < 0 || value > 1) {
          errors.push(`${path}.confidence.${dimension} must be a number between 0 and 1`);
        }
      }
    }

    const refs = Array.isArray(observation?.refs) ? observation.refs : null;
    if (!refs) {
      errors.push(`${path}.refs must be an array`);
      return;
    }
    if (refs.length === 0 && observation?.kind !== 'inferred') {
      errors.push(`${path}.refs: a ${observation?.kind ?? 'non-inferred'} observation must cite at least one source`);
    }

    refs.forEach((ref, refIndex) => {
      stats.refs += 1;
      const found = locate(input, ref);
      if (!found.ok) {
        errors.push(`${path}.refs[${refIndex}]: ${found.reason} (source ${ref?.source_id ?? '?'})`);
        return;
      }
      if (found.verifiable) {
        stats.verifiable_refs += 1;
        if (!ref.span) errors.push(`${path}.refs[${refIndex}].span: unresolved after canonicalisation`);
        if (found.corrected) stats.corrected_spans += 1;
      } else {
        stats.unverifiable_refs += 1;
      }
    });
  });

  (Array.isArray(snapshot.domains) ? snapshot.domains : []).forEach((domain, index) => {
    const path = `domains[${index}]`;
    if (!domain?.name) errors.push(`${path}.name is required`);
    if (!ROLES.has(domain?.role)) errors.push(`${path}.role must be primary, secondary or supporting`);
    for (const oid of Array.isArray(domain?.basis) ? domain.basis : []) {
      if (!oids.has(oid)) errors.push(`${path}.basis references an unknown oid: ${oid}`);
    }
  });

  (Array.isArray(snapshot.gaps) ? snapshot.gaps : []).forEach((gap, index) => {
    if (!gap?.missing) errors.push(`gaps[${index}].missing is required`);
    if (!gap?.why) errors.push(`gaps[${index}].why is required`);
  });

  (Array.isArray(snapshot.checks) ? snapshot.checks : []).forEach((check, index) => {
    if (!check?.question) errors.push(`checks[${index}].question is required`);
    if (!COSTS.has(check?.expected_cost)) errors.push(`checks[${index}].expected_cost must be low, medium or high`);
  });

  (Array.isArray(snapshot.abstentions) ? snapshot.abstentions : []).forEach((abstention, index) => {
    if (!abstention?.topic) errors.push(`abstentions[${index}].topic is required`);
    if (!abstention?.reason) errors.push(`abstentions[${index}].reason is required`);
  });

  return { ok: errors.length === 0, errors, stats };
}
