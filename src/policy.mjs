/**
 * The policy engine.
 *
 * Jev supplies probabilities. This file supplies judgement: which probability,
 * crossing which line, earns which outcome. Nothing here calls the network, so
 * every decision is reproducible from its inputs — that is what makes the
 * thresholds arguable in review instead of mysterious in production.
 */

export const RANK = { allow: 0, warn: 1, ask: 2, block: 3 };
const LEVELS = /** @type {const} */ (['block', 'ask', 'warn']);

/** @param {string} a @param {string} b */
export function strongest(a, b) {
  return RANK[a] >= RANK[b] ? a : b;
}

/**
 * @typedef {Object} Decision
 * @property {'allow'|'warn'|'ask'|'block'} action   what the harness should do
 * @property {'allow'|'warn'|'ask'|'block'} rawAction what the policy decided before shadow mode
 * @property {{signal: string, probability: number, level: string, source: string}[]} reasons
 * @property {Record<string, number>} signals
 * @property {number|null} severity
 * @property {boolean} shadowed
 */

/**
 * @param {Object} input
 * @param {Record<string, number>} input.signals   merged Jev + floor probabilities
 * @param {number|null} [input.severity]
 * @param {Record<string, {block?: number, ask?: number, warn?: number}>} input.thresholds
 * @param {number} [input.severityAskFloor]
 * @param {{signal: string, label: string, probability: number}[]} [input.floorMatches]
 * @returns {Decision}
 */
export function decide({ signals, severity = null, thresholds, severityAskFloor = 3, floorMatches = [] }) {
  const labels = new Map();
  for (const m of floorMatches) {
    if (!labels.has(m.signal)) labels.set(m.signal, m.label);
  }

  let action = 'allow';
  const reasons = [];

  for (const [signal, probability] of Object.entries(signals)) {
    const limits = thresholds[signal];
    if (!limits || typeof probability !== 'number') continue;

    for (const level of LEVELS) {
      const limit = limits[level];
      if (typeof limit !== 'number' || probability < limit) continue;
      reasons.push({
        signal,
        probability,
        level,
        source: labels.has(signal) ? `rule: ${labels.get(signal)}` : 'jev',
      });
      action = strongest(action, level);
      break; // Only the strongest level this signal earned.
    }
  }

  // A high severity score does not create a finding on its own, but it does
  // stop a borderline one from being waved through with a note.
  if (action === 'warn' && typeof severity === 'number' && severity >= severityAskFloor) {
    action = 'ask';
    reasons.push({ signal: 'severity', probability: severity, level: 'ask', source: 'jev' });
  }

  reasons.sort((a, b) => RANK[b.level] - RANK[a.level] || b.probability - a.probability);
  return { action, rawAction: action, reasons, signals, severity, shadowed: false };
}

/**
 * Shadow mode keeps every decision visible and none of them binding.
 * @param {Decision} decision
 * @param {{ enforcing: boolean }} cfg
 * @returns {Decision}
 */
export function applyMode(decision, cfg) {
  if (cfg.enforcing || decision.action === 'allow') return decision;
  return { ...decision, action: 'allow', rawAction: decision.action, shadowed: true };
}

/**
 * What to do when Jev could not answer. The deterministic floor has already
 * run by this point, so fail-open still leaves the hard rules in force.
 * @param {Decision} decision
 * @param {{ failOpen: boolean }} cfg
 * @param {string} error
 * @returns {Decision}
 */
export function applyUnavailable(decision, cfg, error) {
  if (cfg.failOpen) return decision;
  return {
    ...decision,
    action: strongest(decision.action, 'ask'),
    rawAction: strongest(decision.rawAction, 'ask'),
    reasons: [
      { signal: 'jev_unavailable', probability: 1, level: 'ask', source: `fail-closed: ${error}` },
      ...decision.reasons,
    ],
  };
}

/** Human-readable one-liner for the reason shown to the agent or the user. */
export function explain(decision, { prefix = 'jev-guard' } = {}) {
  if (!decision.reasons.length) return `${prefix}: no signal crossed a threshold`;
  const parts = decision.reasons.slice(0, 4).map((r) => {
    const value = r.signal === 'severity' ? `level ${r.probability}` : r.probability.toFixed(2);
    return `${r.signal}=${value} (${r.source}) → ${r.level}`;
  });
  const head = decision.shadowed
    ? `${prefix} [shadow: would ${decision.rawAction}]`
    : `${prefix} ${decision.action}`;
  return `${head}: ${parts.join('; ')}`;
}
