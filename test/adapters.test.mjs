import test from 'node:test';
import assert from 'node:assert/strict';
import * as claude from '../adapters/claude-code.mjs';
import * as codex from '../adapters/codex.mjs';
import { DEFAULTS } from '../src/config.mjs';
import { applyMode, decide } from '../src/policy.mjs';

const thresholds = DEFAULTS.thresholds;
const at = (probability) => decide({ signals: { destructive: probability }, thresholds });

test('claude: allow prints nothing so the user permission flow still applies', () => {
  const out = claude.emit(at(0.05), { event: 'PreToolUse' });
  assert.equal(out.stdout, '');
  assert.equal(out.exitCode, 0);
});

test('claude: block becomes permissionDecision deny', () => {
  const out = claude.emit(at(0.95), { event: 'PreToolUse' });
  const parsed = JSON.parse(out.stdout);
  assert.equal(parsed.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.equal(parsed.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(parsed.hookSpecificOutput.permissionDecisionReason, /destructive=0\.95/);
  assert.equal(out.exitCode, 0);
});

test('claude: ask becomes permissionDecision ask', () => {
  const parsed = JSON.parse(claude.emit(at(0.65), { event: 'PreToolUse' }).stdout);
  assert.equal(parsed.hookSpecificOutput.permissionDecision, 'ask');
});

test('claude: warn carries context and no permission decision', () => {
  const parsed = JSON.parse(claude.emit(at(0.4), { event: 'PreToolUse' }).stdout);
  assert.equal(parsed.hookSpecificOutput.permissionDecision, undefined);
  assert.match(parsed.hookSpecificOutput.additionalContext, /jev-guard warn/);
});

test('claude: blocking a Stop uses exit code 2', () => {
  const out = claude.emit(at(0.95), { event: 'Stop' });
  assert.equal(out.exitCode, 2);
  assert.match(out.stderr, /destructive/);
});

test('claude: a shadowed block reports but does not deny', () => {
  const out = claude.emit(applyMode(at(0.95), { enforcing: false }), { event: 'PreToolUse' });
  const parsed = JSON.parse(out.stdout);
  assert.equal(parsed.hookSpecificOutput.permissionDecision, undefined);
  assert.match(parsed.hookSpecificOutput.additionalContext, /shadow: would block/);
  assert.equal(out.exitCode, 0);
});

test('codex: ask degrades to deny with an explicit next step', () => {
  const parsed = JSON.parse(codex.emit(at(0.65), { event: 'PreToolUse' }).stdout);
  assert.equal(parsed.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(parsed.hookSpecificOutput.permissionDecisionReason, /confirm with the user/);
});

test('codex: block denies without the confirm suffix', () => {
  const parsed = JSON.parse(codex.emit(at(0.95), { event: 'PreToolUse' }).stdout);
  assert.equal(parsed.hookSpecificOutput.permissionDecision, 'deny');
  assert.doesNotMatch(parsed.hookSpecificOutput.permissionDecisionReason, /confirm with the user/);
});

test('codex: PostToolUse escalation uses the decision/reason shape', () => {
  const parsed = JSON.parse(codex.emit(at(0.95), { event: 'PostToolUse' }).stdout);
  assert.equal(parsed.decision, 'block');
  assert.match(parsed.reason, /destructive/);
});

test('both adapters normalize their own payload dialect', () => {
  const fromClaude = claude.normalize({
    hook_event_name: 'PreToolUse',
    session_id: 's1',
    cwd: '/repo',
    tool_name: 'Bash',
    tool_input: { command: 'ls' },
    tool_response: { stdout: 'ok' },
  });
  assert.equal(fromClaude.harness, 'claude-code');
  assert.equal(fromClaude.toolName, 'Bash');
  assert.deepEqual(fromClaude.toolResponse, { stdout: 'ok' });

  const fromCodex = codex.normalize({
    hook_event_name: 'PreToolUse',
    turn_id: 't1',
    cwd: '/repo',
    tool_name: 'shell',
    tool_input: { command: 'ls' },
    tool_output: 'ok',
  });
  assert.equal(fromCodex.harness, 'codex');
  assert.equal(fromCodex.sessionId, 't1');
  assert.equal(fromCodex.toolResponse, 'ok');
});
