/**
 * Jev sees the tool call, so anything secret in it would leave the machine.
 * Redaction runs before the request is built, never after.
 */

const SECRET_PATTERNS = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, 'private-key'],
  [/\bAKIA[0-9A-Z]{16}\b/g, 'aws-access-key-id'],
  [/\bASIA[0-9A-Z]{16}\b/g, 'aws-session-key-id'],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, 'github-token'],
  [/\bsk-[A-Za-z0-9_-]{20,}\b/g, 'api-secret-key'],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, 'slack-token'],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, 'jwt'],
  [/\b(?:[A-Za-z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|APIKEY|API_KEY|PRIVATE_KEY))\s*[=:]\s*["']?([^\s"';]{8,})/gi, 'env-secret'],
];

const MAX_FIELD_CHARS = 4000;

/** @param {string} text */
export function redactText(text) {
  let out = String(text);
  for (const [pattern, label] of SECRET_PATTERNS) {
    out = out.replace(pattern, (match, ...rest) => {
      // Patterns without a capture group get the offset as the second argument,
      // so the group has to be identified by type, not by position.
      const captured = typeof rest[0] === 'string' ? rest[0] : null;
      // For KEY=value shapes keep the key name and mask only the value.
      return captured ? match.replace(captured, `[REDACTED:${label}]`) : `[REDACTED:${label}]`;
    });
  }
  return out;
}

/** @param {string} text */
export function truncate(text, max = MAX_FIELD_CHARS) {
  const s = String(text);
  if (s.length <= max) return s;
  return `${s.slice(0, max)}\n…[truncated ${s.length - max} chars]`;
}

/**
 * Deep-redacts a tool input object and caps its size.
 * @param {unknown} value
 * @param {{ redact?: boolean }} [opts]
 */
export function sanitize(value, opts = {}) {
  const redact = opts.redact !== false;
  const walk = (node, depth) => {
    if (depth > 6) return '[depth-limit]';
    if (typeof node === 'string') return truncate(redact ? redactText(node) : node);
    if (Array.isArray(node)) return node.slice(0, 50).map((v) => walk(v, depth + 1));
    if (node && typeof node === 'object') {
      const out = {};
      for (const [k, v] of Object.entries(node).slice(0, 50)) out[k] = walk(v, depth + 1);
      return out;
    }
    return node;
  };
  return walk(value, 0);
}

/**
 * Flattens a tool input for logging and hashing.
 * @param {unknown} toolInput
 */
export function flatten(toolInput) {
  if (toolInput == null) return '';
  if (typeof toolInput === 'string') return toolInput;
  try {
    return JSON.stringify(toolInput);
  } catch {
    return String(toolInput);
  }
}

/**
 * The text the deterministic rules are matched against.
 *
 * JSON.stringify would wrap a command in quotes and escape its newlines, which
 * quietly breaks any rule anchored on whitespace or end-of-line — `rm -rf /`
 * becomes `rm -rf /"}`. Collecting the string leaves and joining them with real
 * newlines keeps the rules matching what the user would actually type.
 *
 * @param {unknown} toolInput
 */
export function textForRules(toolInput) {
  if (toolInput == null) return '';
  if (typeof toolInput === 'string') return toolInput;
  const parts = [];
  const walk = (node, depth) => {
    if (depth > 6 || parts.length > 200) return;
    if (typeof node === 'string') parts.push(node);
    else if (typeof node === 'number' || typeof node === 'boolean') parts.push(String(node));
    else if (Array.isArray(node)) node.slice(0, 50).forEach((v) => walk(v, depth + 1));
    else if (node && typeof node === 'object') {
      for (const [k, v] of Object.entries(node).slice(0, 50)) {
        parts.push(k);
        walk(v, depth + 1);
      }
    }
  };
  walk(toolInput, 0);
  return parts.join('\n');
}
