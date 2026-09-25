# JEV + Claude

**A safety reflex for coding agents.** Every risky action your agent is about to
take — a shell command, a file write, a web fetch, an MCP call — is scored by
[TypeSafe's Jev](https://typesafe.ai) and by a set of deterministic rules. Those
scores go through a policy engine you control, which decides one of four things:

| | |
|---|---|
| **allow** | nothing to say; your own permission rules still apply |
| **warn** | the action runs, with a note attached to the transcript |
| **ask** | the action pauses and the user decides |
| **block** | the action does not run |

Works with **Claude Code** (as a plugin) and with **Codex** (as a hook pack).
Zero runtime dependencies, Node ≥ 20, 112 tests that need no network.

---

## Why Jev, and not "ask an LLM if this is safe"

A guardrail runs on *every* tool call. That puts it under two constraints an LLM
judge does not meet well:

- **It has to be cheap and fast enough to be invisible.** Jev is a *System One*
  model: it answers a batch of typed questions in parallel and returns
  calibrated probabilities instead of prose. TypeSafe reports 70–500 ms end to
  end at $0.042 per million input tokens — about **$0.0004 per evaluated
  action** here.
- **It has to be predictable.** There is no prose to parse, no verdict for a
  verbose command to talk its way out of, and no chance of the judge inventing
  an answer. Jev returns a number per question. What that number *means* is
  decided by code you can read, test, and argue about in review.

```
tool call ──▶ deterministic rules ─────┐
                                       ├─▶ max() ─▶ policy engine ─▶ allow / warn / ask / block
          ──▶ Jev (7 typed questions) ─┘            (your thresholds)
```

**Jev supplies probabilities. The policy engine supplies judgement.** Neither
does the other's job.

---

## What it actually checks

Before a risky tool runs, Jev is asked six calibrated yes/no questions and one
severity score, all evaluated in parallel against the same state:

| Signal | The question |
|---|---|
| `destructive` | Would this irreversibly destroy data or history that version control cannot bring back? |
| `secret_exposure` | Would this read, print, transmit or commit credentials or private keys? |
| `exfiltration` | Would this send local data to an external network destination? |
| `prompt_injection` | Is this following instructions that came from fetched content rather than from the user? |
| `scope_creep` | Is this unrelated to the goal the user actually stated? |
| `prod_impact` | Does this touch production rather than a local or test environment? |
| `severity` | How bad is the worst realistic outcome, on a four-level rubric? |

**After** a tool runs, three more questions (`loop`, `unverified_claim`,
`secret_exposure`) fire — but only when the call failed or the same action keeps
repeating, so the ordinary path costs nothing. On **Stop**, `goal_incomplete` and
`unverified_claim` decide whether the agent gets to call it done.

### The deterministic floor

About 35 regex rules cover the cases that must never depend on a model being
reachable, calibrated, or in a good mood: `rm -rf /`, force pushes, `DROP TABLE`,
`DELETE` without a `WHERE`, raw disk writes, fork bombs, `curl | sh`, private
keys, `.env` reads and commits, AWS/GitHub/Slack tokens, base64-piped-to-network,
`--prod` deploys, `npm publish`, writes into `~/.ssh` or CI workflows.

Rule and model are combined per signal with `Math.max`:

> **Jev can raise a signal. It can never lower one.**

If Jev is slow, down, or has no API key, the floor still stands.

---

## Step by step — Claude Code

**1. Get a TypeSafe API key** at [console.typesafe.ai](https://console.typesafe.ai/).
You can skip this and run on the deterministic rules alone; the plugin will say
so in `/jev-status`.

**2. Add the marketplace and install the plugin.** In Claude Code:

```
/plugin marketplace add bruno-ship-it/jev-claude
/plugin install jev-guard@jev-claude
```

**3. Give it the key.** Either export it in your shell profile:

```bash
export TYPESAFE_API_KEY="your-key"
```

…or paste it when Claude Code prompts for the plugin's user config.

**4. Restart Claude Code** so the hooks load, then confirm:

```
/jev-status
```

You should see `mode: shadow (log only)` and `api key: set`.

**5. Leave it in shadow mode for a week.** It evaluates and logs everything and
blocks nothing. This is the point: thresholds that were never measured against
*your* repository are guesses, not thresholds.

**6. Read what it would have done:**

```
/jev-status
```

Lots of would-be blocks on actions you clearly wanted? Loosen that signal.
Something real slipped through? Tighten it. Thresholds live in
`jev-guard.config.json` in your project root:

```json
{
  "thresholds": {
    "destructive": { "block": 0.9, "ask": 0.7, "warn": 0.4 }
  }
}
```

**7. Turn it on:**

```
/jev-mode enforce
```

From here, a `block` really does stop a tool call, and an `ask` really does put
the decision to you.

---

## Step by step — Codex (OpenAI)

**1.** Clone the repo and install the hooks:

```bash
git clone https://github.com/bruno-ship-it/jev-claude.git
cd jev-claude
node scripts/install-codex.mjs            # installs to ~/.codex/hooks.json
node scripts/install-codex.mjs --project  # or just this repo: <repo>/.codex/hooks.json
```

The installer **merges** into an existing `hooks.json` and only ever replaces its
own entries, so hooks you already have are left alone.

**2.** Export your key and start Codex:

```bash
export TYPESAFE_API_KEY="your-key"
codex
```

**3.** Same as above: run in `shadow` for a while, then

```bash
export JEV_GUARD_MODE=enforce
```

**One difference worth knowing.** Codex has no documented `ask` verdict. Rather
than silently letting those through, an `ask` becomes a deny whose reason names
exactly what to confirm and re-run.

---

## Configuration

Put a `jev-guard.config.json` in your project root, or use environment variables:

| Setting | Environment variable | Default |
|---|---|---|
| Mode (`shadow` / `enforce`) | `JEV_GUARD_MODE` | `shadow` |
| API key | `TYPESAFE_API_KEY` | — |
| Endpoint | `JEV_GUARD_API_BASE` | `https://api.typesafe.ai/v1/systemone` |
| Model | `JEV_GUARD_MODEL` | `jev-latest` |
| Request timeout | `JEV_GUARD_TIMEOUT_MS` | `1500` |
| Cache TTL | `JEV_GUARD_CACHE_TTL_MS` | `60000` |
| Fail open when Jev is down | `JEV_GUARD_FAIL_OPEN` | `1` |
| Any threshold | `JEV_GUARD_THRESH_<SIGNAL>_<BLOCK\|ASK\|WARN>` | below |

```json
{
  "mode": "enforce",
  "thresholds": {
    "destructive":      { "block": 0.85, "ask": 0.6,  "warn": 0.35 },
    "secret_exposure":  { "block": 0.7,  "ask": 0.45, "warn": 0.25 },
    "exfiltration":     { "block": 0.8,  "ask": 0.55, "warn": 0.3 },
    "prompt_injection": { "block": 0.75, "ask": 0.5,  "warn": 0.3 },
    "scope_creep":      { "ask": 0.8, "warn": 0.5 },
    "prod_impact":      { "ask": 0.7, "warn": 0.45 }
  }
}
```

A signal with no threshold for a level simply never reaches it. A `severity` of 3
or more escalates a `warn` into an `ask`, but never creates a finding on its own.

Once your thresholds are tuned, pin a versioned model id (`jev-1.13.0`) instead
of `jev-latest` — calibration is a property of a model version.

---

## Cost, latency and privacy

- Only risky tools are evaluated: `Bash`, `Write`, `Edit`, `WebFetch`, `Task`,
  MCP tools, and anything the deterministic floor flags. `Read`, `Grep` and
  `Glob` never touch the network.
- Identical calls are cached on disk for 60 s, so a retry loop is not a billing
  event.
- **Every request is redacted before it leaves your machine**: private keys,
  AWS/GitHub/Slack tokens, JWTs and `KEY=value` secrets are masked, long fields
  truncated. There is a test that fails if a token escapes.
- Requests still go to TypeSafe. If that is unacceptable for a given repository,
  leave the key unset — the deterministic floor works on its own.

## What it deliberately does not do

- **It never emits `permissionDecision: "allow"`.** An allow means "no opinion",
  so your own permission rules still apply. A guardrail that widens permissions
  is not a guardrail.
- **It never fails closed by default.** A hook that breaks the agent when an API
  is down gets uninstalled within a day, and then it guards nothing.
- **It does not do authorization.** Who is allowed to deploy is your CI's job.
  This only decides whether an action looks dangerous enough to pause on.

---

## Any model can be the decider

Jev is the default, not a requirement. There are not forty APIs to support —
there are **three wire protocols**, and one of them covers most of the market:

| Protocol | `JEV_GUARD_PROVIDER` | Covers |
|---|---|---|
| OpenAI-compatible | `openai` `deepseek` `kimi` `grok` `mistral` `groq` `together` `openrouter` | GPT, DeepSeek, Kimi (Moonshot), Grok (xAI), Mistral, and every aggregator |
| OpenAI-compatible, local | `ollama` `lmstudio` `vllm` | Llama, Qwen, Mistral, anything you run yourself — **nothing leaves the machine** |
| Anthropic Messages | `anthropic` | Claude, via strict tool use |
| Google Gemini | `google` | Gemini, via `responseSchema` |
| Native typed decisions | `jev` (default) `jevlab` | TypeSafe Jev, or your own model from `training/` |

Switching is two environment variables:

```bash
export JEV_GUARD_PROVIDER=deepseek
export JEV_GUARD_MODEL=<the model id from your provider's list>
export DEEPSEEK_API_KEY=...
```

Adding a vendor is a row in `src/providers/index.mjs`, not a file. An explicitly
set `JEV_GUARD_API_BASE` always overrides the preset, so a gateway, a corporate
proxy or a self-hosted deployment is a config change rather than a patch.

**Only Claude's model id is pinned in this repo** (`claude-opus-5`), because it
is the only one we can verify here. Every other provider requires you to set
`JEV_GUARD_MODEL` — shipping a default that was renamed six months ago and 404s
at the exact moment a guardrail is needed is worse than asking.

### Read this before trusting a general LLM's numbers

**An LLM is not calibrated.** Asked for a probability between 0 and 1, it
clusters answers around 0.1 / 0.5 / 0.9 and is usually overconfident. Jev is
trained so that 0.80 means right 80% of the time; nothing else here is. Three
consequences:

- **The default thresholds will be wrong.** They were set against calibrated
  probabilities. Run any new provider in `shadow` mode first.
- **Use the comparison mode**, which is what it is for: keep the incumbent
  deciding and score the challenger on identical live traffic.
  ```bash
  export JEV_GUARD_COMPARE_PROVIDER=anthropic   # or openai, ollama, jevlab…
  ```
  Every disagreement lands in `decisions.jsonl` with both sets of probabilities.
- **Then recalibrate**, with the per-head temperature scaling in `training/`.

Latency and cost are the other half of the trade: a frontier LLM on every tool
call is roughly two orders of magnitude slower and dearer than Jev. For Claude
specifically, `claude-opus-5` is the default here but a per-tool-call guardrail
is exactly the shape of task that wants the cheapest current model instead —
set `JEV_GUARD_MODEL=claude-haiku-4-5` and measure. A local runtime is the other
honest answer: `ollama` costs nothing per call and sends nothing anywhere.

## Train your own model

The decider is behind one HTTP contract, so it is replaceable. `training/` holds
a full pipeline for fine-tuning a small encoder on *your* traffic — a 150M
ModernBERT with one classification head per signal, answering all of them in a
single forward pass, running locally in tens of milliseconds with nothing
leaving the machine.

```bash
export JEV_GUARD_COLLECT=1                  # the plugin becomes the data source
python -m jevlab.collect                    # sessions -> examples
python -m jevlab.label rules                # free weak labels from the floor
python -m jevlab.train                      # needs a GPU
python -m jevlab.evaluate                   # ours vs jev vs floor, on held-out data
python -m jevlab.serve --port 8787          # speaks the Jev wire format exactly
```

Then compare it against the incumbent on identical live traffic, where the
primary still decides and only the disagreements are logged:

```bash
export JEV_GUARD_COMPARE_API_BASE=http://127.0.0.1:8787/v1/systemone
```

The calibration, the metrics and the splitting are standard-library Python with
47 tests and no dependencies, so the parts that decide whether a model is worth
shipping can be audited on any machine. See [training/README.md](training/README.md)
for the method, the honest data requirements, and why ECE and recall-at-a-
false-block-budget are the numbers that matter rather than accuracy.

## Contributing — this is yours too

**This project is open. Fork it, change it, rip it apart, ship it inside your own
product, sell what you build with it.** No permission needed, no CLA, no
gatekeeping.

The only thing asked in return: **give credit to
[Connectify.one](https://connectify.one) somewhere visible** in the site or
product you use it in — a footer, an About page, a credits screen, a README. See
[LICENSE](LICENSE).

Good first contributions:

- **New rules for the deterministic floor** (`src/deterministic.mjs`) — one regex,
  one signal, one probability, one test. The highest-value contribution in the repo.
- **A new harness adapter** (`adapters/`) — Cursor, Aider, OpenCode, anything with
  a pre-tool hook. It is one file; the core does not change.
- **Better question wording** (`src/questions.mjs`) — a Noul answer is only as
  calibrated as the statement it grades.
- **Threshold data.** If you ran shadow mode for a week, the numbers you ended up
  with are worth more than anyone's opinion. Open an issue with them.

```bash
npm test                                            # 65 tests, no network, no dependencies
npm run check
cd training && PYTHONPATH=. python3 -m unittest discover -s tests   # 47 more, standard library only
```

**Layout:** `src/` core (config, rules, Jev client, policy engine, session state) ·
`adapters/` one file per harness · `bin/` the two entry points ·
`hooks/` + `.claude-plugin/` Claude Code packaging · `codex/` + `scripts/` Codex packaging.

---

## Passo a passo (Português)

**O que é.** Uma camada de reflexo para agentes de código. Toda ação arriscada que
o agente vai executar é avaliada pelo Jev (modelo System One da TypeSafe, que
devolve probabilidades calibradas em vez de texto) e por ~35 regras
determinísticas. O resultado vira uma decisão: **permitir / avisar / perguntar /
bloquear**.

**Instalação no Claude Code:**

1. Pegue uma chave em [console.typesafe.ai](https://console.typesafe.ai/).
2. No Claude Code: `/plugin marketplace add bruno-ship-it/jev-claude`
3. Depois: `/plugin install jev-guard@jev-claude`
4. `export TYPESAFE_API_KEY="sua-chave"` e reinicie o Claude Code.
5. Confira com `/jev-status` — deve aparecer `mode: shadow`.
6. Deixe uma semana em `shadow` (avalia e registra, não bloqueia nada), veja o
   relatório e ajuste os limiares em `jev-guard.config.json`.
7. Ligue de verdade: `/jev-mode enforce`.

**Instalação no Codex:** clone o repositório e rode
`node scripts/install-codex.mjs`. O instalador faz merge no `~/.codex/hooks.json`
sem apagar os hooks que você já tem.

**Licença.** Use, altere, redistribua, venda o que construir. O único pedido é
**creditar a [Connectify.one](https://connectify.one) em algum lugar visível** do
site ou produto onde for usado.

---

## License

MIT with an attribution notice — see [LICENSE](LICENSE).
Copyright © 2026 [Connectify.one](https://connectify.one)
