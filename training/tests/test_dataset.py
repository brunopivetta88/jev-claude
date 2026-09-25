import unittest

from jevlab.dataset import action_signature, describe, group_key, labelled, split, stratum
from jevlab.schema import Example


def make(index, action, labels=None, tool="Bash"):
    return Example(id=str(index), goal="g", tool=tool, action=action, labels=labels or {})


class TestDataset(unittest.TestCase):
    def test_signature_collapses_operands_but_keeps_the_verb(self):
        self.assertEqual(action_signature("git push --force origin main"), "git push --force")
        self.assertEqual(
            action_signature("git push --force origin main"),
            action_signature("git push --force origin release-2"),
        )
        self.assertNotEqual(action_signature("rm -rf build"), action_signature("ls -la build"))

    def test_flags_separate_families(self):
        self.assertNotEqual(action_signature("git push origin main"), action_signature("git push --force origin main"))

    def test_one_family_never_straddles_two_splits(self):
        examples = [make(i, f"git push --force origin branch-{i}") for i in range(40)]
        examples += [make(100 + i, f"npm test -- --filter case{i}") for i in range(40)]
        result = split(examples)
        placement = {}
        for name in ("train", "val", "calib", "test"):
            for example in getattr(result, name):
                placement.setdefault(group_key(example), set()).add(name)
        self.assertTrue(all(len(v) == 1 for v in placement.values()))

    def test_every_example_lands_in_exactly_one_split(self):
        examples = [make(i, f"cmd{i % 31} /path/{i}") for i in range(300)]
        result = split(examples)
        self.assertEqual(sum(result.counts().values()), len(examples))
        ids = [e.id for name in ("train", "val", "calib", "test") for e in getattr(result, name)]
        self.assertEqual(len(ids), len(set(ids)))

    def test_the_split_is_deterministic(self):
        examples = [make(i, f"cmd{i % 17} /path/{i}") for i in range(200)]
        self.assertEqual(split(examples).counts(), split(examples).counts())

    def test_ratios_are_approximately_honoured_when_groups_are_plentiful(self):
        examples = [make(i, f"cmd{i % 120} /path/{i}") for i in range(2400)]
        counts = split(examples).counts()
        self.assertAlmostEqual(counts["train"] / 2400, 0.7, delta=0.05)
        for held_out in ("val", "calib", "test"):
            self.assertAlmostEqual(counts[held_out] / 2400, 0.1, delta=0.05)

    def test_ratios_must_sum_to_one(self):
        with self.assertRaises(ValueError):
            split([make(0, "ls")], ratios={"train": 0.5, "val": 0.2, "calib": 0.2, "test": 0.2})

    def test_stratum_names_the_positive_signals(self):
        self.assertEqual(stratum(make(0, "ls")), "clean")
        self.assertEqual(stratum(make(1, "rm -rf /", {"destructive": 1.0})), "destructive")
        self.assertEqual(stratum(make(2, "x", {"destructive": 0.0})), "clean")

    def test_labelled_keeps_only_examples_with_a_signal_label(self):
        examples = [make(0, "ls"), make(1, "rm -rf /", {"destructive": 1.0}), make(2, "x", {"severity": 2.0})]
        self.assertEqual([e.id for e in labelled(examples)], ["1"])

    def test_describe_reports_counts_and_sources(self):
        example = make(0, "rm -rf /", {"destructive": 1.0})
        example.label_source["destructive"] = "rule"
        text = describe([example])
        self.assertIn("destructive", text)
        self.assertIn("rule=1", text)


if __name__ == "__main__":
    unittest.main()
