import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULTS } from './config.mjs';
import { adapterFor, resolveProvider } from './providers/index.mjs';
import { isSignalKey } from './questions.mjs';

/**
 * Asking a decider one batch of typed questions.
 *
 * The decider may be Jev, any OpenAI-compatible endpoint (which is most of the
 * market, local runtimes included), Claude, Gemini, or our own trained model.
 * Everything below this line — the cache, the deadline, the failure handling —
 * is identical whichever one answers, and the policy engine never learns which
 * one it was.
 *
 * @typedef {Object} DecisionResult
 * @property {boolean} ok
 * @property {Record<string, number>} signals  probability per binary question
 * @property {number|null} severity            1-based level of the score answer
 * @property {string|null} model               model id that answered
 * @property {number} latencyMs
 * @property {'jev'|'cache'|'unavailable'} source
 * @property {string} [provider]
 * @property {string} [error]
 */

const EMPTY = { signals: {}, severity: null, model: null };

function cacheKey(body) {
  return createHash('sha256').update(JSON.stringify(body)).digest('hex').slice(0, 32);
}

function cacheDir(cfg) {
  return join(cfg.stateDir, 'cache');
}

function readCache(cfg, key) {
  if (!cfg.cacheTtlMs) return null;
  try {
    const raw = JSON.parse(readFileSync(join(cacheDir(cfg), `${key}.json`), 'utf8'));
    if (Date.now() - raw.at > cfg.cacheTtlMs) return null;
    return raw.value;
  } catch {
    return null;
  }
}

function writeCache(cfg, key, value) {
  if (!cfg.cacheTtlMs) return;
  try {
    mkdirSync(cacheDir(cfg), { recursive: true });
    writeFileSync(join(cacheDir(cfg), `${key}.json`), JSON.stringify({ at: Date.now(), value }));
  } catch {
    // A cache that cannot be written is not a reason to fail a tool call.
  }
}

/**
 * Turns an answers object into a flat signal map.
 * Binary answers are probabilities; a score answer becomes `severity`.
 * @param {Record<string, any>} answers
 */
export function answersToSignals(answers = {}) {
  const signals = {};
  let severity = null;
  for (const [key, answer] of Object.entries(answers)) {
    if (!answer || typeof answer !== 'object') continue;
    if (answer.type === 'noul' && typeof answer.noul === 'number') {
      if (isSignalKey(key)) signals[key] = answer.noul;
    } else if (answer.type === 'score' && typeof answer.score === 'number') {
      if (key === 'severity') severity = answer.score;
      else signals[key] = answer.score;
    }
  }
  return { signals, severity };
}

/**
 * Works out which endpoint, model and key this call should use.
 *
 * An explicitly configured base URL or model always wins over the provider's
 * preset — that is what makes a proxy, a gateway or a self-hosted deployment
 * work without a code change.
 */
export function resolveTarget(cfg, target = {}) {
  const name = target.provider ?? cfg.provider ?? 'jev';
  const info = resolveProvider(name, cfg.env ?? process.env);

  // A base URL or model still sitting at the built-in default was never chosen,
  // so the provider's preset fills it in. Anything else was chosen deliberately
  // — by an env var, a config file, or a caller — and always wins, which is
  // what makes a gateway, a proxy or a self-hosted deployment a config change.
  const chosenBase = cfg.apiBase && cfg.apiBase !== DEFAULTS.apiBase ? cfg.apiBase : '';
  const chosenModel = cfg.model && cfg.model !== DEFAULTS.model ? cfg.model : '';

  return {
    name,
    kind: info.kind,
    local: info.local,
    apiBase: target.apiBase || chosenBase || info.apiBase,
    model: target.model || chosenModel || info.model,
    apiKey: info.apiKey || (info.kind === 'jev' ? cfg.apiKey : ''),
  };
}

/**
 * Asks one decider. Never throws.
 *
 * @param {ReturnType<import('./config.mjs').loadConfig>} cfg
 * @param {{ state: unknown, questions: Record<string, unknown> }} payload
 * @param {{ apiBase?: string, model?: string, provider?: string }} [target]
 * @returns {Promise<DecisionResult>}
 */
export async function ask(cfg, { state, questions }, target = {}) {
  const started = Date.now();

  let resolved;
  let adapter;
  try {
    resolved = resolveTarget(cfg, target);
    adapter = adapterFor(resolved.kind);
  } catch (error) {
    return { ok: false, ...EMPTY, latencyMs: 0, source: 'unavailable', error: String(error.message ?? error) };
  }

  const fail = (error) => ({
    ok: false,
    ...EMPTY,
    latencyMs: Date.now() - started,
    source: 'unavailable',
    provider: resolved.name,
    error,
  });

  if (!resolved.model) {
    // Model ids are renamed and retired constantly; shipping a guess that 404s
    // at the moment a guardrail is needed is worse than saying so up front.
    return fail(`no model set for provider "${resolved.name}" — set JEV_GUARD_MODEL`);
  }
  if (!resolved.apiKey && !resolved.local) {
    return fail(`no API key for provider "${resolved.name}"`);
  }

  const body = adapter.body(resolved, { state, questions });
  const key = cacheKey({ provider: resolved.name, apiBase: resolved.apiBase, ...body });
  const cached = readCache(cfg, key);
  if (cached) {
    return { ok: true, ...cached, latencyMs: Date.now() - started, source: 'cache', provider: resolved.name };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);
  try {
    const response = await fetch(adapter.url(resolved), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...adapter.headers(resolved) },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      return fail(`HTTP ${response.status} ${detail.slice(0, 200)}`);
    }

    const json = await response.json();
    const parsed = adapter.parse(json, questions);
    const { signals, severity } = answersToSignals(parsed.answers);

    if (!Object.keys(signals).length && severity === null) {
      // A 200 that carries no usable answer is a failure, not an all-clear.
      return fail(`provider "${resolved.name}" returned no parseable answers`);
    }

    const value = { signals, severity, model: parsed.model ?? resolved.model, usage: parsed.usage ?? null };
    writeCache(cfg, key, value);
    return { ok: true, ...value, latencyMs: Date.now() - started, source: 'jev', provider: resolved.name };
  } catch (error) {
    const aborted = error?.name === 'AbortError';
    return fail(aborted ? `timeout after ${cfg.timeoutMs}ms` : String(error?.message ?? error));
  } finally {
    clearTimeout(timer);
  }
}

/** @deprecated kept so existing imports keep working; `ask` is the name now. */
export const askJev = ask;
