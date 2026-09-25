"""A Jev-compatible endpoint, served from localhost.

The request and response shapes are deliberately identical to TypeSafe's, so
the plugin needs no new client: point JEV_GUARD_API_BASE at this server and the
decision path is unchanged. That is also what makes an honest A/B possible —
the only variable is which model answered.

Questions the model has no head for are simply left out of the answers, which
the plugin treats as "no signal". Inventing a 0.5 for them would be worse: it
would look like a calibrated opinion and act like noise.

    python -m jevlab.serve --run-dir runs/latest --port 8787
"""

from __future__ import annotations

import argparse
import json
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from .runtime import Runtime
from .schema import SIGNALS, Example, render_state

MAX_BODY_BYTES = 1_000_000


def state_to_example(state) -> Example:
    """Accept the plugin's state object, or a bare string."""
    if isinstance(state, str):
        return Example(id="", goal="", tool="", action=state)
    action = state.get("proposed_action") or state.get("last_action") or {}
    if isinstance(action, str):
        tool, payload = "", action
    else:
        tool = action.get("tool", "")
        payload = json.dumps(action.get("input", ""), ensure_ascii=False)
    recent = [
        f"{r.get('tool', '')} {r.get('summary', '')}" if isinstance(r, dict) else str(r)
        for r in state.get("recent_actions", [])
    ]
    return Example(
        id="",
        goal=str(state.get("user_goal", "")),
        tool=tool,
        action=payload,
        recent=recent,
        cwd=str(state.get("working_directory", "")),
    )


def build_answers(scored: dict, questions: dict) -> dict:
    answers = {}
    for key, spec in (questions or {}).items():
        kind = (spec or {}).get("type") if isinstance(spec, dict) else None
        if kind == "noul" and key in SIGNALS:
            answers[key] = {"type": "noul", "noul": round(scored["signals"][key], 4)}
        elif kind == "score" and key == "severity":
            distribution = scored["severity_probabilities"]
            answers[key] = {
                "type": "score",
                "score": scored["severity"] + 1,  # the API is 1-based
                "confidence": round(max(distribution), 4),
                "probabilities": [round(p, 4) for p in distribution],
            }
    return answers


class Handler(BaseHTTPRequestHandler):
    runtime: Runtime = None  # type: ignore[assignment]

    def _send(self, code: int, payload: dict) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self) -> None:  # noqa: N802 - name fixed by BaseHTTPRequestHandler
        if not self.path.rstrip("/").endswith("/v1/systemone"):
            self._send(404, {"error": "unknown path"})
            return

        length = int(self.headers.get("Content-Length", "0"))
        if length > MAX_BODY_BYTES:
            self._send(413, {"error": "body too large"})
            return

        try:
            request = json.loads(self.rfile.read(length) or b"{}")
        except json.JSONDecodeError:
            self._send(400, {"error": "invalid JSON"})
            return

        started = time.time()
        try:
            example = state_to_example(request.get("state", ""))
            scored = self.runtime.score([render_state(example)])[0]
        except Exception as error:  # a broken model must not hang the agent
            self._send(500, {"error": str(error)})
            return

        self._send(
            200,
            {
                "model": self.runtime.model_id,
                "answers": build_answers(scored, request.get("questions", {})),
                "usage": {"input_tokens": 0, "output_tokens": 0},
                "latency_ms": round((time.time() - started) * 1000, 2),
            },
        )

    def log_message(self, fmt: str, *args) -> None:
        print(f"jevlab.serve {fmt % args}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run-dir", type=Path, default=Path("runs/latest"))
    parser.add_argument("--port", type=int, default=8787)
    parser.add_argument("--host", default="127.0.0.1")
    args = parser.parse_args()

    Handler.runtime = Runtime(args.run_dir)
    print(f"loaded {Handler.runtime.model_id} ({Handler.runtime.backend})")
    if Handler.runtime.temperatures:
        print("temperatures:", Handler.runtime.temperatures)
    else:
        print("warning: no temperatures.json — probabilities are uncalibrated")

    server = ThreadingHTTPServer((args.host, args.port), Handler)
    print(f"listening on http://{args.host}:{args.port}/v1/systemone")
    print("point the plugin at it:  export JEV_GUARD_API_BASE=http://127.0.0.1:%d/v1/systemone" % args.port)
    server.serve_forever()


if __name__ == "__main__":
    main()
