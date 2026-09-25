"""Splitting, deduplication and label bookkeeping.

The split is where most "my model beat theirs" claims quietly die. Two rules
here: the calibration split is separate from the test split, and near-identical
actions never straddle a boundary — a `git push --force origin main` in train and
`git push --force origin dev` in test is not a held-out example.
"""

from __future__ import annotations

import hashlib
import json
import random
import re
from dataclasses import dataclass
from pathlib import Path

from .schema import SIGNALS, Example, render_state

SPLITS = ("train", "val", "calib", "test")
DEFAULT_RATIOS = {"train": 0.7, "val": 0.1, "calib": 0.1, "test": 0.1}


def load(path: Path) -> list[Example]:
    examples: list[Example] = []
    with path.open("r", encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if line:
                examples.append(Example.from_json(json.loads(line)))
    return examples


def save(examples: list[Example], path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as handle:
        for example in examples:
            handle.write(json.dumps(example.to_json(), ensure_ascii=False) + "\n")


def normalize_action(action: str) -> str:
    """Replace the parts that make two instances of one command look different."""
    text = action.lower()
    text = re.sub(r"\b[0-9a-f]{7,}\b", "<hash>", text)
    text = re.sub(r"[\"'][^\"']*[\"']", "<str>", text)
    text = re.sub(r"\b\d+\b", "<n>", text)
    text = re.sub(r"(/[\w.@-]+)+", "<path>", text)
    text = re.sub(r"\s+", " ", text).strip()
    return text


def action_signature(action: str) -> str:
    """The command family, for grouping.

    Keeping only the leading verbs and the flags is what makes
    `git push --force origin main` and `git push --force origin dev` one family,
    while leaving `rm -rf` and `ls` apart. Trailing operands — branch names,
    hosts, paths — are exactly the part that varies between two instances of the
    same mistake, so they are dropped rather than normalised.
    """
    tokens = normalize_action(action).split()
    flags = sorted({t for t in tokens if t.startswith("-")})
    verbs = [t for t in tokens if not t.startswith("-")][:2]
    return " ".join(verbs + flags)


def group_key(example: Example) -> str:
    """Examples sharing this key always land in the same split."""
    seed = f"{example.tool}|{action_signature(example.action)}"
    return hashlib.sha256(seed.encode("utf-8")).hexdigest()[:16]


def stratum(example: Example) -> str:
    """Stratify on which signals are positive, so rare ones are spread evenly."""
    positives = [s for s in SIGNALS if example.labels.get(s, 0.0) >= 0.5]
    return ",".join(positives) if positives else "clean"


def labelled(examples: list[Example]) -> list[Example]:
    return [e for e in examples if any(s in e.labels for s in SIGNALS)]


@dataclass
class Split:
    train: list[Example]
    val: list[Example]
    calib: list[Example]
    test: list[Example]

    def counts(self) -> dict[str, int]:
        return {name: len(getattr(self, name)) for name in SPLITS}


def split(
    examples: list[Example],
    ratios: dict[str, float] | None = None,
    seed: int = 20260922,
) -> Split:
    """Group-aware, stratified split with a fixed seed.

    Whole groups move together, so the ratios are approximate — that is the
    correct trade: an exact 70/10/10/10 with leakage is worth less than an
    approximate one without.
    """
    ratios = ratios or DEFAULT_RATIOS
    if abs(sum(ratios.values()) - 1.0) > 1e-6:
        raise ValueError(f"ratios must sum to 1, got {sum(ratios.values())}")

    groups: dict[str, list[Example]] = {}
    for example in examples:
        groups.setdefault(group_key(example), []).append(example)

    # Bucket groups by the stratum of their first member, then deal each bucket
    # out in turn so every split sees the same label mix.
    buckets: dict[str, list[list[Example]]] = {}
    for members in groups.values():
        buckets.setdefault(stratum(members[0]), []).append(members)

    result = {name: [] for name in SPLITS}
    rng = random.Random(seed)
    order = [(name, ratios[name]) for name in SPLITS]

    for bucket in buckets.values():
        rng.shuffle(bucket)
        bucket.sort(key=len, reverse=True)
        total = sum(len(members) for members in bucket)
        quota = {name: ratio * total for name, ratio in order}
        taken = {name: 0 for name in SPLITS}
        for members in bucket:
            # Give the group to whichever split is furthest below its quota
            # *relative to its share*. Comparing raw deficits starves the small
            # splits: train's 70% shortfall dwarfs test's 10% one until train is
            # nearly full, and with few large groups test never fills at all.
            name = max(SPLITS, key=lambda s: (quota[s] - taken[s]) / ratios[s])
            result[name].extend(members)
            taken[name] += len(members)

    return Split(**result)


def label_matrix(examples: list[Example], head: str) -> tuple[list[int], list[float]]:
    """Indices and labels for one head, skipping examples it was not labelled for."""
    indices: list[int] = []
    values: list[float] = []
    for index, example in enumerate(examples):
        if head in example.labels:
            indices.append(index)
            values.append(float(example.labels[head]))
    return indices, values


def describe(examples: list[Example]) -> str:
    lines = [f"{len(examples)} examples"]
    for signal in SIGNALS:
        have = [e for e in examples if signal in e.labels]
        positive = sum(1 for e in have if e.labels[signal] >= 0.5)
        share = f"{positive / len(have):.1%}" if have else "—"
        lines.append(f"  {signal:<18} labelled {len(have):>5}   positive {positive:>5} ({share})")
    severity = [e for e in examples if "severity" in e.labels]
    lines.append(f"  {'severity':<18} labelled {len(severity):>5}")
    sources: dict[str, int] = {}
    for example in examples:
        for source in example.label_source.values():
            sources[source] = sources.get(source, 0) + 1
    if sources:
        lines.append("  label sources: " + ", ".join(f"{k}={v}" for k, v in sorted(sources.items())))
    return "\n".join(lines)


def render_all(examples: list[Example]) -> list[str]:
    return [render_state(example) for example in examples]
