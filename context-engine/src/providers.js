/**
 * Provider boundary for the context engine.
 *
 * Three implementations, one interface:
 *   stub               deterministic rule scanner. Exercises the pipeline offline; its output is an
 *                      instrument check, never model evidence.
 *   scripted           replays supplied payloads. Used to prove that invalid model output is flagged
 *                      rather than repaired.
 *   openai-compatible  any JSON chat endpoint (OpenRouter by default). The only paid path.
 *
 * Usage is read from the response. When the provider does not report tokens, they are null — never
 * estimated. When it does not report a charge, the catalogue product is recorded with an explicit
 * `cost_source: 'catalogue'`, so a price drift stays visible instead of being averaged away.
 *
 * A paid call requires an explicit budget. The pre-flight estimate uses ceil(chars/4) solely to
 * refuse obviously oversized calls; it never becomes a cost result.
 */

import { readFile } from 'node:fs/promises';

import { SpendRefusal } from './guard.js';

const MODELS_URL = new URL('../models.json', import.meta.url);

/**
 * Chars per token used by the *spend gate* only.
 *
 * Measured against provider-reported usage on 2026-11-20 (`poc/calibrate.js`): these prompts billed at
 * 3.47 and 3.82 chars/token, so `ceil(chars/4)` understated the input of the scan prompt by 13.2%.
 * Understating input is the unsafe direction for a pre-flight check, so the gate uses the pessimistic
 * figure. Artifact estimates keep using 4 until the estimator is versioned, because changing them
 * would restate pack sizes that are already published.
 */
const PREFLIGHT_CHARS_PER_TOKEN = 3.5;

export async function loadModels() {
  return JSON.parse(await readFile(MODELS_URL, 'utf8'));
}

export function resolveModel(registry, idOrSlug) {
  const wanted = idOrSlug ?? registry.default;
  const model = registry.models.find((entry) => entry.id === wanted || entry.slug === wanted);
  if (!model) throw new Error(`unknown scanning model: ${wanted}; known: ${registry.models.map((entry) => entry.id).join(', ')}`);
  return model;
}

const parseJson = (text) => {
  if (!text) return null;
  let body = String(text).trim();
  const fenced = body.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) body = fenced[1].trim();
  const first = body.indexOf('{');
  const last = body.lastIndexOf('}');
  if (first < 0 || last <= first) return null;
  try {
    return JSON.parse(body.slice(first, last + 1));
  } catch {
    return null;
  }
};

// ------------------------------------------------------------------ stub scanner

