"""Fine-tune the encoder. Needs a GPU and `pip install -r requirements.txt`.

Everything this script does is ordinary supervised learning; the parts worth
reading are the masking (a missing label is not a negative) and the fact that
the calibration split is never touched here.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import torch
from torch.utils.data import DataLoader, Dataset
from transformers import AutoTokenizer, get_linear_schedule_with_warmup

from .dataset import labelled, load, split as split_examples
from .metrics import brier, ece
from .model import ModelConfig, SystemOneModel, compute_loss
from .schema import SIGNALS, Example, render_state


class ActionDataset(Dataset):
    def __init__(self, examples: list[Example], tokenizer, max_length: int):
        self.examples = examples
        self.tokenizer = tokenizer
        self.max_length = max_length

    def __len__(self) -> int:
        return len(self.examples)

    def __getitem__(self, index: int) -> dict:
        example = self.examples[index]
        encoded = self.tokenizer(
            render_state(example),
            truncation=True,
            max_length=self.max_length,
            padding="max_length",
            return_tensors="pt",
        )
        item = {
            "input_ids": encoded["input_ids"].squeeze(0),
            "attention_mask": encoded["attention_mask"].squeeze(0),
        }
        for head in (*SIGNALS, "severity"):
            present = head in example.labels
            item[f"target_{head}"] = torch.tensor(float(example.labels.get(head, 0.0)))
            item[f"mask_{head}"] = torch.tensor(present)
        return item


def positive_weights(examples: list[Example]) -> dict[str, torch.Tensor]:
    """Counterweight for rare positives, so a 2%-positive head is still learned."""
    weights: dict[str, torch.Tensor] = {}
    for signal in SIGNALS:
        have = [e for e in examples if signal in e.labels]
        positives = sum(1 for e in have if e.labels[signal] >= 0.5)
        negatives = len(have) - positives
        if positives and negatives:
            weights[signal] = torch.tensor(negatives / positives)
    return weights


@torch.no_grad()
def evaluate(model: SystemOneModel, loader: DataLoader, device: str) -> dict[str, dict[str, float]]:
    model.eval()
    collected = {signal: ([], []) for signal in SIGNALS}

    for batch in loader:
        logits = model(batch["input_ids"].to(device), batch["attention_mask"].to(device))
        for signal in SIGNALS:
            mask = batch[f"mask_{signal}"]
            if not mask.any():
                continue
            probs = torch.sigmoid(logits[signal].detach().cpu())[mask]
            targets = batch[f"target_{signal}"][mask]
            collected[signal][0].extend(probs.tolist())
            collected[signal][1].extend(targets.tolist())

    report: dict[str, dict[str, float]] = {}
    for signal, (probs, targets) in collected.items():
        if not probs:
            continue
        report[signal] = {
            "n": len(probs),
            "brier": brier(probs, targets),
            "ece": ece(probs, targets, strategy="quantile"),
        }
    return report


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data", type=Path, default=Path("data/examples.jsonl"))
    parser.add_argument("--out", type=Path, default=Path("runs/latest"))
    parser.add_argument("--base-model", default="answerdotai/ModernBERT-base")
    parser.add_argument("--epochs", type=int, default=4)
    parser.add_argument("--batch-size", type=int, default=16)
    parser.add_argument("--lr", type=float, default=2e-5)
    parser.add_argument("--max-length", type=int, default=384)
    parser.add_argument("--brier-weight", type=float, default=1.0)
    parser.add_argument("--seed", type=int, default=20260922)
    args = parser.parse_args()

    torch.manual_seed(args.seed)
    device = "cuda" if torch.cuda.is_available() else "cpu"
    if device == "cpu":
        print("warning: no GPU visible — this will be slow but will still run")

    examples = labelled(load(args.data))
    if len(examples) < 50:
        raise SystemExit(
            f"only {len(examples)} labelled examples. Collect more with JEV_GUARD_COLLECT=1 "
            "and label them (jevlab.label) before training."
        )
    splits = split_examples(examples)
    print("splits:", splits.counts())

    tokenizer = AutoTokenizer.from_pretrained(args.base_model)
    config = ModelConfig(base_model=args.base_model, max_length=args.max_length)
    model = SystemOneModel(config).to(device)

    train_loader = DataLoader(
        ActionDataset(splits.train, tokenizer, args.max_length),
        batch_size=args.batch_size, shuffle=True, drop_last=False,
    )
    val_loader = DataLoader(
        ActionDataset(splits.val, tokenizer, args.max_length), batch_size=args.batch_size
    )

    weights = {k: v.to(device) for k, v in positive_weights(splits.train).items()}
    optimizer = torch.optim.AdamW(model.parameters(), lr=args.lr, weight_decay=0.01)
    steps = max(1, len(train_loader) * args.epochs)
    scheduler = get_linear_schedule_with_warmup(optimizer, int(0.06 * steps), steps)

    args.out.mkdir(parents=True, exist_ok=True)
    best = float("inf")

    for epoch in range(1, args.epochs + 1):
        model.train()
        running = 0.0
        for step, batch in enumerate(train_loader, start=1):
            logits = model(batch["input_ids"].to(device), batch["attention_mask"].to(device))
            targets = {h: batch[f"target_{h}"].to(device) for h in (*SIGNALS, "severity")}
            masks = {h: batch[f"mask_{h}"].to(device) for h in (*SIGNALS, "severity")}
            loss, _ = compute_loss(logits, targets, masks, weights, args.brier_weight)

            loss.backward()
            torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
            optimizer.step()
            scheduler.step()
            optimizer.zero_grad()

            running += float(loss.detach())
            if step % 20 == 0:
                print(f"epoch {epoch} step {step}/{len(train_loader)} loss {running / step:.4f}")

        report = evaluate(model, val_loader, device)
        mean_brier = sum(r["brier"] for r in report.values()) / max(1, len(report))
        print(f"epoch {epoch} val mean brier {mean_brier:.4f}")
        for signal, row in report.items():
            print(f"  {signal:<18} n={row['n']:<5} brier={row['brier']:.4f} ece={row['ece']:.4f}")

        if mean_brier < best:
            best = mean_brier
            torch.save({"state_dict": model.state_dict(), "config": config.__dict__}, args.out / "model.pt")
            (args.out / "report.json").write_text(json.dumps(report, indent=2))
            print(f"  saved (best so far) -> {args.out / 'model.pt'}")

    # The calibration and test splits are deliberately left for calibrate.py and
    # evaluate.py: a temperature fitted here would be fitted on training data.
    (args.out / "splits.json").write_text(
        json.dumps({name: [e.id for e in getattr(splits, name)] for name in splits.counts()}, indent=2)
    )
    print(f"done. best val mean brier {best:.4f}")


if __name__ == "__main__":
    main()
