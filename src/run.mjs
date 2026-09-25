import { shouldEvaluate } from './config.mjs';
import { deterministicFloor, mergeSignals } from './deterministic.mjs';
import { ask } from './jev-client.mjs';
import { applyMode, applyUnavailable, decide } from './policy.mjs';
import { PRE_TOOL_QUESTIONS, POST_TOOL_QUESTIONS, STOP_QUESTIONS } from './questions.mjs';
import { flatten, redactText, sanitize, textForRules, truncate } from './redact.mjs';
import { loadSessionState, logDecision, recordEvent } from './state.mjs';

/**
 * @typedef {Object} NormalizedEvent
 * @property {'SessionStart'|'UserPromptSubmit'|'PreToolUse'|'PostToolUse'|'Stop'} event
 * @property {string} sessionId
 * @property {string} cwd
 * @property {string} [toolName]
 * @property {unknown} [toolInput]
 * @property {unknown} [toolResponse]
 * @property {string} [prompt]
 * @property {'claude-code'|'codex'} harness
 */

const ALLOW = (extra = {}) => ({
  action: 'allow',
  rawAction: 'allow',
  reasons: [],
  signals: {},
  severity: null,
  shadowed: false,
  ...extra,
});

function summarize(toolName, toolInput) {
  return truncate(redactText(`${toolName ?? 'tool'} ${flatten(toolInput)}`), 200);
}

function filePathOf(toolInput) {
  if (!toolInput || typeof toolInput !== 'object') return '';
  const o = /** @type {Record<string, unknown>} */ (toolInput);
  const candidate = o.file_path ?? o.path ?? o.notebook_path ?? o.filePath;
  return typeof candidate === 'string' ? candidate : '';
}

function looksFailed(toolResponse) {
  if (!toolResponse) return false;
  if (typeof toolResponse === 'object') {
    const o = /** @type {Record<string, unknown>} */ (toolResponse);
    if (o.is_error === true || o.success === false) return true;
    if (typeof o.stderr === 'string' && o.stderr.trim()) return true;
    if (typeof o.exit_code === 'number' && o.exit_code !== 0) return true;
  }
  const text = flatten(toolResponse).slice(0, 2000);
  return /\b(error|exception|traceback|failed|fatal|not found|denied)\b/i.test(text);
}

/**
 * Runs the guardrail for one normalized event. Never throws: any internal
 * failure degrades to `allow` with a note, because a broken guardrail must not
 * become a broken agent.
 *
 * @param {NormalizedEvent} evt
 * @param {ReturnType<import('./config.mjs').loadConfig>} cfg
 * @returns {Promise<{decision: ReturnType<typeof decide>, meta: Record<string, unknown>}>}
 */
export async function run(evt, cfg) {
  try {
    return await dispatch(evt, cfg);
  } catch (error) {
    return {
      decision: ALLOW(),
      meta: { skipped: 'internal-error', error: String(error?.message ?? error) },
    };
  }
}

async function dispatch(evt, cfg) {
  switch (evt.event) {
    case 'SessionStart':
      recordEvent(cfg, evt.sessionId, { kind: 'session', harness: evt.harness, cwd: evt.cwd });
      return { decision: ALLOW(), meta: { skipped: 'session-start' } };

    case 'UserPromptSubmit': {
      // The goal is what every later "is this in scope?" question is judged
      // against, so it is stored verbatim (redacted) and never sent to Jev here.
      recordEvent(cfg, evt.sessionId, { kind: 'goal', text: truncate(redactText(evt.prompt ?? ''), 1500) });
      return { decision: ALLOW(), meta: { skipped: 'goal-recorded' } };
    }

    case 'PreToolUse':
      return preToolUse(evt, cfg);

    case 'PostToolUse':
      return postToolUse(evt, cfg);

    case 'Stop':
      return stop(evt, cfg);

    default:
      return { decision: ALLOW(), meta: { skipped: `unhandled:${evt.event}` } };
  }
}

