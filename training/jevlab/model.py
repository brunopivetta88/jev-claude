"""The model: one encoder, one head per question, one forward pass.

This is the whole architectural idea behind a System One model, and it is not
complicated. An autoregressive LLM answers six questions by generating six
answers in sequence, each conditioned on the last. A bidirectional encoder with
six classification heads reads the state once and answers all six in parallel,
in a single pass — which is where the order-of-magnitude in latency comes from,
not from any secret.

What is genuinely hard is the calibration and the labels. See calibrate.py and
label.py for those; this file is the easy part.

Requires torch + transformers. Nothing else in jevlab imports it, so the
collector, the metrics and the calibration keep working on a machine with
neither installed.
"""

from __future__ import annotations

from dataclasses import dataclass

import torch
from torch import nn
from transformers import AutoConfig, AutoModel

from .schema import SEVERITY_LEVELS, SIGNALS


@dataclass
class ModelConfig:
    base_model: str = "answerdotai/ModernBERT-base"
    max_length: int = 384
    dropout: float = 0.1


class SystemOneModel(nn.Module):
    """Encoder + one linear head per question."""

    def __init__(self, config: ModelConfig):
        super().__init__()
        self.config = config
        self.encoder = AutoModel.from_pretrained(config.base_model)
        hidden = AutoConfig.from_pretrained(config.base_model).hidden_size
        self.dropout = nn.Dropout(config.dropout)
        # One logit per binary signal, and a small ordinal head for severity.
        self.signal_heads = nn.ModuleDict({signal: nn.Linear(hidden, 1) for signal in SIGNALS})
        self.severity_head = nn.Linear(hidden, len(SEVERITY_LEVELS))

    def pool(self, hidden_states: torch.Tensor, attention_mask: torch.Tensor) -> torch.Tensor:
        """Masked mean pooling.

        Preferred over taking [CLS] because not every encoder pretrains that
        token into a sentence representation, and a silently meaningless pooled
        vector is very hard to notice from the loss curve alone.
        """
        mask = attention_mask.unsqueeze(-1).to(hidden_states.dtype)
        summed = (hidden_states * mask).sum(dim=1)
        counts = mask.sum(dim=1).clamp(min=1e-9)
        return summed / counts

    def forward(self, input_ids: torch.Tensor, attention_mask: torch.Tensor) -> dict[str, torch.Tensor]:
        output = self.encoder(input_ids=input_ids, attention_mask=attention_mask)
        pooled = self.dropout(self.pool(output.last_hidden_state, attention_mask))
        logits = {signal: head(pooled).squeeze(-1) for signal, head in self.signal_heads.items()}
        logits["severity"] = self.severity_head(pooled)
        return logits


def brier_binary(logits: torch.Tensor, targets: torch.Tensor) -> torch.Tensor:
    return (torch.sigmoid(logits) - targets) ** 2


def brier_multiclass(logits: torch.Tensor, targets: torch.Tensor) -> torch.Tensor:
    probs = torch.softmax(logits, dim=-1)
    one_hot = torch.zeros_like(probs).scatter_(1, targets.unsqueeze(1), 1.0)
    return ((probs - one_hot) ** 2).sum(dim=-1)


def compute_loss(
    logits: dict[str, torch.Tensor],
    targets: dict[str, torch.Tensor],
    masks: dict[str, torch.Tensor],
    pos_weight: dict[str, torch.Tensor] | None = None,
    brier_weight: float = 1.0,
) -> tuple[torch.Tensor, dict[str, float]]:
    """Cross-entropy plus Brier, masked to the labels each example actually has.

    Cross-entropy alone rewards ranking; the Brier term is a proper scoring rule
    that also rewards the probability being *numerically* right, which is the
    property the whole product depends on. Examples missing a label contribute
    nothing to that head rather than being treated as negatives — silently
    imputing zeros is how a rare-signal head learns to always say no.
    """
    total = logits["severity"].new_zeros(())
    parts: dict[str, float] = {}

    for signal in SIGNALS:
        mask = masks[signal]
        if mask.sum() == 0:
            continue
        head_logits = logits[signal][mask]
        head_targets = targets[signal][mask]
        weight = pos_weight.get(signal) if pos_weight else None
        ce = nn.functional.binary_cross_entropy_with_logits(
            head_logits, head_targets, pos_weight=weight, reduction="mean"
        )
        br = brier_binary(head_logits, head_targets).mean()
        loss = ce + brier_weight * br
        total = total + loss
        parts[signal] = float(loss.detach())

    severity_mask = masks.get("severity")
    if severity_mask is not None and severity_mask.sum() > 0:
        head_logits = logits["severity"][severity_mask]
        head_targets = targets["severity"][severity_mask].long()
        ce = nn.functional.cross_entropy(head_logits, head_targets)
        br = brier_multiclass(head_logits, head_targets).mean()
        loss = ce + brier_weight * br
        total = total + loss
        parts["severity"] = float(loss.detach())

    return total, parts


@torch.no_grad()
def predict(model: SystemOneModel, input_ids: torch.Tensor, attention_mask: torch.Tensor) -> dict:
    logits = model(input_ids, attention_mask)
    out = {signal: torch.sigmoid(logits[signal]).tolist() for signal in SIGNALS}
    out["severity"] = torch.softmax(logits["severity"], dim=-1).tolist()
    return out
