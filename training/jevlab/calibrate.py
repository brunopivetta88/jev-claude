"""Temperature scaling, fitted per head, in the standard library only.

A model can rank perfectly and still lie about its confidence. Temperature
scaling fixes the confidence without touching the ranking: it divides the logits
by one scalar T, so AUROC is unchanged by construction and only the calibration
moves. T > 1 spreads probabilities toward 0.5 (the model was overconfident);
T < 1 sharpens them.

The temperature MUST be fitted on a split the model never trained on and that is
not the test set either — otherwise the calibration number you report is the one
you optimised, which is not a measurement.
"""

from __future__ import annotations

import math

from .metrics import nll

EPS = 1e-6
GOLDEN = (math.sqrt(5) - 1) / 2


def to_logit(p: float) -> float:
    p = min(max(p, EPS), 1 - EPS)
    return math.log(p / (1 - p))


def to_prob(z: float) -> float:
    if z >= 0:
        return 1 / (1 + math.exp(-z))
    exp_z = math.exp(z)
    return exp_z / (1 + exp_z)


def apply_temperature(probs: list[float], temperature: float) -> list[float]:
    if temperature <= 0:
        raise ValueError("temperature must be positive")
    return [to_prob(to_logit(p) / temperature) for p in probs]


def fit_temperature(
    probs: list[float],
    labels: list[float],
    low: float = 0.05,
    high: float = 10.0,
    tolerance: float = 1e-4,
) -> float:
    """Golden-section search on the negative log likelihood.

    NLL as a function of temperature is smooth and unimodal here, so a
    derivative-free search gets the same answer as L-BFGS in a few dozen
    evaluations and brings no dependency with it.
    """
    if not probs:
        raise ValueError("no predictions to calibrate on")
    positives = sum(1 for y in labels if y >= 0.5)
    if positives == 0 or positives == len(labels):
        # One class only: any temperature is equally defensible, so change nothing.
        return 1.0

    def objective(temperature: float) -> float:
        return nll(apply_temperature(probs, temperature), labels)

    a, b = low, high
    c = b - GOLDEN * (b - a)
    d = a + GOLDEN * (b - a)
    fc, fd = objective(c), objective(d)

    while abs(b - a) > tolerance:
        if fc < fd:
            b, d, fd = d, c, fc
            c = b - GOLDEN * (b - a)
            fc = objective(c)
        else:
            a, c, fc = c, d, fd
            d = a + GOLDEN * (b - a)
            fd = objective(d)

    return (a + b) / 2


def fit_per_head(
    predictions: dict[str, list[float]], labels: dict[str, list[float]]
) -> dict[str, float]:
    """One temperature per signal.

    Heads are not equally calibrated — a rare signal like `exfiltration` is
    usually far more overconfident than a common one — so a single global
    temperature leaves the rare heads wrong in both directions.
    """
    temperatures: dict[str, float] = {}
    for head, probs in predictions.items():
        if head not in labels:
            continue
        temperatures[head] = fit_temperature(probs, labels[head])
    return temperatures


def apply_per_head(
    predictions: dict[str, list[float]], temperatures: dict[str, float]
) -> dict[str, list[float]]:
    return {
        head: apply_temperature(probs, temperatures.get(head, 1.0))
        for head, probs in predictions.items()
    }
