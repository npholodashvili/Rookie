"""Safety / decision-helper tests (stdlib only). Run from repo root: python -m unittest discover -s tests -v"""
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from engine.src.offline_evaluator import EvalRow, _score_policy_on_rows
from engine.src.trade_executor import _candidate_sort_key


class TestCandidateSortKey(unittest.TestCase):
    def test_prefers_higher_expected_edge(self):
        a = _candidate_sort_key(0.05, 1000.0, 0.04, "m-a")
        b = _candidate_sort_key(0.03, 5000.0, 0.08, "m-b")
        self.assertLess(a, b)

    def test_tiebreak_volume(self):
        a = _candidate_sort_key(0.04, 2000.0, 0.05, "m-z")
        b = _candidate_sort_key(0.04, 1000.0, 0.05, "m-a")
        self.assertLess(a, b)


class TestScorePolicyRows(unittest.TestCase):
    def test_empty_subset(self):
        m = _score_policy_on_rows([], 0.02, 0.05, 100)
        self.assertEqual(m["n"], 0)
        self.assertEqual(m["score"], -1.0)

    def test_weighted_win_rate(self):
        rows = [
            EvalRow("1", "yes", 0.05, 0.04, 0.01, 1000, True, 0.1, weight=1.0),
            EvalRow("2", "yes", 0.05, 0.04, 0.01, 1000, False, -0.05, weight=1.0),
        ]
        m = _score_policy_on_rows(rows, 0.0, 1.0, 0.0)
        self.assertEqual(m["n"], 2)
        self.assertAlmostEqual(m["win_rate"], 0.5)


if __name__ == "__main__":
    unittest.main()
