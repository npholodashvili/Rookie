"""Offline evaluator for Rookie model features/labels."""
import json
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from statistics import pstdev
from typing import Optional

from .config import MODEL_EVAL_PATH, MODEL_FEATURES_PATH, MODEL_LABELS_PATH


@dataclass
class EvalRow:
    market_id: str
    side: str
    edge: float
    expected_edge: float
    slippage_pct: float
    volume_24h: float
    won: bool
    return_pct: float
    weight: float = 1.0
    feature_ts: Optional[datetime] = None


def _read_jsonl(path: Path) -> list[dict]:
    if not path.exists():
        return []
    rows: list[dict] = []
    with open(path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                rows.append(json.loads(line))
            except Exception:
                continue
    return rows


def _clamp(x: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, x))


def _parse_feature_ts(raw: object) -> Optional[datetime]:
    if not raw:
        return None
    try:
        return datetime.fromisoformat(str(raw).replace("Z", "+00:00"))
    except Exception:
        return None


def _wilson_lower_bound(p: float, n: int, z: float = 1.96) -> float:
    if n <= 0:
        return 0.0
    den = 1 + (z * z) / n
    center = p + (z * z) / (2 * n)
    margin = z * ((p * (1 - p) / n) + (z * z) / (4 * n * n)) ** 0.5
    return max(0.0, (center - margin) / den)


def _score_policy_on_rows(
    rows: list[EvalRow],
    min_exp_edge: float,
    max_slip: float,
    min_liq: float,
) -> dict:
    subset = [
        r
        for r in rows
        if r.expected_edge >= min_exp_edge and r.slippage_pct <= max_slip and r.volume_24h >= min_liq
    ]
    n = len(subset)
    if n == 0:
        return {"n": 0, "win_rate": 0.0, "avg_return_pct": 0.0, "score": -1.0, "confidence": 0.0, "weighted_n": 0.0}
    tw = sum(r.weight for r in subset)
    if tw <= 0:
        return {"n": 0, "win_rate": 0.0, "avg_return_pct": 0.0, "score": -1.0, "confidence": 0.0, "weighted_n": 0.0}
    wins_w = sum(r.weight for r in subset if r.won)
    win_rate = wins_w / tw
    n_wilson = max(1, int(round(tw)))
    win_rate_lb = _wilson_lower_bound(win_rate, n_wilson)
    avg_ret = sum(r.return_pct * r.weight for r in subset) / tw
    ret_std = pstdev([r.return_pct for r in subset]) if n > 1 else 0.0
    confidence = _clamp((tw / (tw + 25.0)) * (1 / (1 + ret_std)), 0.0, 1.0)
    score = (avg_ret * 0.60) + (win_rate_lb * 0.30) + (confidence * 0.10)
    return {
        "n": n,
        "weighted_n": tw,
        "win_rate": win_rate,
        "win_rate_lb95": win_rate_lb,
        "avg_return_pct": avg_ret,
        "return_std": ret_std,
        "confidence": confidence,
        "score": score,
    }


def _grid_search_best(train_rows: list[EvalRow]) -> tuple[dict, dict]:
    baseline = _score_policy_on_rows(train_rows, 0.0, 1.0, 0.0)
    best: dict = {
        "min_expected_edge_pct": 0.0,
        "max_slippage_pct": 1.0,
        "min_liquidity_24h": 0.0,
        **baseline,
    }
    for edge in [0.01, 0.02, 0.03, 0.04, 0.05, 0.06]:
        for slip in [0.03, 0.05, 0.08]:
            for liq in [0, 200, 500, 1000, 2000]:
                m = _score_policy_on_rows(train_rows, edge, slip, liq)
                if m["n"] < 5:
                    continue
                if m["score"] > best["score"]:
                    best = {
                        "min_expected_edge_pct": edge,
                        "max_slippage_pct": slip,
                        "min_liquidity_24h": liq,
                        **m,
                    }
    return baseline, best


