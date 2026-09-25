import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.mjs';
import { answersToSignals } from '../src/jev-client.mjs';
import { redactText, sanitize } from '../src/redact.mjs';
import { run } from '../src/run.mjs';
import { readDecisions } from '../src/state.mjs';

function scratchConfig(env = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'jev-guard-'));
  const cfg = loadConfig(dir, { JEV_GUARD_MODE: 'enforce', ...env });
  cfg.stateDir = join(dir, '.jev-guard');
  cfg.cacheTtlMs = 0; // every test asks for itself
  return { cfg, dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** A stand-in Jev that records what it was asked and answers on command. */
async function fakeJev(answers) {
  const seen = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      seen.push(JSON.parse(body));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ model: 'jev-1.13.0', answers, usage: { input_tokens: 10, output_tokens: 2 } }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  server.unref();
  return {
    url: `http://127.0.0.1:${port}/v1/systemone`,
    seen,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

test('redaction masks credentials but keeps the shape readable', () => {
  assert.match(redactText('export AWS_KEY=AKIAIOSFODNN7EXAMPLE'), /REDACTED:aws-access-key-id/);
  assert.match(redactText('API_SECRET_TOKEN=hunter2hunter2'), /API_SECRET_TOKEN=\[REDACTED:env-secret\]/);
  const clean = redactText('npm run build');
  assert.equal(clean, 'npm run build');
});

test('sanitize walks nested tool input', () => {
  const out = sanitize({ command: 'echo ghp_abcdefghijklmnopqrstuvwxyz0123', nested: { list: ['AKIAIOSFODNN7EXAMPLE'] } });
  assert.match(out.command, /REDACTED:github-token/);
  assert.match(out.nested.list[0], /REDACTED:aws-access-key-id/);
});

test('answersToSignals separates noul probabilities from the severity score', () => {
  const { signals, severity } = answersToSignals({
    destructive: { type: 'noul', noul: 0.82 },
    severity: { type: 'score', score: 3, confidence: 0.9 },
    topic: { type: 'choice', choice: 'billing' },
  });
  assert.deepEqual(signals, { destructive: 0.82 });
  assert.equal(severity, 3);
});

test('the deterministic floor blocks even with no API key', async () => {
  const { cfg, cleanup } = scratchConfig();
  const { decision } = await run(
    { event: 'PreToolUse', sessionId: 's1', cwd: '/repo', toolName: 'Bash', toolInput: { command: 'rm -rf /' }, harness: 'claude-code' },
    cfg,
  );
  assert.equal(decision.action, 'block');
  assert.match(decision.reasons[0].source, /^rule:/);
  cleanup();
});

test('ordinary work is allowed and leaves the network alone', async () => {
  const { cfg, cleanup } = scratchConfig();
  const { decision } = await run(
    { event: 'PreToolUse', sessionId: 's2', cwd: '/repo', toolName: 'Read', toolInput: { file_path: 'src/App.tsx' }, harness: 'claude-code' },
    cfg,
  );
  assert.equal(decision.action, 'allow');
  cleanup();
});

test('the goal from UserPromptSubmit reaches the state Jev is asked about', async () => {
  const jev = await fakeJev({ scope_creep: { type: 'noul', noul: 0.92 } });
  const { cfg, cleanup } = scratchConfig({ TYPESAFE_API_KEY: 'test-key' });
  cfg.apiBase = jev.url;

  try {

    await run({ event: 'UserPromptSubmit', sessionId: 's3', cwd: '/repo', prompt: 'fix the invoice total rounding', harness: 'claude-code' }, cfg);
    const { decision } = await run(
      { event: 'PreToolUse', sessionId: 's3', cwd: '/repo', toolName: 'Bash', toolInput: { command: 'npx create-react-app marketing-site' }, harness: 'claude-code' },
      cfg,
    );

    assert.equal(jev.seen.length, 1);
    assert.equal(jev.seen[0].model, 'jev-latest');
    assert.equal(jev.seen[0].state.user_goal, 'fix the invoice total rounding');
    assert.equal(jev.seen[0].questions.destructive.type, 'noul');
    assert.equal(decision.action, 'ask'); // scope_creep 0.92 >= ask 0.80
  } finally {
    await jev.close();
    cleanup();
  }
});

test('secrets in a tool call never leave the machine', async () => {
  const jev = await fakeJev({});
  const { cfg, cleanup } = scratchConfig({ TYPESAFE_API_KEY: 'test-key' });
  cfg.apiBase = jev.url;

  try {

    await run(
      { event: 'PreToolUse', sessionId: 's4', cwd: '/repo', toolName: 'Bash', toolInput: { command: 'deploy --token ghp_abcdefghijklmnopqrstuvwxyz0123' }, harness: 'claude-code' },
      cfg,
    );

    const sent = JSON.stringify(jev.seen[0]);
    assert.doesNotMatch(sent, /ghp_abcdefghijklmnopqrstuvwxyz0123/);
    assert.match(sent, /REDACTED:github-token/);
  } finally {
    await jev.close();
    cleanup();
  }
});

test('a jev answer and a floor match combine, strongest wins', async () => {
  const jev = await fakeJev({ destructive: { type: 'noul', noul: 0.1 }, severity: { type: 'score', score: 1 } });
  const { cfg, cleanup } = scratchConfig({ TYPESAFE_API_KEY: 'test-key' });
  cfg.apiBase = jev.url;

  try {

    const { decision } = await run(
      { event: 'PreToolUse', sessionId: 's5', cwd: '/repo', toolName: 'Bash', toolInput: { command: 'git push --force origin main' }, harness: 'claude-code' },
      cfg,
    );
    // Jev said 0.10; the force-push rule says 0.80. The model may raise a
    // signal, never lower one — so this lands on ask (0.80 >= ask 0.60),
    // where a bare Jev answer would have allowed it outright.
    assert.equal(decision.signals.destructive, 0.8);
    assert.equal(decision.action, 'ask');
    assert.equal(decision.reasons[0].source, 'rule: force push');
  } finally {
    await jev.close();
    cleanup();
  }
});

test('an unreachable Jev fails open and is recorded as such', async () => {
  const { cfg, cleanup } = scratchConfig({ TYPESAFE_API_KEY: 'test-key' });
  cfg.apiBase = 'http://127.0.0.1:1/v1/systemone';
  cfg.timeoutMs = 300;

  const { decision } = await run(
    { event: 'PreToolUse', sessionId: 's6', cwd: '/repo', toolName: 'Bash', toolInput: { command: 'npm test' }, harness: 'claude-code' },
    cfg,
  );
  assert.equal(decision.action, 'allow');

  const logged = readDecisions(cfg, 5).at(-1);
  assert.equal(logged.jev, 'unavailable');
  assert.ok(logged.error);
  cleanup();
});

test('Stop is only evaluated once there is a goal and some work', async () => {
  const { cfg, cleanup } = scratchConfig({ TYPESAFE_API_KEY: 'test-key' });
  cfg.apiBase = 'http://127.0.0.1:1/v1/systemone';
  const { decision } = await run({ event: 'Stop', sessionId: 's7', cwd: '/repo', harness: 'claude-code' }, cfg);
  assert.equal(decision.action, 'allow');
  cleanup();
});

test('an internal failure degrades to allow rather than taking the agent down', async () => {
  const { decision } = await run(
    { event: 'PreToolUse', sessionId: 's8', cwd: '/repo', toolName: 'Bash', toolInput: { command: 'ls' }, harness: 'claude-code' },
    /** @type {any} */ (null),
  );
  assert.equal(decision.action, 'allow');
});

test('with collection on, the session log carries what the trainer needs', async () => {
  const jev = await fakeJev({ destructive: { type: 'noul', noul: 0.42 } });
  const { cfg, dir, cleanup } = scratchConfig({ TYPESAFE_API_KEY: 'test-key', JEV_GUARD_COLLECT: '1' });
  cfg.apiBase = jev.url;

  try {
    await run({ event: 'UserPromptSubmit', sessionId: 'c1', cwd: '/repo', prompt: 'ship the invoice fix', harness: 'claude-code' }, cfg);
    await run(
      { event: 'PreToolUse', sessionId: 'c1', cwd: '/repo', toolName: 'Bash', toolInput: { command: 'git push --force origin main' }, harness: 'claude-code' },
      cfg,
    );

    const lines = readFileSync(join(cfg.stateDir, 'state', 'c1.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    const tool = lines.find((l) => l.kind === 'tool');
    assert.equal(tool.action.command, 'git push --force origin main');
    assert.equal(tool.floor.destructive, 0.8);
    assert.equal(tool.jev.destructive, 0.42);
    assert.equal(tool.cwd, '/repo');
  } finally {
    await jev.close();
    cleanup();
  }
});

test('collection stays off unless it is asked for', async () => {
  const { cfg, cleanup } = scratchConfig();
  await run(
    { event: 'PreToolUse', sessionId: 'c2', cwd: '/repo', toolName: 'Bash', toolInput: { command: 'echo hi' }, harness: 'claude-code' },
    cfg,
  );
  const tool = readFileSync(join(cfg.stateDir, 'state', 'c2.jsonl'), 'utf8').trim().split('\n').map(JSON.parse).find((l) => l.kind === 'tool');
  assert.equal(tool.action, undefined);
  assert.equal(tool.floor, undefined);
  cleanup();
});

test('a rival endpoint is scored on the same traffic but never decides', async () => {
  const incumbent = await fakeJev({ scope_creep: { type: 'noul', noul: 0.05 } });
  const challenger = await fakeJev({ scope_creep: { type: 'noul', noul: 0.95 } });
  const { cfg, cleanup } = scratchConfig({ TYPESAFE_API_KEY: 'test-key' });
  cfg.apiBase = incumbent.url;
  cfg.compareApiBase = challenger.url;
  cfg.compareModel = 'jevlab-local';

  try {
    const { decision, meta } = await run(
      { event: 'PreToolUse', sessionId: 'c3', cwd: '/repo', toolName: 'Bash', toolInput: { command: 'npx create-react-app site' }, harness: 'claude-code' },
      cfg,
    );

    assert.equal(decision.action, 'allow');           // the incumbent decided
    assert.equal(meta.compare.action, 'ask');          // the challenger would not have
    assert.equal(meta.compare.agrees, false);
    assert.equal(meta.compare.signals.scope_creep, 0.95);
    assert.equal(challenger.seen[0].model, 'jevlab-local');
    assert.deepEqual(challenger.seen[0].state, incumbent.seen[0].state); // identical traffic

    const logged = readDecisions(cfg, 5).at(-1);
    assert.equal(logged.compare.agrees, false);
  } finally {
    await incumbent.close();
    await challenger.close();
    cleanup();
  }
});

test('a rival that is down costs nothing but a logged error', async () => {
  const incumbent = await fakeJev({ destructive: { type: 'noul', noul: 0.1 } });
  const { cfg, cleanup } = scratchConfig({ TYPESAFE_API_KEY: 'test-key' });
  cfg.apiBase = incumbent.url;
  cfg.compareApiBase = 'http://127.0.0.1:1/v1/systemone';
  cfg.timeoutMs = 300;

  try {
    const { decision, meta } = await run(
      { event: 'PreToolUse', sessionId: 'c4', cwd: '/repo', toolName: 'Bash', toolInput: { command: 'npm test' }, harness: 'claude-code' },
      cfg,
    );
    assert.equal(decision.action, 'allow');
    assert.equal(meta.compare.ok, false);
    assert.ok(meta.compare.error);
  } finally {
    await incumbent.close();
    cleanup();
  }
});
