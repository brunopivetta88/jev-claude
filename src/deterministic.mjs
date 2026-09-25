/**
 * The deterministic floor.
 *
 * Jev supplies probabilities; these rules supply certainty about the handful
 * of cases that must never depend on a model being reachable, calibrated, or
 * in a good mood. Floor values are combined with Jev's via Math.max, so a
 * model answer can raise a signal but never lower one.
 */

/** @type {[RegExp, string, number, string][]} pattern, signal, probability, label */
const RULES = [
  // --- irreversible destruction -------------------------------------------
  [/\brm\s+(-[a-z]*[rf][a-z]*\s+)+(\/(\s|$|["'`])|\/\*|~(\/|\s|$|["'`])|\$HOME)/i, 'destructive', 0.99, 'rm -rf against / or $HOME'],
  [/\brm\s+(-[a-z]*[rf][a-z]*\s+)/i, 'destructive', 0.55, 'recursive/forced rm'],
  [/\bgit\s+push\b[^\n]*\s(--force|-f)\b/i, 'destructive', 0.8, 'force push'],
  [/\bgit\s+reset\s+--hard\b/i, 'destructive', 0.6, 'git reset --hard'],
  [/\bgit\s+clean\s+-[a-z]*f/i, 'destructive', 0.7, 'git clean -f'],
  [/\b(DROP|TRUNCATE)\s+(TABLE|DATABASE|SCHEMA)\b/i, 'destructive', 0.9, 'DROP/TRUNCATE statement'],
  [/\bDELETE\s+FROM\s+[\w."`]+\s*(;|$)/i, 'destructive', 0.9, 'DELETE without WHERE'],
  [/\b(mkfs(\.\w+)?|dd\s+if=\S+\s+of=\/dev\/)/i, 'destructive', 0.95, 'raw disk write'],
  [/:\(\)\s*\{\s*:\|:&\s*\}\s*;:/, 'destructive', 0.99, 'fork bomb'],
  [/\bkubectl\s+delete\b/i, 'destructive', 0.7, 'kubectl delete'],
  [/\bdocker\s+system\s+prune\b[^\n]*-a/i, 'destructive', 0.6, 'docker system prune -a'],
  [/\bsupabase\s+db\s+reset\b/i, 'destructive', 0.85, 'supabase db reset'],
  [/\bcurl\b[^\n|]*\|\s*(sudo\s+)?(ba)?sh\b/i, 'destructive', 0.8, 'remote script piped into a shell'],
  [/\bwget\b[^\n|]*\|\s*(sudo\s+)?(ba)?sh\b/i, 'destructive', 0.8, 'remote script piped into a shell'],

  // --- secret exposure -----------------------------------------------------
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'secret_exposure', 0.95, 'private key material'],
  [/\bAKIA[0-9A-Z]{16}\b/, 'secret_exposure', 0.95, 'AWS access key id'],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}\b/, 'secret_exposure', 0.9, 'GitHub token'],
  [/\b(cat|less|more|head|tail|bat)\s+[^\n]*\.env\b/i, 'secret_exposure', 0.8, 'reading a .env file'],
  [/\bgit\s+add\b[^\n]*\.env\b/i, 'secret_exposure', 0.9, 'staging a .env file'],
  [/\becho\s+\$\{?[A-Z_]*(SECRET|TOKEN|KEY|PASSWORD)/i, 'secret_exposure', 0.75, 'echoing a secret env var'],
  [/\bSERVICE_ROLE_KEY\b/i, 'secret_exposure', 0.7, 'Supabase service role key'],
  [/\.ssh\/(id_\w+|authorized_keys)\b/, 'secret_exposure', 0.8, 'SSH key material'],

  // --- exfiltration --------------------------------------------------------
  [/\bcurl\b[^\n]*(-d\s+@|--data-binary\s+@|-F\s+\w+=@)/i, 'exfiltration', 0.75, 'uploading a local file'],
  [/\b(nc|ncat|netcat)\s+[\w.-]+\s+\d+/i, 'exfiltration', 0.7, 'raw netcat connection'],
  [/\bscp\s+[^\n]*@/i, 'exfiltration', 0.6, 'scp to a remote host'],
  [/\bbase64\b[^\n|]*\|[^\n]*\b(curl|wget|nc)\b/i, 'exfiltration', 0.85, 'base64 piped to the network'],

  // --- production blast radius --------------------------------------------
  [/\b(NODE_ENV|VITE_ENV|ENVIRONMENT)\s*=\s*production\b/i, 'prod_impact', 0.7, 'production environment flag'],
  [/\bvercel\b[^\n]*--prod\b/i, 'prod_impact', 0.85, 'production deploy'],
  [/\b(fly|flyctl)\s+deploy\b/i, 'prod_impact', 0.7, 'fly deploy'],
  [/\bsupabase\s+(db\s+push|migration\s+up)\b[^\n]*--(project-ref|linked)\b/i, 'prod_impact', 0.8, 'migration against a linked project'],
  [/\bnpm\s+publish\b/i, 'prod_impact', 0.8, 'npm publish'],
];

/** Paths whose modification is treated as sensitive regardless of content. */
const SENSITIVE_PATHS = [
  [/(^|\/)\.env(\.|$)/, 'secret_exposure', 0.7, 'writing to a .env file'],
  [/(^|\/)\.git\/config$/, 'destructive', 0.6, 'rewriting .git/config'],
  [/(^|\/)\.ssh\//, 'secret_exposure', 0.85, 'writing into ~/.ssh'],
  [/(^|\/)\.claude\/settings(\.local)?\.json$/, 'destructive', 0.6, 'rewriting Claude Code settings'],
  [/(^|\/)(\.github\/workflows)\//, 'prod_impact', 0.6, 'editing CI workflows'],
];

/**
 * @typedef {{ signals: Record<string, number>, matches: {signal: string, label: string, probability: number}[] }} FloorResult
 */

/**
 * @param {{ toolName?: string, text: string, filePath?: string }} input
 * @returns {FloorResult}
 */
export function deterministicFloor({ toolName, text, filePath }) {
  const signals = {};
  const matches = [];

  const record = (signal, probability, label) => {
    signals[signal] = Math.max(signals[signal] ?? 0, probability);
    matches.push({ signal, label, probability });
  };

  const haystack = String(text ?? '');
  for (const [pattern, signal, probability, label] of RULES) {
    if (pattern.test(haystack)) record(signal, probability, label);
  }

  const path = filePath ?? '';
  if (path) {
    for (const [pattern, signal, probability, label] of SENSITIVE_PATHS) {
      if (pattern.test(path)) record(signal, probability, label);
    }
  }

  // A web fetch of a non-https URL can be tampered with in transit.
  if (toolName === 'WebFetch' && /^http:\/\//i.test(haystack)) {
    record('prompt_injection', 0.4, 'plain-http fetch');
  }

  return { signals, matches };
}

/**
 * Merge two signal maps, keeping the higher probability per signal.
 * @param {Record<string, number>} a
 * @param {Record<string, number>} b
 */
export function mergeSignals(a = {}, b = {}) {
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) out[k] = Math.max(out[k] ?? 0, v);
  return out;
}
