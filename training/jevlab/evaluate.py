"""Score our model against the alternatives on the same held-out split.

This is the file that decides whether "improved" is a claim or a fact. It scores
three predictors side by side on identical examples:

  ours   — the fine-tuned model, after per-head temperature scaling
  jev    — whatever Jev answered at capture time, if it was recorded
  floor  — the deterministic regex probabilities, as a baseline

A baseline of regexes is not a joke: on a narrow distribution it is often
competitive, and if it wins there is no reason to ship a model at all.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from .calibrate import apply_per_head, fit_per_head
from .dataset import load, split as split_examples
from .metrics import summary
from .schema import SIGNALS, Example

PREDICTORS = ("ours", "jev", "floor")


def gather(examples: list[Example], source: str, predictions: dict[str, dict[str, float]] | None):
    """(probs, labels) per signal for one predictor, over the examples it covers."""
    out: dict[str, tuple[list[float], list[float]]] = {}
    for signal in SIGNALS:
        probs: list[float] = []
        labels: list[float] = []
        for example in examples:
            if signal not in example.labels:
                continue
            if source == "ours":
                value = (predictions or {}).get(example.id, {}).get(signal)
            elif source == "jev":
                value = example.jev.get(signal)
            else:
                value = example.floor.get(signal, 0.0)
            if value is None:
                continue
            probs.append(float(value))
            labels.append(float(example.labels[signal]))
        if probs:
            out[signal] = (probs, labels)
    return out


def load_predictions(path: Path | None) -> dict[str, dict[str, float]]:
    """`{"id": ..., "signals": {...}}` per line, as written by serve.py --dump."""
    if not path or not path.exists():
        return {}
    predictions: dict[str, dict[str, float]] = {}
    with path.open("r", encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if not line:
                continue
            record = json.loads(line)
            predictions[record["id"]] = {
                k: float(v) for k, v in (record.get("signals") or {}).items()
            }
    return predictions


def table(rows: dict[str, dict[str, float]], budget: float) -> str:
    key = f"recall_at_{budget:g}_fpr"
    header = f"{'signal':<18}{'n':>6}{'brier':>9}{'ECE':>8}{'AUROC':>8}{'recall@fpr':>12}"
    lines = [header, "─" * len(header)]
    for signal, stats in rows.items():
        lines.append(
            f"{signal:<18}{stats['n']:>6}{stats['brier']:>9.4f}"
            f"{stats['ece_quantile']:>8.4f}{stats['auroc']:>8.3f}{stats[key]:>12.3f}"
        )
    return "\n".join(lines)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data", type=Path, default=Path("data/examples.jsonl"))
    parser.add_argument("--predictions", type=Path, default=None, help="our model's outputs")
    parser.add_argument("--budget", type=float, default=0.01, help="false-block budget (FPR)")
    parser.add_argument("--temperatures-out", type=Path, default=Path("runs/latest/temperatures.json"))
    args = parser.parse_args()

    examples = load(args.data)
    splits = split_examples(examples)
    predictions = load_predictions(args.predictions)

    # Fit the temperatures on calib, report on test. Never the other way round.
    calib = gather(splits.calib, "ours", predictions)
    temperatures = fit_per_head(
        {signal: probs for signal, (probs, _) in calib.items()},
        {signal: labels for signal, (_, labels) in calib.items()},
    )
    if temperatures:
        args.temperatures_out.parent.mkdir(parents=True, exist_ok=True)
        args.temperatures_out.write_text(json.dumps(temperatures, indent=2))
        print("temperatures (fitted on calib):")
        for signal, value in temperatures.items():
            direction = "overconfident" if value > 1 else "underconfident"
            print(f"  {signal:<18} T={value:.3f}  ({direction} before scaling)")

    print()
    for source in PREDICTORS:
        rows = gather(splits.test, source, predictions)
        if not rows:
            print(f"[{source}] no predictions on the test split — skipped\n")
            continue
        if source == "ours" and temperatures:
            scaled = apply_per_head({s: p for s, (p, _) in rows.items()}, temperatures)
            rows = {s: (scaled[s], labels) for s, (_, labels) in rows.items()}
        stats = {signal: summary(probs, labels, args.budget) for signal, (probs, labels) in rows.items()}
        print(f"[{source}] test split, false-block budget {args.budget:g}")
        print(table(stats, args.budget))
        mean_ece = sum(s["ece_quantile"] for s in stats.values()) / len(stats)
        mean_brier = sum(s["brier"] for s in stats.values()) / len(stats)
        print(f"{'mean':<18}{'':>6}{mean_brier:>9.4f}{mean_ece:>8.4f}\n")


if __name__ == "__main__":
    main()
