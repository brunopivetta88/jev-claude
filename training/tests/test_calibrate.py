import random
import unittest

from jevlab.calibrate import apply_temperature, fit_per_head, fit_temperature, to_logit, to_prob
from jevlab.metrics import auroc, ece


def overconfident_sample(n=3000, distortion=2.0, seed=11):
    """Predictions whose ranking is right but whose logits are inflated."""
    rng = random.Random(seed)
    probs, labels = [], []
    for _ in range(n):
        true_p = rng.choice([0.05, 0.2, 0.5, 0.8, 0.95])
        labels.append(1.0 if rng.random() < true_p else 0.0)
        probs.append(to_prob(to_logit(true_p) * distortion))
    return probs, labels


class TestCalibrate(unittest.TestCase):
    def test_logit_round_trip(self):
        for p in (0.01, 0.3, 0.5, 0.77, 0.99):
            self.assertAlmostEqual(to_prob(to_logit(p)), p, places=9)

    def test_temperature_recovers_a_known_distortion(self):
        probs, labels = overconfident_sample(distortion=2.0)
        self.assertAlmostEqual(fit_temperature(probs, labels), 2.0, delta=0.25)

    def test_scaling_reduces_calibration_error(self):
        probs, labels = overconfident_sample()
        after = apply_temperature(probs, fit_temperature(probs, labels))
        self.assertLess(ece(after, labels, strategy="quantile"), ece(probs, labels, strategy="quantile"))

    def test_scaling_cannot_change_the_ranking(self):
        probs, labels = overconfident_sample()
        after = apply_temperature(probs, 1.7)
        self.assertAlmostEqual(auroc(after, labels), auroc(probs, labels), places=9)

    def test_underconfident_predictions_get_a_temperature_below_one(self):
        probs, labels = overconfident_sample(distortion=0.5)
        self.assertLess(fit_temperature(probs, labels), 1.0)

    def test_a_single_class_leaves_the_temperature_alone(self):
        # Nothing to calibrate against: changing anything would be a guess.
        self.assertEqual(fit_temperature([0.2, 0.7, 0.9], [0.0, 0.0, 0.0]), 1.0)

    def test_temperature_must_be_positive(self):
        with self.assertRaises(ValueError):
            apply_temperature([0.5], 0.0)

    def test_per_head_fits_each_signal_separately(self):
        over, over_labels = overconfident_sample(distortion=2.5, seed=1)
        under, under_labels = overconfident_sample(distortion=0.6, seed=2)
        temperatures = fit_per_head(
            {"destructive": over, "exfiltration": under},
            {"destructive": over_labels, "exfiltration": under_labels},
        )
        self.assertGreater(temperatures["destructive"], 1.0)
        self.assertLess(temperatures["exfiltration"], 1.0)

    def test_empty_input_is_an_error_not_a_default(self):
        with self.assertRaises(ValueError):
            fit_temperature([], [])


if __name__ == "__main__":
    unittest.main()
