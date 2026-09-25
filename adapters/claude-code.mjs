import { explain } from '../src/policy.mjs';

/**
 * Claude Code adapter.
 *
 * Input: hook JSON on stdin. Output: hook JSON on stdout, exit 2 to block a
 * Stop. `allow` deliberately prints nothing — emitting permissionDecision
 * "allow" would bypass the user's own permission rules, which is not the
 * guardrail's call to make.
 */

export const HARNESS = 'claude-code';

/** @param {Record<string, any>} payload */
export function normalize(payload) {
  return {
    event: payload.hook_event_name,
    sessionId: payload.session_id ?? 'unknown',
    cwd: payload.cwd ?? process.cwd(),
    toolName: payload.tool_name,
    toolInput: payload.tool_input,
    toolResponse: payload.tool_response ?? payload.tool_result,
    prompt: payload.prompt,
    harness: HARNESS,
  };
}

/**
 * @param {import('../src/policy.mjs').Decision} decision
 * @param {{event: string}} evt
 * @returns {{ stdout: string, stderr: string, exitCode: number }}
 */
export function emit(decision, evt) {
  const reason = explain(decision);
  const none = { stdout: '', stderr: '', exitCode: 0 };

  if (decision.action === 'allow' && !decision.shadowed) return none;

  // Shadow mode never blocks, but it still has something to say.
  if (decision.action === 'allow') {
    return {
      stdout: JSON.stringify({
        hookSpecificOutput: {
          hookEventName: evt.event,
          additionalContext: reason,
        },
        suppressOutput: true,
      }),
      stderr: '',
      exitCode: 0,
    };
  }

  if (evt.event === 'Stop') {
    // Exit 2 on Stop is what keeps the turn going; the reason reaches Claude.
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

  // PreToolUse
  if (decision.action === 'warn') {
    return {
      stdout: JSON.stringify({
        hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: reason },
      }),
      stderr: '',
      exitCode: 0,
    };
  }

  return {
    stdout: JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: decision.action === 'block' ? 'deny' : 'ask',
        permissionDecisionReason: reason,
      },
    }),
    stderr: '',
    exitCode: 0,
  };
}
