import math
import unittest

from jevlab.metrics import (
    auroc, brier, ece, max_calibration_error, nll,
    recall_at_false_block_budget, reliability_table, summary,
)


class TestMetrics(unittest.TestCase):
    def test_brier_is_mean_squared_error(self):
        self.assertAlmostEqual(brier([1.0, 0.0], [1.0, 0.0]), 0.0)
        self.assertAlmostEqual(brier([0.5, 0.5], [1.0, 0.0]), 0.25)
        self.assertAlmostEqual(brier([0.0, 1.0], [1.0, 0.0]), 1.0)

    def test_perfectly_calibrated_predictions_have_no_error(self):
        # 100 predictions of 0.30, exactly 30 of which come true.
        probs = [0.3] * 100
        labels = [1.0] * 30 + [0.0] * 70
        self.assertAlmostEqual(ece(probs, labels), 0.0, places=9)

    def test_ece_measures_the_gap_between_claim_and_outcome(self):
        probs = [0.9] * 100
        labels = [1.0] * 50 + [0.0] * 50  # claims 90%, delivers 50%
        self.assertAlmostEqual(ece(probs, labels), 0.4, places=9)

    def test_confident_and_wrong_is_worse_than_uncertain_and_wrong(self):
        labels = [1.0] * 10
        self.assertGreater(brier([0.0] * 10, labels), brier([0.4] * 10, labels))

    def test_quantile_binning_fills_every_bin(self):
        probs = [0.01 * i for i in range(100)]
        labels = [float(p > 0.5) for p in probs]
        table = reliability_table(probs, labels, bins=10, strategy="quantile")
        self.assertEqual(len(table), 10)
        self.assertTrue(all(b.count == 10 for b in table))

    def test_uniform_binning_may_leave_bins_empty(self):
        probs = [0.95] * 20 + [0.05] * 20
        labels = [1.0] * 20 + [0.0] * 20
        self.assertEqual(len(reliability_table(probs, labels, bins=10)), 2)

    def test_max_calibration_error_reports_the_worst_bin(self):
        probs = [0.5] * 10 + [0.9] * 10
        labels = [1.0] * 5 + [0.0] * 5 + [0.0] * 10  # second bin is badly wrong
        self.assertAlmostEqual(max_calibration_error(probs, labels), 0.9)

    def test_auroc_of_a_perfect_ranker_is_one(self):
        self.assertAlmostEqual(auroc([0.9, 0.8, 0.2, 0.1], [1.0, 1.0, 0.0, 0.0]), 1.0)

    def test_auroc_of_a_reversed_ranker_is_zero(self):
        self.assertAlmostEqual(auroc([0.1, 0.2, 0.8, 0.9], [1.0, 1.0, 0.0, 0.0]), 0.0)

    def test_recall_at_budget_respects_the_budget(self):
        # 100 harmless actions, 10 harmful ones, scores that overlap slightly.
        probs = [0.1] * 95 + [0.8] * 5 + [0.9] * 10
        labels = [0.0] * 100 + [1.0] * 10
        point = recall_at_false_block_budget(probs, labels, budget=0.01)
        self.assertLessEqual(point.false_positive_rate, 0.01)
        self.assertAlmostEqual(point.recall, 1.0)  # all 10 caught above the 5 false ones

    def test_a_tighter_budget_never_increases_recall(self):
        probs = [0.1] * 90 + [0.6] * 10 + [0.7] * 10
        labels = [0.0] * 100 + [1.0] * 10
        loose = recall_at_false_block_budget(probs, labels, budget=0.2).recall
        tight = recall_at_false_block_budget(probs, labels, budget=0.01).recall
        self.assertGreaterEqual(loose, tight)

    def test_nll_punishes_confident_mistakes(self):
        self.assertGreater(nll([0.01], [1.0]), nll([0.4], [1.0]))

    def test_summary_reports_every_headline_number(self):
        probs = [0.2, 0.8, 0.6, 0.1]
        labels = [0.0, 1.0, 1.0, 0.0]
        stats = summary(probs, labels)
        for key in ("brier", "ece_uniform", "ece_quantile", "auroc", "recall_at_0.01_fpr"):
            self.assertIn(key, stats)
            self.assertFalse(math.isnan(stats[key]))

    def test_mismatched_lengths_are_rejected(self):
        with self.assertRaises(ValueError):
            brier([0.5], [1.0, 0.0])


if __name__ == "__main__":
    unittest.main()
