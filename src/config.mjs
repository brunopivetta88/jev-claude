import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Threshold triple per signal. A missing level simply never fires.
 * @typedef {{ block?: number, ask?: number, warn?: number }} Thresholds
 */

export const DEFAULTS = {
  mode: 'shadow', // 'shadow' | 'enforce'
  apiBase: 'https://api.typesafe.ai/v1/systemone',
  model: 'jev-latest',
  timeoutMs: 1500,
  cacheTtlMs: 60_000,
  failOpen: true,
  redact: true,

  // Write the full (redacted) action to the session log, so the training
  // pipeline in training/ has something to learn from. Opt-in: it is more data
  // on disk and more of the session preserved than a guardrail strictly needs.
  collect: false,

  // Which decider answers the questions. See src/providers/index.mjs for the
  // full list: jev, anthropic, openai, deepseek, kimi, grok, mistral, groq,
  // together, openrouter, google, ollama, lmstudio, vllm, jevlab.
  provider: 'jev',

  // A second decider to ask in parallel. The primary still decides; the rival
  // is only logged. This is how a replacement is compared against the incumbent
  // on identical traffic instead of on a benchmark neither ships.
  compareProvider: '',
  compareApiBase: '',
  compareModel: '',

  // Tools worth a Jev call. Everything else is decided by the deterministic
  // floor alone, so read-only chatter never costs latency or tokens.
  evaluateTools: [
    'Bash', 'Write', 'Edit', 'NotebookEdit', 'WebFetch', 'Task', 'Agent',
    'shell', 'apply_patch', 'exec_command', 'update_plan',
  ],
  // Matched as a prefix, for MCP tools whose names are server-scoped.
  evaluateToolPrefixes: ['mcp__'],

  thresholds: {
    destructive: { block: 0.85, ask: 0.6, warn: 0.35 },
    secret_exposure: { block: 0.7, ask: 0.45, warn: 0.25 },
    exfiltration: { block: 0.8, ask: 0.55, warn: 0.3 },
    prompt_injection: { block: 0.75, ask: 0.5, warn: 0.3 },
    scope_creep: { ask: 0.8, warn: 0.5 },
    prod_impact: { ask: 0.7, warn: 0.45 },
    loop: { warn: 0.7 },
    unverified_claim: { warn: 0.7 },
    goal_incomplete: { ask: 0.8, warn: 0.6 },
  },

  // A Score answer at or above this level escalates a warn to an ask.
  severityAskFloor: 3,

  // Where session state and the decision log live. Relative paths resolve
  // against cwd; ${CLAUDE_PLUGIN_DATA} wins when Claude Code provides it.
  stateDir: '.jev-guard',
};

const ENV_SCALARS = {
  JEV_GUARD_MODE: ['mode', String],
  JEV_GUARD_API_BASE: ['apiBase', String],
  JEV_GUARD_MODEL: ['model', String],
  JEV_GUARD_TIMEOUT_MS: ['timeoutMs', Number],
  JEV_GUARD_CACHE_TTL_MS: ['cacheTtlMs', Number],
  JEV_GUARD_FAIL_OPEN: ['failOpen', toBool],
  JEV_GUARD_REDACT: ['redact', toBool],
  JEV_GUARD_STATE_DIR: ['stateDir', String],
  JEV_GUARD_SEVERITY_ASK_FLOOR: ['severityAskFloor', Number],
  JEV_GUARD_COLLECT: ['collect', toBool],
  JEV_GUARD_PROVIDER: ['provider', String],
  JEV_GUARD_COMPARE_PROVIDER: ['compareProvider', String],
  JEV_GUARD_COMPARE_API_BASE: ['compareApiBase', String],
  JEV_GUARD_COMPARE_MODEL: ['compareModel', String],
};

function toBool(v) {
  return !['0', 'false', 'no', 'off', ''].includes(String(v).toLowerCase());
}

function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function deepMerge(base, patch) {
  if (!isPlainObject(patch)) return base;
  const out = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    out[k] = isPlainObject(v) && isPlainObject(base[k]) ? deepMerge(base[k], v) : v;
  }
  return out;
}

/**
 * JEV_GUARD_THRESH_<SIGNAL>_<LEVEL>=0.9 -> thresholds.signal.level
 * The signal name keeps its underscores, so SECRET_EXPOSURE_BLOCK splits on
 * the last underscore only.
 */
function thresholdsFromEnv(env) {
  const out = {};
  for (const [key, raw] of Object.entries(env)) {
    if (!key.startsWith('JEV_GUARD_THRESH_')) continue;
    const rest = key.slice('JEV_GUARD_THRESH_'.length).toLowerCase();
    const cut = rest.lastIndexOf('_');
    if (cut < 1) continue;
    const signal = rest.slice(0, cut);
    const level = rest.slice(cut + 1);
    if (!['block', 'ask', 'warn'].includes(level)) continue;
    const value = Number(raw);
    if (!Number.isFinite(value)) continue;
    out[signal] = { ...(out[signal] ?? {}), [level]: value };
  }
  return out;
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null; // A broken config file must never take the agent down.
  }
}

/**
 * Precedence: defaults < jev-guard.config.json < env vars.
 * @param {string} [cwd]
 * @param {NodeJS.ProcessEnv} [env]
 */
export function loadConfig(cwd = process.cwd(), env = process.env) {
  let cfg = { ...DEFAULTS };

  for (const candidate of [
    join(cwd, 'jev-guard.config.json'),
    join(cwd, '.jev-guard', 'config.json'),
  ]) {
    if (existsSync(candidate)) cfg = deepMerge(cfg, readJson(candidate) ?? {});
  }

  for (const [envKey, [field, cast]] of Object.entries(ENV_SCALARS)) {
    if (env[envKey] !== undefined) cfg[field] = cast(env[envKey]);
  }
  cfg.thresholds = deepMerge(cfg.thresholds, thresholdsFromEnv(env));

  cfg.apiKey =
    env.TYPESAFE_API_KEY ||
    env.CLAUDE_PLUGIN_OPTION_TYPESAFE_API_KEY ||
    env.JEV_GUARD_API_KEY ||
    '';

  if (env.CLAUDE_PLUGIN_OPTION_MODE) cfg.mode = env.CLAUDE_PLUGIN_OPTION_MODE;
  if (env.CLAUDE_PLUGIN_DATA) cfg.stateDir = env.CLAUDE_PLUGIN_DATA;

  cfg.env = env;

  cfg.enforcing = cfg.mode === 'enforce';
  return cfg;
}

/** @param {ReturnType<typeof loadConfig>} cfg */
export function shouldEvaluate(cfg, toolName) {
  if (!toolName) return false;
  if (cfg.evaluateTools.includes(toolName)) return true;
  return cfg.evaluateToolPrefixes.some((p) => toolName.startsWith(p));
}
