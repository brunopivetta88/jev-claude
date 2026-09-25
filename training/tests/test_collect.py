import json
import tempfile
import unittest
from pathlib import Path

from jevlab.collect import collect, from_session
from jevlab.schema import render_state


def write_session(directory: Path, name: str, events: list[dict]) -> Path:
    path = directory / "state" / f"{name}.jsonl"
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as handle:
        for event in events:
            handle.write(json.dumps(event) + "\n")
    return path


class TestCollect(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def test_the_goal_is_carried_onto_every_later_action(self):
        path = write_session(self.dir, "s1", [
            {"kind": "goal", "text": "fix invoice rounding"},
            {"kind": "tool", "tool": "Bash", "action": "npm test", "summary": "Bash npm test"},
            {"kind": "tool", "tool": "Edit", "action": "src/x.ts", "summary": "Edit src/x.ts"},
        ])
        examples = from_session(path)
        self.assertEqual(len(examples), 2)
        self.assertTrue(all(e.goal == "fix invoice rounding" for e in examples))

    def test_a_new_goal_resets_the_history(self):
        path = write_session(self.dir, "s2", [
            {"kind": "goal", "text": "first"},
            {"kind": "tool", "tool": "Bash", "action": "a", "summary": "a"},
            {"kind": "goal", "text": "second"},
            {"kind": "tool", "tool": "Bash", "action": "b", "summary": "b"},
        ])
        examples = from_session(path)
        self.assertEqual(examples[1].goal, "second")
        self.assertEqual(examples[1].recent, [])

    def test_history_accumulates_within_one_goal(self):
        path = write_session(self.dir, "s3", [
            {"kind": "goal", "text": "g"},
            {"kind": "tool", "tool": "Bash", "action": "a", "summary": "Bash a"},
            {"kind": "tool", "tool": "Bash", "action": "b", "summary": "Bash b"},
        ])
        examples = from_session(path)
        self.assertEqual(examples[0].recent, [])
        self.assertEqual(len(examples[1].recent), 1)

    def test_floor_and_jev_probabilities_survive_the_round_trip(self):
        path = write_session(self.dir, "s4", [
            {"kind": "goal", "text": "g"},
            {"kind": "tool", "tool": "Bash", "action": "rm -rf /", "summary": "x",
             "floor": {"destructive": 0.99}, "jev": {"destructive": 0.4}},
        ])
        example = from_session(path)[0]
        self.assertEqual(example.floor["destructive"], 0.99)
        self.assertEqual(example.jev["destructive"], 0.4)

    def test_a_truncated_last_line_is_ignored(self):
        path = write_session(self.dir, "s5", [{"kind": "goal", "text": "g"}])
        with path.open("a", encoding="utf-8") as handle:
            handle.write('{"kind": "tool", "tool": "Bas')
        self.assertEqual(from_session(path), [])

    def test_identical_actions_across_sessions_are_collected_once(self):
        for name in ("a", "b"):
            write_session(self.dir, name, [
                {"kind": "goal", "text": "g"},
                {"kind": "tool", "tool": "Bash", "action": "npm test", "summary": "s"},
            ])
        examples = collect(self.dir)
        self.assertEqual(len(examples), 1)
        self.assertTrue(examples[0].id)

    def test_the_id_is_a_hash_of_what_the_model_sees(self):
        write_session(self.dir, "a", [
            {"kind": "goal", "text": "g"},
            {"kind": "tool", "tool": "Bash", "action": "npm test", "summary": "s"},
        ])
        example = collect(self.dir)[0]
        self.assertIn("[ACTION] npm test", render_state(example))
        self.assertEqual(len(example.id), 16)

    def test_non_tool_events_do_not_become_examples(self):
        path = write_session(self.dir, "s6", [
            {"kind": "session", "harness": "claude-code"},
            {"kind": "goal", "text": "g"},
        ])
        self.assertEqual(from_session(path), [])


if __name__ == "__main__":
    unittest.main()