const RULES = [
  { kind: 'invariant', re: /\b(MUST|MUST NOT|NEVER|invariant|shall not|shall)\b/ },
  { kind: 'decision', re: /\b(ADR-\d+|decided|decision|chose|rejected)\b/i },
  { kind: 'outstanding', re: /\b(TODO|FIXME|outstanding|not yet|remaining|pending)\b/i },
  { kind: 'risk', re: /\b(known failure|risk|fails?|drops?|broken|warning|alert)\b/i },
  { kind: 'dependency', re: /\b(depends on|imports|requires)\b/i },
  { kind: 'responsibility', re: /\b(is responsible for|owns|provides|is the only)\b/i },
  { kind: 'state', re: /\b(currently|defaults? to|configured|today)\b/i },
  { kind: 'architecture', re: /^#{1,3}\s+/ },
  { kind: 'question', re: /\?$/ },
];

const clean = (line) => line.replace(/^\s*(?:[-*+]|\d+\.)\s+/, '').replace(/^#+\s*/, '').replace(/^`{1,3}|`{1,3}$/g, '').trim();

/**
 * Deterministic, low-recall, high-precision-ish line classifier. Every quote is copied from the
 * source, so a successful citation says the pipeline works — not that a model understood anything.
 */
export function stubScan({ sources, references = [], maxFindings = 120 }) {
  const findings = [];
  const seen = new Set();
  for (const source of sources) {
    const lines = source.text.split('\n');
    lines.forEach((raw, index) => {
      const line = raw.trim();
      if (!line || line.length < 12 || line.length > 400) return;
      if (/^(?:```|import |const |let |var |function |return |if \(|for \(|}\)|\);|},|export default)/.test(line) && !/\b(MUST|NEVER|TODO|FIXME)\b/.test(line)) return;
      const rule = RULES.find((entry) => entry.re.test(line));
      if (!rule) return;
      const quote = line;
      const key = `${rule.kind}|${clean(line).toLowerCase()}`;
      if (seen.has(key) || findings.length >= maxFindings) return;
      seen.add(key);
      findings.push({
        kind: rule.kind,
        text: clean(line),
        certainty: 'stated',
        sources: [{ source_id: source.source_id, quote, line: index + 1 }],
        entities: (clean(line).match(/\b[A-Za-z][A-Za-z0-9_.-]{2,}\b/g) ?? []).slice(0, 6),
      });
    });
  }
  return {
    findings,
    relationships: references.map((edge) => ({
      from: edge.from,
      to: edge.to,
      type: edge.kind === 'import' ? 'imports' : 'references',
      sources: [{ source_id: edge.from, quote: sources.find((source) => source.source_id === edge.from)?.text.split('\n')[edge.line - 1]?.trim() ?? '' }],
    })),
    contradictions: [],
    questions: findings.filter((finding) => finding.kind === 'question').map((finding) => finding.text),
  };
}

// ------------------------------------------------------------------ providers

export function createProvider({ kind = 'stub', registry, model, budget, guard = null, purpose = null, fetchImpl = globalThis.fetch, env = process.env, script = [], endpoint, keyEnv, headers = {} }) {
  if (kind === 'stub') {
    return Object.freeze({
      kind,
      id: 'stub-rule-scanner',
      model: { id: 'stub', slug: 'stub', vendor: 'none', pricing: { input_per_mtok: 0, output_per_mtok: 0 } },
      async complete({ meta }) {
        const started = Date.now();
        return {
          payload: stubScan(meta),
          usage: { input_tokens: 0, output_tokens: 0, cost_usd: 0, cost_source: 'not_applicable', catalogue_cost_usd: 0 },
          provider: { requested: 'stub', upstream: 'none', generation_id: null },
          latency_ms: Math.max(0, Date.now() - started),
          problems: [],
        };
      },
    });
  }

  if (kind === 'scripted') {
    let cursor = 0;
    return Object.freeze({
      kind,
      id: 'scripted',
      model: { id: 'scripted', slug: 'scripted', vendor: 'none', pricing: { input_per_mtok: 0, output_per_mtok: 0 } },
      async complete() {
        const entry = script[cursor] ?? { payload: null };
        cursor += 1;
        const usage = entry.usage ?? { input_tokens: null, output_tokens: null, cost_usd: null, cost_source: 'absent' };
        // `problems` passes through so a test can inject the failures a live provider reports
        // (output_truncated, payload_unparseable) and check that the harness refuses them.
        return { payload: entry.payload, usage, provider: { requested: 'scripted', upstream: 'none', generation_id: null }, latency_ms: 1, problems: entry.problems ?? [] };
      },
    });
  }

  if (kind !== 'openai-compatible') throw new Error(`unknown provider kind: ${kind}`);
  if (!model) throw new Error('openai-compatible provider requires a model');
  if (!registry) throw new Error('openai-compatible provider requires the model registry');
  // Refuse at construction, not at the first call: a paid provider that exists without an
  // authorisation is one bug away from spending, and the bug would be in a caller.
  if (!guard) {
    throw new SpendRefusal('guard_required', 'a paid provider requires a spend guard (src/guard.js): live execution is one authorised attempt per run id');
  }

  const base = endpoint ?? registry.endpoint ?? 'https://openrouter.ai/api/v1';
  const keyName = keyEnv ?? registry.key_env ?? 'OPENROUTER_API_KEY';
  const price = { input: model.pricing?.input_per_mtok ?? 0, output: model.pricing?.output_per_mtok ?? 0 };

  return Object.freeze({
    kind,
    id: model.id,
    model,
    async complete({ system, user, maxTokens = 2000 }) {
      const key = env[keyName];
      if (!key) throw new Error(`${keyName} is not set; refusing to run a paid provider`);
      if (!budget || !(budget.usd > 0)) throw new Error('a paid scan requires an explicit budget (--budget-usd)');
      // A budget says how much may be spent. The guard says whether this process is allowed to spend
      // at all: one authorised attempt per run id, recorded in a ledger that survives the process.
      if (!guard) {
        throw new SpendRefusal('guard_required', 'a paid provider requires a spend guard (src/guard.js): live execution is one authorised attempt per run id');
      }
      guard.assertOpen();

      const preflightInput = Math.ceil((system.length + user.length) / PREFLIGHT_CHARS_PER_TOKEN);
      const preflightCost = (preflightInput * price.input + maxTokens * price.output) / 1e6;
      if (budget.spent + preflightCost > budget.usd) {
        throw new Error(`budget_exceeded: spent $${budget.spent.toFixed(6)} of $${budget.usd.toFixed(2)}; next call ~$${preflightCost.toFixed(6)}`);
      }
      guard.assertCanAfford(preflightCost);

      const started = Date.now();
      const response = await fetchImpl(`${base}/chat/completions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', ...headers },
        body: JSON.stringify({
          model: model.slug,
          temperature: 0,
          max_tokens: maxTokens,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
        }),
      });
      const latency_ms = Date.now() - started;
      const body = await response.json().catch(() => null);
      if (!response.ok) throw new Error(`${model.slug}: provider ${response.status} ${body?.error?.message ?? ''}`.trim());

      const reported = body?.usage ?? {};
      const input = typeof reported.prompt_tokens === 'number' ? reported.prompt_tokens : null;
      const output = typeof reported.completion_tokens === 'number' ? reported.completion_tokens : null;
      const catalogue = input === null ? null : Number((((input ?? 0) * price.input + (output ?? 0) * price.output) / 1e6).toFixed(12));
      const providerCharge = typeof reported.cost === 'number' ? reported.cost : null;
      const cost = providerCharge ?? catalogue;
      if (typeof cost === 'number') budget.spent += cost;
      const generationId = typeof body?.id === 'string' ? body.id : null;
      // Recorded before the payload is interpreted: a truncated or unparseable response still cost
      // money, so the ledger has to show it even when the call is a failure.
      guard.recordCall({ costUsd: cost, inputTokens: input, outputTokens: output, generationId, purpose, model: model.slug });

      const problems = [];
      const finishReason = body?.choices?.[0]?.finish_reason ?? null;
      const content = body?.choices?.[0]?.message?.content ?? '';
      const payload = parseJson(content);
      // A truncated response is not an empty one. Without this, a cut-off JSON object becomes
      // "the model found nothing", which is the exact failure this engine exists to avoid.
      if (finishReason === 'length') problems.push({ code: 'output_truncated', finish_reason: finishReason, max_tokens: maxTokens, why: 'response hit the output cap; findings may be incomplete' });
      if (!payload && content) problems.push({ code: 'payload_unparseable', chars: String(content).length, why: 'response was not parseable JSON; no findings were accepted' });
      if (input === null) problems.push({ code: 'usage_missing', why: 'provider reported no prompt tokens; token and cost fields are null, not estimates' });
      if (providerCharge === null && catalogue !== null) problems.push({ code: 'cost_from_catalogue', why: 'provider reported no charge; catalogue product recorded and marked' });

      return {
        payload,
        usage: {
          input_tokens: input,
          output_tokens: output,
          cost_usd: cost,
          cost_source: providerCharge !== null ? 'provider' : catalogue !== null ? 'catalogue' : 'absent',
          catalogue_cost_usd: catalogue,
        },
        provider: {
          requested: model.slug,
          // The alias redirects to whatever GLM Flash is current. Record what it actually served,
          // or a moving alias would make two differently-priced runs look identical.
          resolved_model: typeof body?.model === 'string' ? body.model : null,
          upstream: typeof body?.provider === 'string' ? body.provider : null,
          generation_id: generationId,
          finish_reason: finishReason,
        },
        latency_ms,
        problems,
      };
    },
  });
}
