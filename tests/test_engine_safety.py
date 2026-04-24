"""Safety / decision-helper tests (stdlib only). Run from repo root: python -m unittest discover -s tests -v"""
import sys
import unittest
from datetime import datetime, timezone
from pathlib import Path
import json
import tempfile

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from engine.src.calibration_runtime import runtime_min_expected_edge_boost
from engine.src.offline_evaluator import (
    EvalRow,
    _grid_search_best,
    _merge_segment_policies,
    _score_policy_on_rows,
    filter_eval_rows_by_learning_window,
    parse_learning_effective_after,
    evaluate_offline,
)
from engine.src.trade_executor import _candidate_sort_key, _ensemble_sort_tuple, _portfolio_theme_counts


class TestCandidateSortKey(unittest.TestCase):
    def test_prefers_higher_expected_edge(self):
        a = _candidate_sort_key(0.05, 1000.0, 0.04, "m-a")
        b = _candidate_sort_key(0.03, 5000.0, 0.08, "m-b")
        self.assertLess(a, b)

    def test_tiebreak_volume(self):
        a = _candidate_sort_key(0.04, 2000.0, 0.05, "m-z")
        b = _candidate_sort_key(0.04, 1000.0, 0.05, "m-a")
        self.assertLess(a, b)


class TestEnsembleSort(unittest.TestCase):
    def test_ensemble_prefers_better_slip_when_edges_equal(self):
        cfg = {"use_ensemble_ranking": True, "ensemble_weights": {"edge": 0.55, "volume": 0.15, "resolution": 0.15, "slippage": 0.15}}
        a = _ensemble_sort_tuple(0.04, 1000.0, 0.04, 24.0, 0.9, "m-a", cfg)
        b = _ensemble_sort_tuple(0.04, 1000.0, 0.04, 24.0, 0.2, "m-b", cfg)
        self.assertLess(b, a)


class TestSegmentMerge(unittest.TestCase):
    def test_merge_runs_without_crash(self):
        rows = [
            EvalRow("1", "yes", 0.05, 0.05, 0.02, 800, True, 0.08, market_type="crypto"),
            EvalRow("2", "yes", 0.05, 0.05, 0.02, 800, True, 0.06, market_type="crypto"),
            EvalRow("3", "yes", 0.05, 0.04, 0.02, 800, False, -0.1, market_type="sports"),
            EvalRow("4", "yes", 0.05, 0.04, 0.02, 800, False, -0.08, market_type="sports"),
        ]
        _, global_best = _grid_search_best(rows)
        merged, used = _merge_segment_policies(rows, global_best, min_samples=2, score_slack=0.5)
        self.assertIn("min_expected_edge_pct", merged)
        self.assertIsInstance(used, bool)


class TestLearningWindow(unittest.TestCase):
    def test_parse_and_filter(self):
        cut = parse_learning_effective_after("2025-01-15T12:00:00+00:00")
        self.assertIsNotNone(cut)
        rows = [
            EvalRow("1", "yes", 0.05, 0.04, 0.01, 100, True, 0.1, feature_ts=datetime(2025, 1, 1, tzinfo=timezone.utc)),
            EvalRow("2", "yes", 0.05, 0.04, 0.01, 100, True, 0.1, feature_ts=datetime(2025, 2, 1, tzinfo=timezone.utc)),
        ]
        out, dropped = filter_eval_rows_by_learning_window(rows, cut)
        self.assertEqual(dropped, 1)
        self.assertEqual(len(out), 1)
        self.assertEqual(out[0].market_id, "2")


class TestThemePortfolio(unittest.TestCase):
    def test_counts_active_by_theme(self):
        state = {"market_theme_hints": {"m1": "crypto"}}
        positions = [
            {"status": "active", "venue": "sim", "shares_yes": 10, "shares_no": 0, "market_id": "m1"},
            {"status": "active", "venue": "sim", "shares_yes": 0, "shares_no": 5, "market_id": "m2", "question": "Will it rain tomorrow?"},
        ]
        by_t, by_side = _portfolio_theme_counts(positions, "sim", state)
        self.assertEqual(by_t.get("crypto"), 1)
        self.assertEqual(by_t.get("weather"), 1)


class TestCalibrationRuntime(unittest.TestCase):
    def test_boost_zero_without_file(self):
        b = runtime_min_expected_edge_boost({"use_calibration_runtime_adjustment": True})
        self.assertEqual(b, 0.0)


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


class TestEvaluatorTradeExecJoin(unittest.TestCase):
    def test_prefers_trade_exec_key_join(self):
        with tempfile.TemporaryDirectory() as td:
            base = Path(td)
            feats = base / "features.jsonl"
            labs = base / "labels.jsonl"
            feats.write_text(
                "\n".join(
                    [
                        json.dumps(
                            {
                                "timestamp": "2026-01-01T00:00:00Z",
                                "market_id": "m1",
                                "side": "yes",
                                "trade_exec_key": "t1",
                                "expected_edge": 0.05,
                                "edge": 0.05,
                                "slippage_pct": 0.01,
                                "volume_24h": 1000,
                            }
                        ),
                        json.dumps(
                            {
                                "timestamp": "2026-01-01T01:00:00Z",
                                "market_id": "m1",
                                "side": "yes",
                                "trade_exec_key": "t2",
                                "expected_edge": 0.05,
                                "edge": 0.05,
                                "slippage_pct": 0.01,
                                "volume_24h": 1000,
                            }
                        ),
                    ]
                )
                + "\n",
                encoding="utf-8",
            )
            labs.write_text(
                "\n".join(
                    [
                        json.dumps({"timestamp": "2026-01-02T00:00:00Z", "market_id": "m1", "side": "yes", "trade_exec_key": "t1", "won": True, "return_pct": 0.2, "source": "resolved-position"}),
                        json.dumps({"timestamp": "2026-01-02T01:00:00Z", "market_id": "m1", "side": "yes", "trade_exec_key": "t2", "won": False, "return_pct": -0.2, "source": "resolved-position"}),
                    ]
                )
                + "\n",
                encoding="utf-8",
            )
            result = evaluate_offline(features_path=feats, labels_path=labs)
            self.assertTrue(result.get("ok"))
            self.assertEqual(result.get("samples"), 2)


if __name__ == "__main__":
    unittest.main()
