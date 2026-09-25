import { SYSTEM_PROMPT, extractJson, questionsToJsonSchema, renderPrompt, toJevAnswers } from './schema.mjs';

/**
 * Providers.
 *
 * There are not forty APIs to support — there are three wire protocols, and one
 * of them covers most of the market:
 *
 *   openai     OpenAI, DeepSeek, Kimi (Moonshot), Grok (xAI), Mistral, Groq,
 *              Together, Fireworks, OpenRouter, and every local runtime worth
 *              using: Ollama, vLLM, LM Studio, llama.cpp
 *   anthropic  Claude (strict tool use — no logprobs, no prefill)
 *   google     Gemini
 *   jev        TypeSafe's native typed-decision endpoint
 *
 * Adding a vendor is a row in PRESETS, not a file.
 *
 * One thing to be honest about: only `jev` returns *calibrated* probabilities.
 * A general LLM asked for a number between 0 and 1 clusters its answers around
 * 0.1 / 0.5 / 0.9 and is usually overconfident. The thresholds tuned for Jev
 * will be wrong. Run a new provider in shadow mode, then recalibrate with the
 * temperature scaling in training/.
 */

const ANTHROPIC_VERSION = '2023-06-01';

/** @typedef {{kind: string, apiBase: string, model: string|null, keyEnv: string[], note?: string}} Preset */

/** @type {Record<string, Preset>} */
export const PRESETS = {
  jev: {
    kind: 'jev',
    apiBase: 'https://api.typesafe.ai/v1/systemone',
    model: 'jev-latest',
    keyEnv: ['TYPESAFE_API_KEY'],
  },
  // The only provider whose model id is pinned here, because it is the only one
  // this repo can verify. Everywhere else, set JEV_GUARD_MODEL yourself rather
  // than trust a default that may have been renamed since.
  anthropic: {
    kind: 'anthropic',
    apiBase: 'https://api.anthropic.com/v1/messages',
    model: 'claude-opus-5',
    keyEnv: ['ANTHROPIC_API_KEY'],
  },
  openai: {
    kind: 'openai',
    apiBase: 'https://api.openai.com/v1/chat/completions',
    model: null,
    keyEnv: ['OPENAI_API_KEY'],
  },
  deepseek: {
    kind: 'openai',
    apiBase: 'https://api.deepseek.com/v1/chat/completions',
    model: null,
    keyEnv: ['DEEPSEEK_API_KEY'],
  },
  kimi: {
    kind: 'openai',
    apiBase: 'https://api.moonshot.ai/v1/chat/completions',
    model: null,
    keyEnv: ['MOONSHOT_API_KEY', 'KIMI_API_KEY'],
  },
  grok: {
    kind: 'openai',
    apiBase: 'https://api.x.ai/v1/chat/completions',
    model: null,
    keyEnv: ['XAI_API_KEY', 'GROK_API_KEY'],
  },
  mistral: {
    kind: 'openai',
    apiBase: 'https://api.mistral.ai/v1/chat/completions',
    model: null,
    keyEnv: ['MISTRAL_API_KEY'],
  },
  groq: {
    kind: 'openai',
    apiBase: 'https://api.groq.com/openai/v1/chat/completions',
    model: null,
    keyEnv: ['GROQ_API_KEY'],
  },
  together: {
    kind: 'openai',
    apiBase: 'https://api.together.xyz/v1/chat/completions',
    model: null,
    keyEnv: ['TOGETHER_API_KEY'],
  },
  openrouter: {
    kind: 'openai',
    apiBase: 'https://openrouter.ai/api/v1/chat/completions',
    model: null,
    keyEnv: ['OPENROUTER_API_KEY'],
  },
  google: {
    kind: 'google',
    apiBase: 'https://generativelanguage.googleapis.com/v1beta/models',
    model: null,
    keyEnv: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'],
  },
  // Local runtimes. No key, no network leaving the machine — the best answer to
  // "I cannot send my shell commands to a vendor".
  ollama: {
    kind: 'openai',
    apiBase: 'http://127.0.0.1:11434/v1/chat/completions',
    model: null,
    keyEnv: [],
    note: 'local',
  },
  lmstudio: {
    kind: 'openai',
    apiBase: 'http://127.0.0.1:1234/v1/chat/completions',
    model: null,
    keyEnv: [],
    note: 'local',
  },
  vllm: {
    kind: 'openai',
    apiBase: 'http://127.0.0.1:8000/v1/chat/completions',
    model: null,
    keyEnv: [],
    note: 'local',
  },
  // Our own trained model, served by training/jevlab/serve.py. It speaks the
  // Jev wire format, so it needs no adapter of its own.
  jevlab: {
    kind: 'jev',
    apiBase: 'http://127.0.0.1:8787/v1/systemone',
    model: 'jevlab-local',
    keyEnv: [],
    note: 'local',
  },
};

