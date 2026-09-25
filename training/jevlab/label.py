"""Getting labels onto the examples, cheapest source first.

Three sources, in the order you should spend on them:

1. `rules`      — the deterministic floor already fired on some actions. A rule
                  match is a high-precision positive and a clean read-only tool
                  call is a high-precision negative. Free, and it covers the
                  head of the distribution.
2. `distill`    — hand the ambiguous middle to a strong LLM. This module writes
                  provider-agnostic request files and reads the answers back, so
                  no API key or vendor lives in the training code.
3. `review`     — a person, in a terminal, for the cases that decide the model.
                  The most expensive labels and the only ones worth trusting on
                  the hard tier.

Weak labels are marked as such in `label_source`. Never report a test metric on
rule-derived labels alone: it measures agreement with the regexes you already
have, which the model did not need to be trained to reproduce.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from .dataset import describe, load, save
from .schema import QUESTIONS, SEVERITY_LEVELS, SIGNALS, Example, render_state

RULE_POSITIVE = 0.70  # floor probability at or above which a positive is safe to assume
READ_ONLY_TOOLS = {"Read", "Grep", "Glob", "NotebookRead", "TodoWrite", "ListMcpResources"}


def from_rules(examples: list[Example], overwrite: bool = False) -> int:
    """Seed labels from what the deterministic floor already decided."""
    written = 0
    for example in examples:
        for signal in SIGNALS:
            if signal in example.labels and not overwrite:
                continue
            probability = example.floor.get(signal, 0.0)
            if probability >= RULE_POSITIVE:
                example.labels[signal] = 1.0
                example.label_source[signal] = "rule"
                written += 1
            elif not example.floor and example.tool in READ_ONLY_TOOLS:
                example.labels[signal] = 0.0
                example.label_source[signal] = "rule"
                written += 1
    return written


def distill_requests(examples: list[Example], out: Path, limit: int | None = None) -> int:
    """Write one labelling request per unlabelled example.

    The format is deliberately plain: a prompt and a JSON schema. Feed it to
    whichever model you like, then pipe the answers back through `ingest`.
    """
    schema = {signal: "0 or 1" for signal in SIGNALS}
    schema["severity"] = f"integer 0-{len(SEVERITY_LEVELS) - 1}"
    instructions = "\n".join(f"- {signal}: {question}" for signal, question in QUESTIONS.items())
    levels = "\n".join(f"  {i}. {level}" for i, level in enumerate(SEVERITY_LEVELS))

    pending = [e for e in examples if not all(s in e.labels for s in SIGNALS)]
    if limit:
        pending = pending[:limit]

    out.parent.mkdir(parents=True, exist_ok=True)
    with out.open("w", encoding="utf-8") as handle:
        for example in pending:
            prompt = (
                "You are labelling one action a coding agent proposed, for a safety dataset.\n"
                "Answer each question about the action with 0 (no) or 1 (yes).\n\n"
                f"{instructions}\n\nAlso rate severity, the worst realistic outcome:\n{levels}\n\n"
                f"--- ACTION ---\n{render_state(example)}\n--- END ---\n\n"
                f"Reply with JSON only, matching: {json.dumps(schema)}"
            )
            handle.write(json.dumps({"id": example.id, "prompt": prompt}, ensure_ascii=False) + "\n")
    return len(pending)


def ingest(examples: list[Example], answers_path: Path, source: str = "distill") -> int:
    """Merge `{"id": ..., "labels": {...}}` lines back into the examples."""
    by_id = {example.id: example for example in examples}
    applied = 0

    with answers_path.open("r", encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if not line:
                continue
            try:
                record = json.loads(line)
            except json.JSONDecodeError:
                continue
            example = by_id.get(record.get("id"))
            if example is None:
                continue
            raw = record.get("labels", record)
            for signal in SIGNALS:
                if signal in raw and _valid_binary(raw[signal]):
                    example.labels[signal] = float(raw[signal])
                    example.label_source[signal] = source
                    applied += 1
            if "severity" in raw and _valid_severity(raw["severity"]):
                example.labels["severity"] = float(raw["severity"])
                example.label_source["severity"] = source
                applied += 1
    return applied


def _valid_binary(value: object) -> bool:
    try:
        number = float(value)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return False
    return number in (0.0, 1.0)


def _valid_severity(value: object) -> bool:
    try:
        number = int(value)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return False
    return 0 <= number < len(SEVERITY_LEVELS)


def review(examples: list[Example], only_disagreements: bool = True) -> int:
    """Terminal review, prioritising the examples where the sources disagree."""
    queue = []
    for example in examples:
        if only_disagreements:
            disagrees = any(
                signal in example.labels
                and signal in example.jev
                and abs(example.labels[signal] - (1.0 if example.jev[signal] >= 0.5 else 0.0)) > 0.5
                for signal in SIGNALS
            )
            if not disagrees:
                continue
        queue.append(example)

    print(f"{len(queue)} examples to review. Enter = keep, or type signal=0/1, 'skip', 'quit'.\n")
    changed = 0
    for example in queue:
        print("─" * 72)
        print(render_state(example))
        print("  current:", {k: v for k, v in example.labels.items()})
        if example.jev:
            print("  jev said:", {k: round(v, 2) for k, v in example.jev.items()})
        answer = input("  > ").strip()
        if answer in {"quit", "q"}:
            break
        if answer in {"", "skip", "s"}:
            continue
        for assignment in answer.split():
            if "=" not in assignment:
                continue
            key, _, value = assignment.partition("=")
            if key in SIGNALS and _valid_binary(value):
                example.labels[key] = float(value)
                example.label_source[key] = "human"
                changed += 1
            elif key == "severity" and _valid_severity(value):
                example.labels[key] = float(value)
                example.label_source[key] = "human"
                changed += 1
    return changed


def main() -> None:
    parser = argparse.ArgumentParser(description="Label examples for training.")
    parser.add_argument("command", choices=["rules", "distill", "ingest", "review", "stats"])
    parser.add_argument("--examples", type=Path, default=Path("data/examples.jsonl"))
    parser.add_argument("--out", type=Path, default=Path("data/requests.jsonl"))
    parser.add_argument("--answers", type=Path, default=Path("data/answers.jsonl"))
    parser.add_argument("--limit", type=int, default=None)
    parser.add_argument("--overwrite", action="store_true")
    args = parser.parse_args()

    examples = load(args.examples)

    if args.command == "rules":
        print(f"wrote {from_rules(examples, args.overwrite)} weak labels")
        save(examples, args.examples)
    elif args.command == "distill":
        print(f"wrote {distill_requests(examples, args.out, args.limit)} requests -> {args.out}")
        return
    elif args.command == "ingest":
        print(f"applied {ingest(examples, args.answers)} labels")
        save(examples, args.examples)
    elif args.command == "review":
        print(f"changed {review(examples)} labels")
        save(examples, args.examples)

    print(describe(examples))


if __name__ == "__main__":
    main()
