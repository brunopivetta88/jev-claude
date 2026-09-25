import { explain } from '../src/policy.mjs';

/**
 * Codex (OpenAI) adapter.
 *
 * Codex speaks nearly the same hook dialect as Claude Code — snake_case JSON in,
 * `hookSpecificOutput` out, exit 2 to block — with one difference that matters:
 * there is no documented "ask" verdict. An `ask` therefore becomes a deny whose
 * reason tells the user what to confirm and re-run, rather than being silently
 * downgraded to an allow.
 */

export const HARNESS = 'codex';

/** @param {Record<string, any>} payload */
export function normalize(payload) {
  return {
    event: payload.hook_event_name,
    sessionId: payload.session_id ?? payload.turn_id ?? 'unknown',
    cwd: payload.cwd ?? process.cwd(),
    toolName: payload.tool_name,
    toolInput: payload.tool_input,
    toolResponse: payload.tool_response ?? payload.tool_output ?? payload.tool_result,
    prompt: payload.prompt ?? payload.user_prompt,
    harness: HARNESS,
  };
}

/**
 * @param {import('../src/policy.mjs').Decision} decision
 * @param {{event: string}} evt
 * @returns {{ stdout: string, stderr: string, exitCode: number }}
 */
export function emit(decision, evt) {
  const reason = explain(decision, { prefix: 'jev-guard' });

  if (decision.action === 'allow') {
    // Empty stdout is Codex's "proceed unchanged"; shadow findings go to the
    // transcript as context rather than to stderr, which Codex surfaces louder.
    if (!decision.shadowed) return { stdout: '', stderr: '', exitCode: 0 };
    return {
      stdout: JSON.stringify({
        hookSpecificOutput: { hookEventName: evt.event, additionalContext: reason },
      }),
      stderr: '',
      exitCode: 0,
    };
  }

  if (evt.event === 'Stop') {
    return { stdout: '', stderr: reason, exitCode: 2 };
  }

  if (evt.event === 'PostToolUse') {
    if (decision.action === 'warn') {
      return {
        stdout: JSON.stringify({
          hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: reason },
        }),
        stderr: '',
        exitCode: 0,
      };
    }
    return { stdout: JSON.stringify({ decision: 'block', reason }), stderr: '', exitCode: 0 };
  }

  if (decision.action === 'warn') {
    return {
      stdout: JSON.stringify({
        hookSpecificOutput: { hookEventName: evt.event, additionalContext: reason },
      }),
      stderr: '',
      exitCode: 0,
    };
  }

  const suffix = decision.action === 'ask' ? ' — confirm with the user, then re-run if intended' : '';
  return {
    stdout: JSON.stringify({
      hookSpecificOutput: {
        hookEventName: evt.event === 'PermissionRequest' ? 'PermissionRequest' : 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: `${reason}${suffix}`,
      },
    }),
    stderr: '',
    exitCode: 0,
  };
}