async function preToolUse(evt, cfg) {
  const floor = deterministicFloor({
    toolName: evt.toolName,
    text: textForRules(evt.toolInput),
    filePath: filePathOf(evt.toolInput),
  });

  const worthAsking = shouldEvaluate(cfg, evt.toolName) || floor.matches.length > 0;
  const session = loadSessionState(cfg, evt.sessionId);

  const record = {
    kind: 'tool',
    tool: evt.toolName,
    summary: summarize(evt.toolName, evt.toolInput),
  };
  if (cfg.collect) {
    // The training pipeline needs the action itself, not a 200-character
    // summary of it. Still redacted — collection is not an excuse to log secrets.
    record.action = sanitize(evt.toolInput, cfg);
    record.cwd = evt.cwd;
    record.floor = floor.signals;
  }

  if (!worthAsking) {
    // Read-only tools with a clean floor never reach the network: the whole
    // point of a reflex layer is that it is cheaper than what it guards.
    recordEvent(cfg, evt.sessionId, record);
    return { decision: ALLOW(), meta: { skipped: 'tool-not-evaluated', tool: evt.toolName } };
  }

  const payload = {
    state: {
      user_goal: session.goal ?? '(not captured)',
      proposed_action: { tool: evt.toolName, input: sanitize(evt.toolInput, cfg) },
      recent_actions: session.recent,
      working_directory: evt.cwd,
    },
    questions: PRE_TOOL_QUESTIONS,
  };

  // The rival is asked at the same time, never in sequence: a comparison that
  // doubles the latency of every tool call would be switched off within a day,
  // and then there is nothing to compare.
  const [jev, rival] = await Promise.all([
    ask(cfg, payload),
    cfg.compareProvider || cfg.compareApiBase
      ? ask(cfg, payload, {
          provider: cfg.compareProvider || undefined,
          apiBase: cfg.compareApiBase || undefined,
          model: cfg.compareModel || undefined,
        })
      : Promise.resolve(null),
  ]);

  if (cfg.collect) record.jev = jev.signals;
  recordEvent(cfg, evt.sessionId, record);

  let decision = decide({
    signals: mergeSignals(jev.signals, floor.signals),
    severity: jev.severity,
    thresholds: cfg.thresholds,
    severityAskFloor: cfg.severityAskFloor,
    floorMatches: floor.matches,
  });

  if (!jev.ok) decision = applyUnavailable(decision, cfg, jev.error ?? 'unknown');
  decision = applyMode(decision, cfg);

  const meta = { tool: evt.toolName, jev: jev.source, latencyMs: jev.latencyMs, model: jev.model, error: jev.error };
  if (rival) meta.compare = compareDecisions(decision, rival, floor, cfg);
  logDecision(cfg, { event: 'PreToolUse', session: evt.sessionId, harness: evt.harness, action: decision.action, rawAction: decision.rawAction, reasons: decision.reasons, ...meta });
  return { decision, meta };
}

/**
 * What the rival endpoint would have decided on this same action.
 *
 * Run through the identical policy engine and the identical floor, so the only
 * variable is which model answered. Logged, never applied — a challenger earns
 * its way in on recorded traffic, not by being pointed at.
 */
function compareDecisions(primary, rival, floor, cfg) {
  const rivalDecision = decide({
    signals: mergeSignals(rival.signals, floor.signals),
    severity: rival.severity,
    thresholds: cfg.thresholds,
    severityAskFloor: cfg.severityAskFloor,
    floorMatches: floor.matches,
  });
  return {
    provider: rival.provider,
    model: rival.model,
    ok: rival.ok,
    error: rival.error,
    latencyMs: rival.latencyMs,
    signals: rival.signals,
    severity: rival.severity,
    action: rivalDecision.rawAction,
    agrees: rivalDecision.rawAction === primary.rawAction,
  };
}

async function postToolUse(evt, cfg) {
  const failed = looksFailed(evt.toolResponse);
  recordEvent(cfg, evt.sessionId, {
    kind: 'tool',
    tool: evt.toolName,
    summary: summarize(evt.toolName, evt.toolInput),
    outcome: failed ? 'failed' : 'ok',
  });

  // Post-tool questions only earn their latency when something went wrong, or
  // when the same action keeps coming back — the two cases that precede a loop.
  const session = loadSessionState(cfg, evt.sessionId);
  const summary = summarize(evt.toolName, evt.toolInput);
  const repeats = session.recent.filter((r) => r.summary === summary).length;
  if (!failed && repeats < 3) {
    return { decision: ALLOW(), meta: { skipped: 'post-tool-uneventful', repeats } };
  }

  const jev = await ask(cfg, {
    state: {
      user_goal: session.goal ?? '(not captured)',
      last_action: { tool: evt.toolName, input: sanitize(evt.toolInput, cfg) },
      last_result: sanitize(evt.toolResponse, cfg),
      recent_actions: session.recent,
      repeats_of_this_action: repeats,
    },
    questions: POST_TOOL_QUESTIONS,
  });

  let decision = decide({
    signals: jev.signals,
    thresholds: cfg.thresholds,
    severityAskFloor: cfg.severityAskFloor,
  });
  if (!jev.ok) decision = applyUnavailable(decision, cfg, jev.error ?? 'unknown');
  decision = applyMode(decision, cfg);

  const meta = { tool: evt.toolName, jev: jev.source, latencyMs: jev.latencyMs, failed, repeats };
  logDecision(cfg, { event: 'PostToolUse', session: evt.sessionId, harness: evt.harness, action: decision.action, rawAction: decision.rawAction, reasons: decision.reasons, ...meta });
  return { decision, meta };
}

async function stop(evt, cfg) {
  const session = loadSessionState(cfg, evt.sessionId);
  if (!session.goal || session.toolCalls === 0) {
    return { decision: ALLOW(), meta: { skipped: 'nothing-to-verify' } };
  }

  const jev = await ask(cfg, {
    state: {
      user_goal: session.goal,
      actions_taken: session.recent,
      total_tool_calls: session.toolCalls,
    },
    questions: STOP_QUESTIONS,
  });

  let decision = decide({
    signals: jev.signals,
    thresholds: cfg.thresholds,
    severityAskFloor: cfg.severityAskFloor,
  });
  if (!jev.ok) decision = applyUnavailable(decision, cfg, jev.error ?? 'unknown');
  decision = applyMode(decision, cfg);

  const meta = { jev: jev.source, latencyMs: jev.latencyMs, toolCalls: session.toolCalls };
  logDecision(cfg, { event: 'Stop', session: evt.sessionId, harness: evt.harness, action: decision.action, rawAction: decision.rawAction, reasons: decision.reasons, ...meta });
  return { decision, meta };
}
