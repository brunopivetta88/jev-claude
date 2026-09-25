"""Loading a trained model for inference, from torch or from ONNX.

ONNX is the one that matters in production: it runs on CPU in tens of
milliseconds with no Python-side model framework, which is what lets the guard
run on every tool call without a network round trip.
"""

from __future__ import annotations

import json
from pathlib import Path

from .schema import SEVERITY_LEVELS, SIGNALS

EPS = 1e-6


def _sigmoid(z: float) -> float:
    import math

    if z >= 0:
        return 1 / (1 + math.exp(-z))
    exp_z = math.exp(z)
    return exp_z / (1 + exp_z)


def _softmax(values: list[float]) -> list[float]:
    import math

    top = max(values)
    exps = [math.exp(v - top) for v in values]
    total = sum(exps)
    return [e / total for e in exps]


def _apply_temperature(probability: float, temperature: float) -> float:
    import math

    if temperature == 1.0:
        return probability
    p = min(max(probability, EPS), 1 - EPS)
    return _sigmoid(math.log(p / (1 - p)) / temperature)


class Runtime:
    """Scores rendered states. Backend is chosen by what is on disk and installed."""

    def __init__(self, run_dir: Path, max_length: int = 384):
        self.run_dir = Path(run_dir)
        self.max_length = max_length
        self.temperatures = self._load_temperatures()
        self.backend, self.session, self.tokenizer, self.model_id = self._load()

    def _load_temperatures(self) -> dict[str, float]:
        path = self.run_dir / "temperatures.json"
        if not path.exists():
            return {}
        try:
            return {k: float(v) for k, v in json.loads(path.read_text()).items()}
        except (json.JSONDecodeError, ValueError):
            return {}

    def _load(self):
        from transformers import AutoTokenizer

        onnx_path = self.run_dir / "model.onnx"
        meta_path = self.run_dir / "meta.json"
        base_model = "answerdotai/ModernBERT-base"
        if meta_path.exists():
            base_model = json.loads(meta_path.read_text()).get("base_model", base_model)

        tokenizer = AutoTokenizer.from_pretrained(base_model)

        if onnx_path.exists():
            import onnxruntime as ort

            session = ort.InferenceSession(str(onnx_path), providers=["CPUExecutionProvider"])
            return "onnx", session, tokenizer, f"jevlab-onnx-{self.run_dir.name}"

        import torch

        from .model import ModelConfig, SystemOneModel

        checkpoint = torch.load(self.run_dir / "model.pt", map_location="cpu")
        model = SystemOneModel(ModelConfig(**checkpoint["config"]))
        model.load_state_dict(checkpoint["state_dict"])
        model.eval()
        return "torch", model, tokenizer, f"jevlab-torch-{self.run_dir.name}"

    def score(self, texts: list[str]) -> list[dict]:
        encoded = self.tokenizer(
            texts, truncation=True, max_length=self.max_length, padding=True, return_tensors="np"
        )

        if self.backend == "onnx":
            outputs = self.session.run(
                None,
                {
                    "input_ids": encoded["input_ids"].astype("int64"),
                    "attention_mask": encoded["attention_mask"].astype("int64"),
                },
            )
            names = [o.name for o in self.session.get_outputs()]
            raw = dict(zip(names, outputs))
            signal_logits = {s: raw[s].reshape(-1).tolist() for s in SIGNALS}
            severity_logits = raw["severity"].tolist()
        else:
            import torch

            with torch.no_grad():
                logits = self.session(
                    torch.tensor(encoded["input_ids"]), torch.tensor(encoded["attention_mask"])
                )
            signal_logits = {s: logits[s].reshape(-1).tolist() for s in SIGNALS}
            severity_logits = logits["severity"].tolist()

        results = []
        for index in range(len(texts)):
            signals = {}
            for signal in SIGNALS:
                probability = _sigmoid(signal_logits[signal][index])
                signals[signal] = _apply_temperature(
                    probability, self.temperatures.get(signal, 1.0)
                )
            distribution = _softmax(list(severity_logits[index]))
            severity = max(range(len(SEVERITY_LEVELS)), key=lambda i: distribution[i])
            results.append(
                {
                    "signals": signals,
                    "severity": severity,
                    "severity_probabilities": distribution,
                }
            )
        return results