def evaluate_offline(
    return_clip: float = 3.0,
    label_sources: Optional[list[str]] = None,
    monitor_close_weight: float = 1.0,
    time_split_validate: bool = True,
    time_split_train_fraction: float = 0.75,
    min_holdout_rows: int = 12,
    holdout_min_delta: float = 0.02,
) -> dict:
    """
    Evaluate threshold policies using executed-feature rows joined to labels.

    When time_split_validate is True and enough timed rows + holdout exist, the best
    policy is chosen on the train slice only; auto-apply should require holdout_passed.
    """
    features = _read_jsonl(MODEL_FEATURES_PATH)
    labels = _read_jsonl(MODEL_LABELS_PATH)
    if not features:
        result = {"ok": True, "message": "no features yet", "samples": 0}
        MODEL_EVAL_PATH.write_text(json.dumps(result, indent=2), encoding="utf-8")
        return result

    filter_sources = None
    if label_sources is not None and len(label_sources) > 0:
        filter_sources = frozenset(str(s) for s in label_sources)

    mc_w = max(0.0, float(monitor_close_weight))

    label_map: dict[str, dict] = {}
    for lb in labels:
        key = f"{lb.get('market_id')}::{lb.get('side', 'unknown')}"
        label_map[key] = lb

    rows: list[EvalRow] = []
    for ft in features:
        key = f"{ft.get('market_id')}::{ft.get('side', 'unknown')}"
        lb = label_map.get(key)
        if not lb:
            continue
        src = str(lb.get("source") or "unknown")
        if filter_sources is not None and src not in filter_sources:
            continue
        w = 1.0
        if src == "monitor-close":
            w = mc_w
        if w <= 0:
            continue
        rows.append(
            EvalRow(
                market_id=str(ft.get("market_id", "")),
                side=str(ft.get("side", "unknown")),
                edge=float(ft.get("edge", 0)),
                expected_edge=float(ft.get("expected_edge", 0)),
                slippage_pct=float(ft.get("slippage_pct", 0)),
                volume_24h=float(ft.get("volume_24h", 0)),
                won=bool(lb.get("won", False)),
                return_pct=_clamp(float(lb.get("return_pct", 0)), -1.0, return_clip),
                weight=w,
                feature_ts=_parse_feature_ts(ft.get("timestamp")),
            )
        )

    if not rows:
        result = {
            "ok": True,
            "message": "features collected, waiting for resolved labels",
            "features": len(features),
            "labels": len(labels),
            "samples": 0,
        }
        MODEL_EVAL_PATH.write_text(json.dumps(result, indent=2), encoding="utf-8")
        return result

    train_frac = _clamp(float(time_split_train_fraction), 0.55, 0.90)
    min_hold = max(5, int(min_holdout_rows))

    holdout_info: dict = {
        "enabled": bool(time_split_validate),
        "passed": True,
        "skipped_reason": None,
        "train_n": len(rows),
        "test_n": 0,
        "test_best_score": None,
        "test_baseline_score": None,
    }

    train_rows = rows
    test_rows: list[EvalRow] = []
    ts_ok = sum(1 for r in rows if r.feature_ts is not None)

    if time_split_validate and ts_ok >= len(rows) * 0.8 and len(rows) >= min_hold + 8:
        sorted_rows = sorted(
            rows,
            key=lambda r: r.feature_ts or datetime.min.replace(tzinfo=timezone.utc),
        )
        cut = int(len(sorted_rows) * train_frac)
        cut = max(1, min(cut, len(sorted_rows) - 1))
        train_rows = sorted_rows[:cut]
        test_rows = sorted_rows[cut:]
        if len(test_rows) < min_hold:
            train_rows = rows
            test_rows = []
            holdout_info["skipped_reason"] = "insufficient_holdout_after_split"
        else:
            holdout_info["train_n"] = len(train_rows)
            holdout_info["test_n"] = len(test_rows)
    elif time_split_validate:
        holdout_info["skipped_reason"] = "insufficient_timestamps_or_samples"
        train_rows = rows

    baseline_train, best_train = _grid_search_best(train_rows)

    baseline_full = _score_policy_on_rows(rows, 0.0, 1.0, 0.0)
    best_full = {
        "min_expected_edge_pct": best_train["min_expected_edge_pct"],
        "max_slippage_pct": best_train["max_slippage_pct"],
        "min_liquidity_24h": best_train["min_liquidity_24h"],
        **_score_policy_on_rows(
            rows,
            float(best_train["min_expected_edge_pct"]),
            float(best_train["max_slippage_pct"]),
            float(best_train["min_liquidity_24h"]),
        ),
    }

    recommended = {
        "min_expected_edge_pct": best_train["min_expected_edge_pct"],
        "max_slippage_pct": best_train["max_slippage_pct"],
        "min_liquidity_24h": best_train["min_liquidity_24h"],
    }

    holdout_blocks_apply = False
    if test_rows:
        te = float(best_train["min_expected_edge_pct"])
        ts = float(best_train["max_slippage_pct"])
        tl = float(best_train["min_liquidity_24h"])
        test_best = _score_policy_on_rows(test_rows, te, ts, tl)
        test_base = _score_policy_on_rows(test_rows, 0.0, 1.0, 0.0)
        holdout_info["test_best_score"] = test_best["score"]
        holdout_info["test_baseline_score"] = test_base["score"]
        delta = float(test_best["score"]) - float(test_base["score"])
        holdout_info["delta_on_holdout"] = delta
        if delta < float(holdout_min_delta):
            holdout_info["passed"] = False
            recommended = {}
            holdout_blocks_apply = True
        else:
            holdout_info["passed"] = True
    else:
        # No chronological holdout: allow apply (small sample / missing timestamps).
        holdout_info["passed"] = True

    improvement = best_full["score"] - baseline_full["score"]

    result = {
        "ok": True,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "return_clip": return_clip,
        "label_sources_filter": list(label_sources) if filter_sources else None,
        "monitor_close_weight": mc_w,
        "samples": len(rows),
        "features": len(features),
        "labels": len(labels),
        "baseline": baseline_full,
        "best_policy": best_full,
        "train_baseline": baseline_train,
        "train_best_policy": best_train,
        "improvement_over_baseline_score": improvement,
        "holdout_validation": holdout_info,
        "recommended_updates": recommended,
        "holdout_blocks_apply": holdout_blocks_apply,
    }
    MODEL_EVAL_PATH.parent.mkdir(parents=True, exist_ok=True)
    MODEL_EVAL_PATH.write_text(json.dumps(result, indent=2), encoding="utf-8")
    return result
