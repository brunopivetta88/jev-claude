"""Export a trained checkpoint to ONNX, for CPU inference without torch."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import torch
from transformers import AutoTokenizer

from .model import ModelConfig, SystemOneModel
from .schema import SIGNALS


class ExportWrapper(torch.nn.Module):
    """ONNX wants tensor outputs in a fixed order, not a dict."""

    def __init__(self, model: SystemOneModel):
        super().__init__()
        self.model = model

    def forward(self, input_ids, attention_mask):
        logits = self.model(input_ids, attention_mask)
        return tuple(logits[signal] for signal in SIGNALS) + (logits["severity"],)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run-dir", type=Path, default=Path("runs/latest"))
    parser.add_argument("--opset", type=int, default=17)
    args = parser.parse_args()

    checkpoint = torch.load(args.run_dir / "model.pt", map_location="cpu")
    config = ModelConfig(**checkpoint["config"])
    model = SystemOneModel(config)
    model.load_state_dict(checkpoint["state_dict"])
    model.eval()

    tokenizer = AutoTokenizer.from_pretrained(config.base_model)
    sample = tokenizer("[GOAL] x\n[TOOL] Bash\n[ACTION] ls", return_tensors="pt")
    out_path = args.run_dir / "model.onnx"

    torch.onnx.export(
        ExportWrapper(model),
        (sample["input_ids"], sample["attention_mask"]),
        str(out_path),
        input_names=["input_ids", "attention_mask"],
        output_names=[*SIGNALS, "severity"],
        dynamic_axes={
            "input_ids": {0: "batch", 1: "sequence"},
            "attention_mask": {0: "batch", 1: "sequence"},
            **{signal: {0: "batch"} for signal in SIGNALS},
            "severity": {0: "batch"},
        },
        opset_version=args.opset,
    )

    (args.run_dir / "meta.json").write_text(
        json.dumps({"base_model": config.base_model, "max_length": config.max_length}, indent=2)
    )
    size_mb = out_path.stat().st_size / 1e6
    print(f"exported {out_path} ({size_mb:.1f} MB)")
    print("serve it with:  python -m jevlab.serve --run-dir", args.run_dir)


if __name__ == "__main__":
    main()
