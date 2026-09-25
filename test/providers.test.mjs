import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.mjs';
import { ask, resolveTarget } from '../src/jev-client.mjs';
import { listProviders, resolveProvider } from '../src/providers/index.mjs';
import { extractJson, questionsToJsonSchema, toJevAnswers } from '../src/providers/schema.mjs';
import { PRE_TOOL_QUESTIONS } from '../src/questions.mjs';
import { run } from '../src/run.mjs';

const QUESTIONS = {
  destructive: { type: 'noul', instructions: 'Does it destroy data?' },
  severity: { type: 'score', instructions: 'How bad?', criteria: ['mild', 'medium', 'bad', 'awful'] },
};

function scratchConfig(env = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'jev-providers-'));
  const cfg = loadConfig(dir, { JEV_GUARD_MODE: 'enforce', ...env });
  cfg.stateDir = join(dir, '.jev-guard');
  cfg.cacheTtlMs = 0;
  return { cfg, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** A server that records what it was sent and replies with a canned body. */
async function fakeApi(response, status = 200) {
  const seen = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      seen.push({ url: req.url, headers: req.headers, body: body ? JSON.parse(body) : null });
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(typeof response === 'function' ? response() : response));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  server.unref();
  const { port } = server.address();
  return {
    base: `http://127.0.0.1:${port}`,
    seen,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

// ---------------------------------------------------------------- schema ---

test('binary questions become probabilities and scores become bounded integers', () => {
  const schema = questionsToJsonSchema(QUESTIONS);
  assert.equal(schema.properties.destructive.type, 'number');
  assert.equal(schema.properties.severity.type, 'integer');
  assert.deepEqual(schema.properties.severity.enum, [1, 2, 3, 4]);
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.required.sort(), ['destructive', 'severity']);
});

test('answers outside the valid range are dropped, never clamped', () => {
  // A clamped 7 would read downstream as total certainty, which is a lie about
  // what the model said.
  assert.deepEqual(toJevAnswers({ destructive: 7 }, QUESTIONS), {});
  assert.deepEqual(toJevAnswers({ destructive: -0.5 }, QUESTIONS), {});
  assert.deepEqual(toJevAnswers({ severity: 9 }, QUESTIONS), {});
  assert.deepEqual(toJevAnswers({ severity: 2.5 }, QUESTIONS), {});
});

test('valid answers convert to the Jev shape', () => {
  const answers = toJevAnswers({ destructive: 0.82, severity: 3 }, QUESTIONS);
  assert.deepEqual(answers.destructive, { type: 'noul', noul: 0.82 });
  assert.deepEqual(answers.severity, { type: 'score', score: 3 });
});

test('a model that wraps its JSON in prose or a fence is still understood', () => {
  assert.deepEqual(extractJson('{"a":1}'), { a: 1 });
  assert.deepEqual(extractJson('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(extractJson('Sure! Here you go:\n{"a":1}\nHope that helps.'), { a: 1 });
  assert.equal(extractJson('no json here'), null);
  assert.equal(extractJson(null), null);
});

// -------------------------------------------------------------- registry ---

test('every listed provider resolves to one of the three wire protocols', () => {
  const kinds = new Set(listProviders().map((name) => resolveProvider(name, {}).kind));
  assert.deepEqual([...kinds].sort(), ['anthropic', 'google', 'jev', 'openai']);
});

test('the openai protocol covers most of the market', () => {
  for (const name of ['openai', 'deepseek', 'kimi', 'grok', 'mistral', 'groq', 'together', 'openrouter', 'ollama', 'vllm', 'lmstudio']) {
    assert.equal(resolveProvider(name, {}).kind, 'openai', `${name} should speak the openai protocol`);
  }
});

test('a provider key is read from any of its accepted env vars', () => {
  assert.equal(resolveProvider('kimi', { MOONSHOT_API_KEY: 'a' }).apiKey, 'a');
  assert.equal(resolveProvider('kimi', { KIMI_API_KEY: 'b' }).apiKey, 'b');
  assert.equal(resolveProvider('grok', { XAI_API_KEY: 'c' }).apiKey, 'c');
});

test('local runtimes are marked local and need no key', () => {
  for (const name of ['ollama', 'lmstudio', 'vllm', 'jevlab']) {
    assert.equal(resolveProvider(name, {}).local, true);
  }
  assert.equal(resolveProvider('openai', {}).local, false);
});

test('an unknown provider names the ones that exist', () => {
  assert.throws(() => resolveProvider('gpt9', {}), /unknown provider "gpt9"/);
});

// ------------------------------------------------------------ resolution ---

test('an untouched base url lets the provider preset fill it in', () => {
  const { cfg, cleanup } = scratchConfig({ JEV_GUARD_PROVIDER: 'deepseek', DEEPSEEK_API_KEY: 'k' });
  const target = resolveTarget(cfg);
  assert.equal(target.apiBase, 'https://api.deepseek.com/v1/chat/completions');
  cleanup();
});

test('an explicit base url always wins, which is what makes a gateway work', () => {
  const { cfg, cleanup } = scratchConfig({
    JEV_GUARD_PROVIDER: 'openai',
    JEV_GUARD_API_BASE: 'https://gateway.internal/v1/chat/completions',
    OPENAI_API_KEY: 'k',
  });
  assert.equal(resolveTarget(cfg).apiBase, 'https://gateway.internal/v1/chat/completions');
  cleanup();
});

// --------------------------------------------------------------- adapters ---

test('openai: the request constrains generation and the answer comes back typed', async () => {
  const api = await fakeApi({
    model: 'test-model',
    choices: [{ message: { content: '{"destructive":0.91,"severity":4}' } }],
  });
  const { cfg, cleanup } = scratchConfig({ JEV_GUARD_PROVIDER: 'openai', OPENAI_API_KEY: 'sk-test', JEV_GUARD_MODEL: 'gpt-test' });
  cfg.apiBase = `${api.base}/v1/chat/completions`;

  try {
    const result = await ask(cfg, { state: 'rm -rf /', questions: QUESTIONS });
    assert.equal(result.ok, true);
    assert.equal(result.signals.destructive, 0.91);
    assert.equal(result.severity, 4);
    assert.equal(result.provider, 'openai');

    const sent = api.seen[0];
    assert.equal(sent.headers.authorization, 'Bearer sk-test');
    assert.equal(sent.body.response_format.type, 'json_schema');
    assert.equal(sent.body.response_format.json_schema.strict, true);
    assert.equal(sent.body.temperature, 0);
  } finally {
    await api.close();
    cleanup();
  }
});

test('anthropic: strict tool use, auto tool choice, versioned header', async () => {
  const api = await fakeApi({
    model: 'claude-opus-5',
    content: [{ type: 'tool_use', name: 'record_assessment', input: { destructive: 0.2, severity: 1 } }],
  });
  const { cfg, cleanup } = scratchConfig({ JEV_GUARD_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'sk-ant' });
  cfg.apiBase = `${api.base}/v1/messages`;

  try {
    const result = await ask(cfg, { state: 'ls', questions: QUESTIONS });
    assert.equal(result.ok, true);
    assert.equal(result.signals.destructive, 0.2);
    assert.equal(result.model, 'claude-opus-5');

    const sent = api.seen[0];
    assert.equal(sent.headers['x-api-key'], 'sk-ant');
    assert.equal(sent.headers['anthropic-version'], '2023-06-01');
    assert.equal(sent.body.tools[0].strict, true);
    // Forced tool choice is rejected on some current models; auto plus a named
    // tool in the prompt works everywhere.
    assert.equal(sent.body.tool_choice.type, 'auto');
    assert.match(sent.body.messages[0].content, /record_assessment/);
  } finally {
    await api.close();
    cleanup();
  }
});

test('anthropic: a prose answer is still read rather than thrown away', async () => {
  const api = await fakeApi({
    model: 'claude-opus-5',
    content: [{ type: 'text', text: 'Here is my assessment:\n{"destructive":0.55,"severity":2}' }],
  });
  const { cfg, cleanup } = scratchConfig({ JEV_GUARD_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'sk-ant' });
  cfg.apiBase = `${api.base}/v1/messages`;

  try {
    const result = await ask(cfg, { state: 'ls', questions: QUESTIONS });
    assert.equal(result.signals.destructive, 0.55);
  } finally {
    await api.close();
    cleanup();
  }
});

test('google: the model goes in the path and the schema drops what gemini rejects', async () => {
  const api = await fakeApi({
    modelVersion: 'gemini-test',
    candidates: [{ content: { parts: [{ text: '{"destructive":0.33,"severity":2}' }] } }],
  });
  const { cfg, cleanup } = scratchConfig({ JEV_GUARD_PROVIDER: 'google', GEMINI_API_KEY: 'g-key', JEV_GUARD_MODEL: 'gemini-test' });
  cfg.apiBase = `${api.base}/v1beta/models`;

  try {
    const result = await ask(cfg, { state: 'ls', questions: QUESTIONS });
    assert.equal(result.ok, true);
    assert.equal(result.signals.destructive, 0.33);

    const sent = api.seen[0];
    assert.equal(sent.url, '/v1beta/models/gemini-test:generateContent');
    assert.equal(sent.headers['x-goog-api-key'], 'g-key');
    assert.equal(sent.body.generationConfig.responseSchema.additionalProperties, undefined);
    assert.equal(sent.body.generationConfig.responseMimeType, 'application/json');
  } finally {
    await api.close();
    cleanup();
  }
});

// ------------------------------------------------------------- failures ---

test('a provider with no model says so instead of guessing one', async () => {
  const { cfg, cleanup } = scratchConfig({ JEV_GUARD_PROVIDER: 'deepseek', DEEPSEEK_API_KEY: 'k' });
  const result = await ask(cfg, { state: 'ls', questions: QUESTIONS });
  assert.equal(result.ok, false);
  assert.match(result.error, /no model set for provider "deepseek" — set JEV_GUARD_MODEL/);
  cleanup();
});

test('a remote provider with no key fails clearly; a local one does not need one', async () => {
  const { cfg, cleanup } = scratchConfig({ JEV_GUARD_PROVIDER: 'grok', JEV_GUARD_MODEL: 'grok-test' });
  const remote = await ask(cfg, { state: 'ls', questions: QUESTIONS });
  assert.equal(remote.ok, false);
  assert.match(remote.error, /no API key for provider "grok"/);

  const { cfg: local, cleanup: cleanupLocal } = scratchConfig({
    JEV_GUARD_PROVIDER: 'ollama',
    JEV_GUARD_MODEL: 'llama-test',
  });
  local.timeoutMs = 300;
  const localResult = await ask(local, { state: 'ls', questions: QUESTIONS });
  // Nothing is listening, so it fails — but on connection, not on a missing key.
  assert.equal(localResult.ok, false);
  assert.doesNotMatch(localResult.error, /API key/);

  cleanup();
  cleanupLocal();
});

test('a 200 carrying no usable answer is a failure, not an all-clear', async () => {
  const api = await fakeApi({ choices: [{ message: { content: 'I would rather not say.' } }] });
  const { cfg, cleanup } = scratchConfig({ JEV_GUARD_PROVIDER: 'openai', OPENAI_API_KEY: 'k', JEV_GUARD_MODEL: 'm' });
  cfg.apiBase = `${api.base}/v1/chat/completions`;

  try {
    const result = await ask(cfg, { state: 'ls', questions: QUESTIONS });
    assert.equal(result.ok, false);
    assert.match(result.error, /no parseable answers/);
  } finally {
    await api.close();
    cleanup();
  }
});

// ------------------------------------------------------- cross-provider ---

test('one provider can be A/B tested against another on identical traffic', async () => {
  const incumbent = await fakeApi({
    model: 'jev-1.13.0',
    answers: { scope_creep: { type: 'noul', noul: 0.05 } },
  });
  const challenger = await fakeApi({
    model: 'gpt-test',
    choices: [{ message: { content: JSON.stringify({ scope_creep: 0.95, destructive: 0.01, secret_exposure: 0.01, exfiltration: 0.01, prompt_injection: 0.01, prod_impact: 0.01, severity: 2 }) } }],
  });

  const { cfg, cleanup } = scratchConfig({ TYPESAFE_API_KEY: 'jev-key', OPENAI_API_KEY: 'sk-test' });
  cfg.apiBase = `${incumbent.base}/v1/systemone`;
  cfg.compareProvider = 'openai';
  cfg.compareApiBase = `${challenger.base}/v1/chat/completions`;
  cfg.compareModel = 'gpt-test';

  try {
    const { decision, meta } = await run(
      { event: 'PreToolUse', sessionId: 'p1', cwd: '/repo', toolName: 'Bash', toolInput: { command: 'npx create-react-app site' }, harness: 'claude-code' },
      cfg,
    );

    assert.equal(decision.action, 'allow');        // Jev decided
    assert.equal(meta.compare.provider, 'openai'); // the challenger only watched
    assert.equal(meta.compare.action, 'ask');
    assert.equal(meta.compare.agrees, false);
    // Both were asked about exactly the same action.
    assert.match(challenger.seen[0].body.messages[1].content, /create-react-app site/);
    assert.equal(incumbent.seen[0].body.state.proposed_action.input.command, 'npx create-react-app site');
  } finally {
    await incumbent.close();
    await challenger.close();
    cleanup();
  }
});

test('the full question set survives a round trip through a general model', async () => {
  const answered = Object.fromEntries(
    Object.keys(PRE_TOOL_QUESTIONS).map((key) => [key, key === 'severity' ? 3 : 0.4]),
  );
  const api = await fakeApi({ choices: [{ message: { content: JSON.stringify(answered) } }] });
  const { cfg, cleanup } = scratchConfig({ JEV_GUARD_PROVIDER: 'kimi', MOONSHOT_API_KEY: 'k', JEV_GUARD_MODEL: 'kimi-test' });
  cfg.apiBase = `${api.base}/v1/chat/completions`;

  try {
    const result = await ask(cfg, { state: { tool: 'Bash' }, questions: PRE_TOOL_QUESTIONS });
    assert.equal(Object.keys(result.signals).length, 6);
    assert.equal(result.severity, 3);
  } finally {
    await api.close();
    cleanup();
  }
});
