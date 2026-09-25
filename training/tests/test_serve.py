import unittest

from jevlab.serve import build_answers, state_to_example
from jevlab.schema import SEVERITY_LEVELS, render_state

SCORED = {
    "signals": {
        "destructive": 0.91, "secret_exposure": 0.02, "exfiltration": 0.01,
        "prompt_injection": 0.03, "scope_creep": 0.10, "prod_impact": 0.05,
    },
    "severity": 3,
    "severity_probabilities": [0.01, 0.04, 0.15, 0.80],
}


class TestServe(unittest.TestCase):
    def test_the_plugin_state_object_is_understood(self):
        example = state_to_example({
            "user_goal": "fix rounding",
            "proposed_action": {"tool": "Bash", "input": {"command": "rm -rf /"}},
            "recent_actions": [{"tool": "Read", "summary": "src/App.tsx"}],
            "working_directory": "/repo",
        })
        self.assertEqual(example.goal, "fix rounding")
        self.assertEqual(example.tool, "Bash")
        self.assertIn("rm -rf /", example.action)
        self.assertIn("[RECENT] Read src/App.tsx", render_state(example))

    def test_a_bare_string_state_is_also_accepted(self):
        self.assertEqual(state_to_example("rm -rf /").action, "rm -rf /")

    def test_noul_answers_match_the_jev_response_shape(self):
        answers = build_answers(SCORED, {"destructive": {"type": "noul", "instructions": "..."}})
        self.assertEqual(answers["destructive"]["type"], "noul")
        self.assertAlmostEqual(answers["destructive"]["noul"], 0.91)

    def test_the_score_answer_is_one_based_like_the_api(self):
        answers = build_answers(SCORED, {"severity": {"type": "score", "criteria": list(SEVERITY_LEVELS)}})
        self.assertEqual(answers["severity"]["score"], 4)  # index 3 -> level 4
        self.assertAlmostEqual(answers["severity"]["confidence"], 0.80)
        self.assertEqual(len(answers["severity"]["probabilities"]), len(SEVERITY_LEVELS))

    def test_a_question_with_no_head_is_omitted_rather_than_guessed(self):
        answers = build_answers(SCORED, {"is_the_user_happy": {"type": "noul", "instructions": "?"}})
        self.assertEqual(answers, {})

    def test_only_the_questions_that_were_asked_are_answered(self):
        answers = build_answers(SCORED, {"destructive": {"type": "noul"}})
        self.assertEqual(list(answers), ["destructive"])


if __name__ == "__main__":
    unittest.main()
