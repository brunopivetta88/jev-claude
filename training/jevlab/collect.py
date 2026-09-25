"""Turn a jev-guard state directory into unlabelled training examples.

The plugin already writes everything needed, as long as it ran with
`JEV_GUARD_COLLECT=1`: the goal from UserPromptSubmit, the sanitized tool input,
the floor probabilities and whatever Jev answered. This module only reshapes it.

Nothing here reaches the network, and the inputs were redacted before they were
written — but they are still records of real sessions. Treat the output as
sensitive.
"""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path

from .schema import Example


def _iter_jsonl(path: Path):
    with path.open("r", encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if not line:
                continue
            try:
                yield json.loads(line)
            except json.JSONDecodeError:
                continue  # a half-written line at the tail is normal


def example_id(state_text: str) -> str:
    return hashlib.sha256(state_text.encode("utf-8")).hexdigest()[:16]


def from_session(path: Path) -> list[Example]:
    """Fold one session log into examples, carrying the goal forward."""
    goal = ""
    recent: list[str] = []
    examples: list[Example] = []

    for event in _iter_jsonl(path):
        kind = event.get("kind")
        if kind == "goal":
            goal = event.get("text", "")
            recent = []  # a new goal starts a new stretch of history
            continue
        if kind != "tool":
            continue

        action = event.get("action") or event.get("summary") or ""
        if isinstance(action, (dict, list)):
            action = json.dumps(action, ensure_ascii=False)

        example = Example(
            id="",
            goal=goal,
            tool=event.get("tool", ""),
            action=action,
            recent=list(recent),
            cwd=event.get("cwd", ""),
            floor={k: float(v) for k, v in (event.get("floor") or {}).items()},
            jev={k: float(v) for k, v in (event.get("jev") or {}).items()},
        )
        examples.append(example)
        recent.append(f"{event.get('tool', '')} {event.get('summary', '')}")

    return examples


def collect(state_dir: Path) -> list[Example]:
    sessions = sorted((state_dir / "state").glob("*.jsonl"))
    out: list[Example] = []
    seen: set[str] = set()

    for session in sessions:
        for example in from_session(session):
            from .schema import render_state

            identifier = example_id(render_state(example))
            if identifier in seen:
                continue  # the same action in two sessions teaches nothing twice
            seen.add(identifier)
            example.id = identifier
            out.append(example)

    return out


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--state-dir", type=Path, default=Path(".jev-guard"))
    parser.add_argument("--out", type=Path, default=Path("data/examples.jsonl"))
    args = parser.parse_args()

    examples = collect(args.state_dir)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    with args.out.open("w", encoding="utf-8") as handle:
        for example in examples:
            handle.write(json.dumps(example.to_json(), ensure_ascii=False) + "\n")

    labelled = sum(1 for e in examples if e.labels)
    print(f"collected {len(examples)} unique examples ({labelled} already labelled) -> {args.out}")
    if not examples:
        print("nothing found — was the plugin run with JEV_GUARD_COLLECT=1 ?")


if __name__ == "__main__":
    main()
