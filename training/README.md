# jevlab — train your own System One model

A pipeline for training a decision model specialised on one narrow question:
**is this action a coding agent is about to take dangerous?**

Nothing here is a general-purpose Jev replacement, and it is not trying to be.
The bet is narrower and much more winnable: a 150M-parameter encoder trained on
*your* traffic can beat a general model on *your* distribution, while running
locally in tens of milliseconds with no network call and no data leaving the
machine.

## Why this is achievable

A System One model is architecturally unremarkable. An autoregressive LLM
answers six questions by generating six answers in sequence; a bidirectional
encoder with six classification heads reads the state once and answers all six
in one forward pass. That is where the order of magnitude in latency comes from
— not from anything proprietary.

What is actually hard is **calibration** (making 0.80 mean 80%) and **labels**.
This pipeline is mostly about those two.

The evidence that the narrow bet works is already public: the open
[Verdict/OpenJev](https://github.com/Heman10x-NGU/Verdict-open-jev) project puts
a 151M ModernBERT at **0.021 ECE against Jev's 0.144** on a public typed-decision
benchmark — and then loses badly, 48% to 91% accuracy, on TypeSafe's own broad
evaluation. Both results are real. Specialists win on their slice and lose
everywhere else, which is exactly the trade worth making for a guardrail that
only ever sees tool calls.

## The honest starting position

**No trained model ships with this repo.** What ships is the pipeline, the
metrics, and the comparison harness. You need data before any of it produces a
model, and the plugin is what produces the data.

## The pipeline

### 1. Collect

Run the plugin in shadow mode with collection on. It writes the goal, the
redacted action, the deterministic-floor probabilities and whatever Jev answered.

```bash
export JEV_GUARD_MODE=shadow
export JEV_GUARD_COLLECT=1
# …then just work for a week
python -m jevlab.collect --state-dir .jev-guard --out data/examples.jsonl
```

Collection is opt-in because it keeps more of your session on disk than a
guardrail needs. Actions are redacted before they are written, but treat
`data/examples.jsonl` as sensitive anyway — it is a record of real work.

### 2. Label

Three sources, cheapest first:

```bash
python -m jevlab.label rules    --examples data/examples.jsonl   # free, high precision
python -m jevlab.label distill  --out data/requests.jsonl        # send to any LLM
python -m jevlab.label ingest   --answers data/answers.jsonl     # merge the answers back
python -m jevlab.label review   --examples data/examples.jsonl   # a human, on the hard ones
python -m jevlab.label stats
```

`rules` labels what the regex floor already fired on — a free head of the
distribution, and worthless as a test set: measuring a model against it only
proves it learned the regexes you already have. Keep rule-labelled examples out
of your headline numbers.

`distill` writes provider-agnostic prompt files; no API key or vendor lives in
the training code. Pipe them through whichever model you like and feed the JSON
back through `ingest`.

### 3. Train

```bash
pip install -r requirements.txt
python -m jevlab.train --data data/examples.jsonl --out runs/latest
```

ModernBERT-base by default, one binary head per signal plus a 4-level severity
head, `cross-entropy + Brier` per head. The Brier term is what makes the
probability numerically right rather than merely well-ranked. Missing labels are
masked, never imputed as negatives — that shortcut is how a rare-signal head
learns to always say no.

Needs a GPU to be pleasant. About 2k labelled examples is the floor for the
common signals; rare ones (`exfiltration`, `prompt_injection`) need deliberate
collection or synthesis, because they will not show up often enough on their own.

### 4. Calibrate and compare

```bash
python -m jevlab.predict  --run-dir runs/latest --out runs/latest/predictions.jsonl --raw
python -m jevlab.evaluate --predictions runs/latest/predictions.jsonl
```

Temperatures are fitted **per head** on the calibration split and reported on the
test split — never the same split, or the number you publish is the one you
optimised. The output scores three predictors side by side on identical
examples: **ours**, **jev** (what it answered at capture time) and **floor** (the
regexes). If the regexes win, ship the regexes.

### 5. Serve and A/B in production

```bash
python -m jevlab.export_onnx --run-dir runs/latest
python -m jevlab.serve --run-dir runs/latest --port 8787
```

`serve` speaks the Jev wire format exactly, so the plugin needs no new client:

```bash
# use it as the decider
export JEV_GUARD_API_BASE=http://127.0.0.1:8787/v1/systemone

# or, better first: keep Jev deciding and score the challenger on the same traffic
export JEV_GUARD_COMPARE_API_BASE=http://127.0.0.1:8787/v1/systemone
export JEV_GUARD_COMPARE_MODEL=jevlab-local
```

In compare mode both endpoints are asked in parallel, the primary decides, and
every disagreement lands in `decisions.jsonl` with both sets of probabilities. A
challenger earns its way in on recorded traffic.

## What "better" has to mean

Accuracy is the wrong headline number for a guardrail. `evaluate` reports:

| Metric | What it answers |
|---|---|
| **ECE** (quantile-binned) | when it says 0.80, is it right 80% of the time? |
| **Brier** | the proper scoring rule — ranking *and* magnitude |
| **AUROC** | ranking alone, unchanged by calibration by construction |
| **recall @ false-block budget** | if I accept blocking 1% of harmless actions, what share of harmful ones do I catch? |

The last one is the product metric, because the two errors do not cost the same:
a wrong block costs a developer a minute, a wrong allow costs a production table.

## What runs without a GPU

Everything except `train`, `predict`, `serve` and `export_onnx`. The collector,
the splitter, the metrics and the calibration are standard-library Python:

```bash
PYTHONPATH=. python3 -m unittest discover -s tests    # 47 tests, no dependencies
```

That is deliberate. The parts that decide whether a model is worth shipping
should be auditable by anyone, on any machine, without installing a framework.

## Layout

| File | Role |
|---|---|
| `schema.py` | the signals, the questions, and `render_state` — the one serializer training and serving must share |
| `collect.py` | plugin session logs → examples |
| `label.py` | rules / distillation / human review |
| `dataset.py` | group-aware, stratified, leak-free splits |
| `model.py` | encoder + one head per question |
| `train.py` | the loop |
| `metrics.py` | ECE, Brier, AUROC, recall @ budget |
| `calibrate.py` | per-head temperature scaling |
| `evaluate.py` | ours vs jev vs floor, on the test split |
| `export_onnx.py`, `runtime.py`, `serve.py`, `predict.py` | inference |

One rule worth repeating: `render_state` is the contract. If training and serving
ever serialize an example differently, nothing will tell you — the model will
simply be wrong in production and fine in the notebook.