export function listProviders() {
  return Object.keys(PRESETS);
}

/**
 * @param {string} name
 * @param {NodeJS.ProcessEnv} env
 * @returns {{name: string, kind: string, apiBase: string, model: string|null, apiKey: string, local: boolean}}
 */
export function resolveProvider(name, env = process.env) {
  const preset = PRESETS[name];
  if (!preset) {
    throw new Error(`unknown provider "${name}". Known: ${listProviders().join(', ')}`);
  }
  const apiKey = preset.keyEnv.map((key) => env[key]).find(Boolean) ?? '';
  return {
    name,
    kind: preset.kind,
    apiBase: preset.apiBase,
    model: preset.model,
    apiKey,
    local: preset.note === 'local',
  };
}

const ADAPTERS = {
  jev: {
    headers: ({ apiKey }) => (apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    url: ({ apiBase }) => apiBase,
    body: ({ model }, { state, questions }) => ({ model, state, questions }),
    parse: (json) => ({ answers: json.answers ?? {}, model: json.model ?? null, usage: json.usage ?? null }),
  },

  openai: {
    headers: ({ apiKey }) => (apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    url: ({ apiBase }) => apiBase,
    body: ({ model }, { state, questions }) => ({
      model,
      // Temperature 0 is not calibration, but it at least makes the same action
      // score the same way twice, which the cache and any A/B depend on.
      temperature: 0,
      max_tokens: 400,
      response_format: {
        type: 'json_schema',
        json_schema: { name: 'action_assessment', strict: true, schema: questionsToJsonSchema(questions) },
      },
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: renderPrompt(state, questions) },
      ],
    }),
    parse: (json, questions) => ({
      answers: toJevAnswers(extractJson(json?.choices?.[0]?.message?.content), questions),
      model: json.model ?? null,
      usage: json.usage ?? null,
    }),
  },

  anthropic: {
    headers: ({ apiKey }) => ({ 'x-api-key': apiKey, 'anthropic-version': ANTHROPIC_VERSION }),
    url: ({ apiBase }) => apiBase,
    body: ({ model }, { state, questions }) => ({
      model,
      max_tokens: 2048,
      // A typed classification is a simple task; effort low keeps a per-tool-call
      // hook from costing more thinking than the action it is guarding.
      output_config: { effort: 'low' },
      // tool_choice stays "auto" with the tool named in the prompt instead of
      // forced: forced tool choice is rejected on some current models, and
      // strict already guarantees the arguments validate.
      tool_choice: { type: 'auto' },
      tools: [
        {
          name: 'record_assessment',
          description: 'Record the typed assessment of the proposed action.',
          strict: true,
          input_schema: questionsToJsonSchema(questions),
        },
      ],
      messages: [
        {
          role: 'user',
          content: `${SYSTEM_PROMPT}\n\n${renderPrompt(state, questions)}\n\nCall the record_assessment tool with your answers.`,
        },
      ],
    }),
    parse: (json, questions) => {
      const blocks = Array.isArray(json.content) ? json.content : [];
      const call = blocks.find((block) => block.type === 'tool_use');
      // Some turns answer in prose instead of calling the tool; the text is
      // still worth parsing rather than discarding the whole response.
      const payload = call ? call.input : extractJson(blocks.find((b) => b.type === 'text')?.text);
      return { answers: toJevAnswers(payload, questions), model: json.model ?? null, usage: json.usage ?? null };
    },
  },

  google: {
    headers: ({ apiKey }) => ({ 'x-goog-api-key': apiKey }),
    url: ({ apiBase, model }) =>
      apiBase.includes(':generateContent') ? apiBase : `${apiBase}/${model}:generateContent`,
    body: (_provider, { state, questions }) => ({
      systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
      contents: [{ role: 'user', parts: [{ text: renderPrompt(state, questions) }] }],
      generationConfig: {
        temperature: 0,
        responseMimeType: 'application/json',
        responseSchema: stripUnsupported(questionsToJsonSchema(questions)),
      },
    }),
    parse: (json, questions) => {
      const text = json?.candidates?.[0]?.content?.parts?.map((p) => p.text).join('') ?? '';
      return {
        answers: toJevAnswers(extractJson(text), questions),
        model: json.modelVersion ?? null,
        usage: json.usageMetadata ?? null,
      };
    },
  },
};

/** Gemini's schema dialect rejects `additionalProperties`. */
function stripUnsupported(schema) {
  const { additionalProperties, ...rest } = schema;
  return rest;
}

export function adapterFor(kind) {
  const adapter = ADAPTERS[kind];
  if (!adapter) throw new Error(`no adapter for provider kind "${kind}"`);
  return adapter;
}
