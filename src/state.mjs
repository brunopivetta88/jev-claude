import { appendFileSync, mkdirSync, openSync, readSync, closeSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Session memory, append-only.
 *
 * Each hook invocation is its own short-lived process, so anything the policy
 * needs to know about earlier turns has to survive on disk. JSONL keeps writes
 * atomic enough for concurrent tool calls and stays greppable afterwards.
 */

const TAIL_BYTES = 256 * 1024;
const RECENT_ACTIONS = 8;

function sessionFile(cfg, sessionId) {
  return join(cfg.stateDir, 'state', `${sanitizeId(sessionId)}.jsonl`);
}

function sanitizeId(id) {
  return String(id ?? 'unknown').replace(/[^\w.-]/g, '_').slice(0, 120);
}

function appendJsonl(path, record) {
  try {
    mkdirSync(join(path, '..'), { recursive: true });
    appendFileSync(path, `${JSON.stringify(record)}\n`);
  } catch {
    // Losing a state line is survivable; failing the tool call is not.
  }
}

/** Reads at most the last TAIL_BYTES of a JSONL file, dropping a partial first line. */
function readTail(path) {
  let fd;
  try {
    const { size } = statSync(path);
    const start = Math.max(0, size - TAIL_BYTES);
    const length = size - start;
    if (length === 0) return [];
    const buffer = Buffer.alloc(length);
    fd = openSync(path, 'r');
    readSync(fd, buffer, 0, length, start);
    const lines = buffer.toString('utf8').split('\n');
    if (start > 0) lines.shift();
    return lines
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** @param {{stateDir: string}} cfg */
export function recordEvent(cfg, sessionId, record) {
  appendJsonl(sessionFile(cfg, sessionId), { at: new Date().toISOString(), ...record });
}

/**
 * Folds the session log into the compact state Jev is asked to judge against.
 * @returns {{ goal: string|null, recent: {tool: string, summary: string, outcome?: string}[], toolCalls: number }}
 */
export function loadSessionState(cfg, sessionId) {
  const events = readTail(sessionFile(cfg, sessionId));
  let goal = null;
  const recent = [];
  let toolCalls = 0;

  for (const event of events) {
    if (event.kind === 'goal' && event.text) goal = event.text;
    if (event.kind === 'tool') {
      toolCalls += 1;
      recent.push({ tool: event.tool, summary: event.summary, outcome: event.outcome });
    }
  }

  return { goal, recent: recent.slice(-RECENT_ACTIONS), toolCalls };
}

/** Decision audit trail, shared across sessions so `/jev-status` can summarise it. */
export function logDecision(cfg, record) {
  appendJsonl(join(cfg.stateDir, 'decisions.jsonl'), { at: new Date().toISOString(), ...record });
}

/** @returns {{at: string}[]} most recent decisions, newest last */
export function readDecisions(cfg, limit = 20) {
  return readTail(join(cfg.stateDir, 'decisions.jsonl')).slice(-limit);
}
