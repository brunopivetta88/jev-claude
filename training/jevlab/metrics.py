"""Calibration and decision metrics, in the standard library only.

Accuracy is the wrong headline number for a guardrail. What matters is whether
a 0.80 means 80% — that is calibration — and how much recall survives a fixed
budget of false blocks, because the two errors do not cost the same: a wrong
block costs a developer a minute, a wrong allow costs a production table.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

EPS = 1e-12


def _check(probs: list[float], labels: list[float]) -> None:
    if len(probs) != len(labels):
        raise ValueError(f"probs and labels differ in length: {len(probs)} vs {len(labels)}")
    if not probs:
        raise ValueError("no predictions to score")


def brier(probs: list[float], labels: list[float]) -> float:
    """Mean squared error of the probability. Lower is better; 0.25 is a coin flip."""
    _check(probs, labels)
    return sum((p - y) ** 2 for p, y in zip(probs, labels)) / len(probs)


def brier_multiclass(prob_vectors: list[list[float]], labels: list[int]) -> float:
    _check(prob_vectors, labels)  # type: ignore[arg-type]
    total = 0.0
    for vector, label in zip(prob_vectors, labels):
        for index, p in enumerate(vector):
            total += (p - (1.0 if index == label else 0.0)) ** 2
    return total / len(prob_vectors)


def nll(probs: list[float], labels: list[float]) -> float:
    """Negative log likelihood — what temperature scaling minimises."""
    _check(probs, labels)
    total = 0.0
    for p, y in zip(probs, labels):
        p = min(max(p, EPS), 1 - EPS)
        total -= y * math.log(p) + (1 - y) * math.log(1 - p)
    return total / len(probs)


@dataclass
class Bin:
    lower: float
    upper: float
    count: int
    mean_prob: float
    mean_label: float

    @property
    def gap(self) -> float:
        return abs(self.mean_prob - self.mean_label)


def reliability_table(
    probs: list[float], labels: list[float], bins: int = 10, strategy: str = "uniform"
) -> list[Bin]:
    """Bucket predictions and compare the average claim with the average outcome.

    `uniform` splits the [0,1] axis evenly, which is what most papers report but
    leaves near-empty bins where a model is confident. `quantile` gives every bin
    the same number of points, which is the honest view when predictions cluster.
    """
    _check(probs, labels)
    order = sorted(range(len(probs)), key=lambda i: probs[i])

    if strategy == "quantile":
        size = max(1, len(order) // bins)
        groups = [order[i : i + size] for i in range(0, len(order), size)]
        if len(groups) > bins:  # fold the remainder into the last bin
            groups[bins - 1].extend(sum(groups[bins:], []))
            groups = groups[:bins]
    elif strategy == "uniform":
        groups = [[] for _ in range(bins)]
        for index in order:
            slot = min(bins - 1, int(probs[index] * bins))
            groups[slot].append(index)
    else:
        raise ValueError(f"unknown binning strategy: {strategy}")

    table: list[Bin] = []
    for slot, group in enumerate(groups):
        if not group:
            continue
        table.append(
            Bin(
                lower=min(probs[i] for i in group),
                upper=max(probs[i] for i in group),
                count=len(group),
                mean_prob=sum(probs[i] for i in group) / len(group),
                mean_label=sum(labels[i] for i in group) / len(group),
            )
        )
    return table


def ece(probs: list[float], labels: list[float], bins: int = 10, strategy: str = "uniform") -> float:
    """Expected calibration error: the count-weighted mean gap of the table."""
    table = reliability_table(probs, labels, bins=bins, strategy=strategy)
    total = sum(b.count for b in table)
    return sum(b.count * b.gap for b in table) / total if total else 0.0


def max_calibration_error(probs: list[float], labels: list[float], bins: int = 10) -> float:
    table = reliability_table(probs, labels, bins=bins)
    return max((b.gap for b in table), default=0.0)


def roc_points(probs: list[float], labels: list[float]) -> list[tuple[float, float, float]]:
    """(threshold, false positive rate, true positive rate), strictest first."""
    _check(probs, labels)
    positives = sum(1 for y in labels if y >= 0.5)
    negatives = len(labels) - positives
    if positives == 0 or negatives == 0:
        return []

    pairs = sorted(zip(probs, labels), key=lambda item: -item[0])
    tp = fp = 0
    points: list[tuple[float, float, float]] = []
    previous = None
    for p, y in pairs:
        if previous is not None and p != previous:
            points.append((previous, fp / negatives, tp / positives))
        tp += 1 if y >= 0.5 else 0
        fp += 0 if y >= 0.5 else 1
        previous = p
    points.append((previous if previous is not None else 0.0, fp / negatives, tp / positives))
    return points


def auroc(probs: list[float], labels: list[float]) -> float:
    points = roc_points(probs, labels)
    if not points:
        return float("nan")
    curve = sorted(((fpr, tpr) for _, fpr, tpr in points))
    curve = [(0.0, 0.0)] + curve + [(1.0, 1.0)]
    area = 0.0
    for (x0, y0), (x1, y1) in zip(curve, curve[1:]):
        area += (x1 - x0) * (y0 + y1) / 2
    return area


@dataclass
class OperatingPoint:
    threshold: float
    false_positive_rate: float
    recall: float


def recall_at_false_block_budget(
    probs: list[float], labels: list[float], budget: float = 0.01
) -> OperatingPoint:
    """The most useful single number for a guardrail.

    "If I accept blocking 1% of the harmless actions, what share of the harmful
    ones do I catch?" Picks the loosest threshold whose false positive rate still
    fits the budget, because among equally-compliant thresholds the loosest one
    catches the most.
    """
    points = roc_points(probs, labels)
    if not points:
        return OperatingPoint(threshold=1.0, false_positive_rate=0.0, recall=0.0)

    allowed = [p for p in points if p[1] <= budget]
    if not allowed:
        return OperatingPoint(threshold=1.0, false_positive_rate=0.0, recall=0.0)
    threshold, fpr, tpr = max(allowed, key=lambda p: p[2])
    return OperatingPoint(threshold=threshold, false_positive_rate=fpr, recall=tpr)


def summary(probs: list[float], labels: list[float], budget: float = 0.01) -> dict[str, float]:
    point = recall_at_false_block_budget(probs, labels, budget)
    return {
        "n": len(probs),
        "positive_rate": sum(1 for y in labels if y >= 0.5) / len(labels),
        "brier": brier(probs, labels),
        "nll": nll(probs, labels),
        "ece_uniform": ece(probs, labels, strategy="uniform"),
        "ece_quantile": ece(probs, labels, strategy="quantile"),
        "max_calibration_error": max_calibration_error(probs, labels),
        "auroc": auroc(probs, labels),
        f"recall_at_{budget:g}_fpr": point.recall,
        "threshold": point.threshold,
    }
