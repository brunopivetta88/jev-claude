"""Batch-score a dataset, writing the predictions evaluate.py consumes."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from .dataset import load
from .runtime import Runtime
from .schema import render_state


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data", type=Path, default=Path("data/examples.jsonl"))
    parser.add_argument("--run-dir", type=Path, default=Path("runs/latest"))
    parser.add_argument("--out", type=Path, default=Path("runs/latest/predictions.jsonl"))
    parser.add_argument("--batch-size", type=int, default=32)
    parser.add_argument("--raw", action="store_true", help="skip temperature scaling")
    args = parser.parse_args()

    runtime = Runtime(args.run_dir)
    if args.raw:
        runtime.temperatures = {}
    examples = load(args.data)

    args.out.parent.mkdir(parents=True, exist_ok=True)
    with args.out.open("w", encoding="utf-8") as handle:
        for start in range(0, len(examples), args.batch_size):
            batch = examples[start : start + args.batch_size]
            for example, scored in zip(batch, runtime.score([render_state(e) for e in batch])):
                handle.write(
                    json.dumps(
                        {
                            "id": example.id,
                            "signals": scored["signals"],
                            "severity": scored["severity"],
                        }
                    )
                    + "\n"
                )

    print(f"wrote {len(examples)} predictions -> {args.out}")
    print("evaluate.py fits the temperatures itself, so pass --raw when producing its input")


if __name__ == "__main__":
    main()
