"""Trade executor: fetch opportunities, execute trades, set risk monitor, persist history."""
import json
import math
import os
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional
from uuid import uuid4

from dotenv import load_dotenv

from .config import (
    DATA_DIR,
    DECISION_JOURNAL_PATH,
    MAX_BUDGET_SIM,
    MODEL_FEATURES_PATH,
    MODEL_LABELS_PATH,
    MONITOR_LEG_PEAKS_PATH,
    STRATEGY_CONFIG_PATH,
    TRADE_HISTORY_PATH,
)
from .calibration_runtime import runtime_min_expected_edge_boost
from .config_audit import append_config_audit_event
from .game_master import load_game_state, process_trade_resolution, save_game_state
from .monitor_policy_hints import compute_monitor_policy_hints, maybe_auto_apply_monitor_hints
from .offline_evaluator import evaluate_offline
from .telemetry import build_telemetry_envelope, merge_decision_with_telemetry
from .io_utils import atomic_write_json, file_lock
from .simmer_client import (
    _api_request,
    get_agent_me,
    get_briefing,
    get_effective_balance,
    get_market_context,
    get_opportunities,
    get_positions,
    get_trades,
    sell_position,
)

load_dotenv()

# Position statuses that do not count toward max open positions (same venue).
CLOSED_POSITION_STATUSES = frozenset({"resolved", "gone", "sold", "closed"})


def _position_has_material_shares(pos: dict) -> bool:
    """Simmer sometimes returns status 'active' with zero shares after a close — treat as not open."""
    sy = float(pos.get("shares_yes") or 0)
    sn = float(pos.get("shares_no") or 0)
    return sy >= 0.01 or sn >= 0.01


def load_strategy_config() -> dict:
    """Load strategy config from JSON."""
    defaults = {
        "stop_loss_pct": 0.10,
        "take_profit_pct": 0.50,
        "max_position_usd": 20,
        "min_edge_divergence": 0.03,
        "min_expected_edge_pct": 0.02,
        "min_liquidity_24h": 500,
        "max_slippage_pct": 0.05,
        "max_positions": 4,
        "max_hold_hours": 48,
        "max_total_exposure_pct": 0.60,
        "venue": "sim",
        "signal_sources": ["simmer"],
        "trailing_peak_return_enabled": False,
        "trailing_return_giveback_pp": 0.10,
        "min_profit_return_to_trail": 0.05,
        "cooldown_minutes": 30,
        "market_reentry_cooldown_minutes": 90,
        "min_hours_to_resolution": 4,
        "max_hours_to_resolution": 0,
        "daily_loss_limit_usd": 25,
        "cooloff_minutes_after_daily_stop": 120,
        "market_tags": [],
        "use_kelly_sizing": False,
        "kelly_cap": 0.25,
        "zero_fee_only": False,
        "auto_regime": True,
        "strategy_mode": "balanced",
        "fallback_trade_usd": 1.0,
        "auto_apply_evaluator": True,
        "evaluator_interval_minutes": 30,
        "evaluator_min_samples": 20,
        "evaluator_min_policy_n": 8,
        "evaluator_min_delta_score": 0.10,
        "evaluator_min_confidence": 0.35,
        "evaluator_return_clip": 3.0,
        "evaluator_label_sources": None,
        "evaluator_monitor_close_weight": 1.0,
        "evaluator_time_split_validate": True,
        "evaluator_time_split_train_fraction": 0.75,
        "evaluator_min_holdout_rows": 12,
        "evaluator_holdout_min_delta": 0.02,
        "evaluator_features_jsonl": None,
        "evaluator_labels_jsonl": None,
        "allow_relax_min_divergence": True,
        "allow_zero_divergence_fallback_scan": True,
        "allow_fallback_activity_trade": True,
        "persist_auto_regime_to_disk": True,
        "skill": "built-in",
        # Phase A–D: reliability, learning, ranking, velocity (safe defaults)
        "use_calibration_runtime_adjustment": True,
        "calibration_runtime_min_samples": 35,
        "calibration_runtime_min_bin_n": 12,
        "calibration_runtime_low_win_rate": 0.44,
        "calibration_runtime_boost_step": 0.005,
        "calibration_runtime_boost_cap": 0.02,
        "evaluator_segment_by_market_type": True,
        "evaluator_segment_min_samples": 18,
        "evaluator_segment_merge_score_slack": 0.04,
        "monitor_hints_min_monitor_samples": 10,
        "monitor_hints_min_resolved_samples": 8,
        "monitor_hints_underperform_gap": 0.02,
        "auto_apply_monitor_hints": False,
        "use_ensemble_ranking": True,
        "ensemble_weights": {"edge": 0.55, "volume": 0.15, "resolution": 0.15, "slippage": 0.15},
        "exploration_pick_second_on_near_tie": True,
        "exploration_near_tie_edge_abs": 0.008,
        # Portfolio / autonomy: theme caps, loss-streak pause, resolution sweet spot
        "max_positions_per_market_type": 4,
        "max_positions_per_theme_same_side": 3,
        "loss_streak_pause_threshold": 4,
        "loss_streak_pause_minutes": 45,
        "preferred_resolution_hours_min": 8,
        "preferred_resolution_hours_max": 96,
        "ensemble_resolution_sweet_spot_bonus": 0.07,
        # ISO datetime: ignore model_features rows before this for evaluator + calibration + hourly pairing (cold start)
        "learning_effective_after": "",
    }
    if not STRATEGY_CONFIG_PATH.exists():
        return defaults
    try:
        with open(STRATEGY_CONFIG_PATH, "r") as f:
            data = json.load(f)
        return {**defaults, **data}
    except Exception:
        return defaults


def load_trade_history() -> list:
    """Load local trade history."""
    if not TRADE_HISTORY_PATH.exists():
        return []
    try:
        with open(TRADE_HISTORY_PATH, "r") as f:
            return json.load(f)
    except Exception:
        return []


def append_trade(trade: dict) -> None:
    """Append trade to local history."""
    with file_lock(TRADE_HISTORY_PATH):
        history = load_trade_history()
        history.append(trade)
        atomic_write_json(TRADE_HISTORY_PATH, history)


def append_decision_event(event: dict) -> None:
    """Append cycle/monitor decision event to JSONL journal for analytics."""
    record = {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        **event,
    }
    with file_lock(DECISION_JOURNAL_PATH):
        DECISION_JOURNAL_PATH.parent.mkdir(parents=True, exist_ok=True)
        with open(DECISION_JOURNAL_PATH, "a", encoding="utf-8") as f:
            f.write(json.dumps(record) + "\n")


def append_model_feature(sample: dict) -> None:
    """Append executed-trade feature sample for offline evaluation."""
    record = {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        **sample,
    }
    with file_lock(MODEL_FEATURES_PATH):
        MODEL_FEATURES_PATH.parent.mkdir(parents=True, exist_ok=True)
        with open(MODEL_FEATURES_PATH, "a", encoding="utf-8") as f:
            f.write(json.dumps(record) + "\n")


def append_model_label(label: dict) -> None:
    """Append resolved outcome label for model training/evaluation."""
    record = {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        **label,
    }
    with file_lock(MODEL_LABELS_PATH):
        MODEL_LABELS_PATH.parent.mkdir(parents=True, exist_ok=True)
        with open(MODEL_LABELS_PATH, "a", encoding="utf-8") as f:
            f.write(json.dumps(record) + "\n")


def calculate_kelly_size(edge: float, price: float, max_bet: float, kelly_cap: float) -> float:
    """Kelly criterion position sizing. kelly_fraction = edge / (1 - price) for YES, capped at kelly_cap."""
    if price <= 0 or price >= 1:
        return 0.0
    kelly = edge / (1 - price)
    kelly = max(0.0, min(kelly, kelly_cap))
    return round(kelly * max_bet, 2)


def _active_exposure_usd(positions: list[dict]) -> float:
    """Approximate total active exposure in USD."""
    exposure = 0.0
    for p in positions:
        if p.get("status") == "resolved":
            continue
        if not _position_has_material_shares(p):
            continue
        exposure += float(p.get("current_value") or p.get("cost_basis") or 0)
    return max(0.0, exposure)


def _today_utc() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%d")


def _is_paused(state: dict) -> bool:
    pause_until = state.get("pause_until")
    if not pause_until:
        return False
    try:
        return datetime.now(timezone.utc) < datetime.fromisoformat(pause_until.replace("Z", "+00:00"))
    except Exception:
        return False


def _is_market_on_cooldown(state: dict, market_id: str, cooldown_minutes: int) -> bool:
    if cooldown_minutes <= 0:
        return False
    marks = state.get("market_reentry_cooldowns", {}) or {}
    ts = marks.get(market_id)
    if not ts:
        return False
    try:
        dt = datetime.fromisoformat(str(ts).replace("Z", "+00:00"))
        return (datetime.now(timezone.utc) - dt).total_seconds() < cooldown_minutes * 60
    except Exception:
        return False


def _mark_market_cooldown(state: dict, market_id: str) -> dict:
    marks = state.get("market_reentry_cooldowns", {}) or {}
    marks[market_id] = datetime.now(timezone.utc).isoformat()
    # Keep map bounded.
    if len(marks) > 1000:
        keys = list(marks.keys())[-800:]
        marks = {k: marks[k] for k in keys}
    state["market_reentry_cooldowns"] = marks
    save_game_state(state)
    return state


def _infer_market_type(question: str) -> str:
    q = (question or "").lower()
    if not q:
        return "unknown"
    if any(k in q for k in ["bitcoin", "btc", "ethereum", "eth", "solana", "doge", "token", "crypto", "coin", "price"]):
        return "crypto"
    if any(k in q for k in ["weather", "temperature", "rain", "snow", "storm", "hurricane", "climate"]):
        return "weather"
    if any(k in q for k in ["election", "president", "senate", "congress", "vote", "politic"]):
        return "politics"
    if any(k in q for k in [" vs ", "o/u", "points", "rebounds", "assists", "goal", "match", "cup", "nfl", "nba", "mlb", "nhl", "soccer", "football", "baseball", "hockey", "basketball"]):
        return "sports"
    return "other"


def _is_loss_streak_entry_paused(state: dict) -> bool:
    raw = state.get("loss_streak_entry_pause_until")
    if not raw:
        return False
    try:
        return datetime.now(timezone.utc) < datetime.fromisoformat(str(raw).replace("Z", "+00:00"))
    except Exception:
        return False


def _record_market_theme_hint(state: dict, market_id: str, market_type: str) -> None:
    hints = dict(state.get("market_theme_hints") or {})
    hints[str(market_id)] = str(market_type or "unknown")
    if len(hints) > 650:
        for k in list(hints.keys())[:250]:
            del hints[k]
    state["market_theme_hints"] = hints
    save_game_state(state)


def _prune_market_theme_hint(state: dict, market_id: object) -> None:
    mid = str(market_id or "")
    if not mid:
        return
    hints = dict(state.get("market_theme_hints") or {})
    hints.pop(mid, None)
    state["market_theme_hints"] = hints
    save_game_state(state)


def _position_inferred_theme(pos: dict, state: dict) -> str:
    q = pos.get("question") or pos.get("title") or pos.get("name") or ""
    if q:
        return _infer_market_type(str(q))
    mid = pos.get("market_id")
    if mid:
        h = (state.get("market_theme_hints") or {}).get(str(mid))
        if h:
            return str(h)
    return "unknown"


def _portfolio_theme_counts(positions: list, venue: str, state: dict) -> tuple[dict, dict]:
    by_t: Counter = Counter()
    by_ts: Counter = Counter()
    for p in positions:
        if str(p.get("status") or "").lower() != "active":
            continue
        if (p.get("venue") or venue) != venue:
            continue
        if not _position_has_material_shares(p):
            continue
        theme = _position_inferred_theme(p, state)
        sy = float(p.get("shares_yes") or 0)
        sn = float(p.get("shares_no") or 0)
        if sy >= 0.01:
            by_t[theme] += 1
            by_ts[(theme, "yes")] += 1
        if sn >= 0.01:
            by_t[theme] += 1
            by_ts[(theme, "no")] += 1
    return dict(by_t), dict(by_ts)


def _update_daily_realized_and_pause(state: dict, config: dict, realized_pnl: float) -> dict:
    """Track daily realized PnL and enter review window when daily loss limit is reached."""
    today = _today_utc()
    if state.get("daily_realized_pnl_date") != today:
        state["daily_realized_pnl_date"] = today
        state["daily_realized_pnl"] = 0.0
    state["daily_realized_pnl"] = float(state.get("daily_realized_pnl", 0.0)) + float(realized_pnl)
    limit = float(config.get("daily_loss_limit_usd", 25))
    if state["daily_realized_pnl"] <= -abs(limit):
        minutes = int(config.get("cooloff_minutes_after_daily_stop", 120))
        # Soft review window: set once per breach period, do not keep extending every update.
        if not _is_paused(state):
            pause_until = datetime.now(timezone.utc).timestamp() + (minutes * 60)
            state["pause_until"] = datetime.fromtimestamp(pause_until, timezone.utc).isoformat()
    save_game_state(state)
    return state


def set_risk_monitor(market_id: str, side: str, stop_loss_pct: float, take_profit_pct: Optional[float] = None) -> bool:
    """Set stop-loss (and optionally take-profit) on a position."""
    api_key = os.environ.get("SIMMER_API_KEY")
    if not api_key:
        return False
    body = {"side": side, "stop_loss_pct": stop_loss_pct}
    if take_profit_pct is not None:
        body["take_profit_pct"] = take_profit_pct
    data = _api_request("POST", f"/api/sdk/positions/{market_id}/monitor", api_key=api_key, json_body=body)
    return data is not None


def execute_trade(
    market_id: str,
    side: str,
    amount: float,
    source: str = "sdk:rookie",
    reasoning: str = "",
    dry_run: bool = False,
    feature_sample: Optional[dict] = None,
) -> Optional[dict]:
    """Execute a trade via Simmer API. Returns trade result or None."""
    api_key = os.environ.get("SIMMER_API_KEY")
    if not api_key:
        return None

    config = load_strategy_config()
    venue = config.get("venue", "sim")
    max_pos_usd = min(config.get("max_position_usd", 20), MAX_BUDGET_SIM / 10)
    amount = min(amount, max_pos_usd)

    body = {
        "market_id": market_id,
        "side": side,
        "amount": amount,
        "venue": venue,
        "source": source,
        "reasoning": reasoning or "Rookie auto trade",
        "dry_run": dry_run,
    }

    data = _api_request("POST", "/api/sdk/trade", api_key=api_key, json_body=body)
    if not data:
        return None

    if not dry_run and data.get("trade_id"):
        created_at = datetime.now(timezone.utc).isoformat()
        trade_exec_key = f"{data.get('trade_id')}::{side}::{created_at}"
        append_trade({
            "trade_id": data.get("trade_id"),
            "market_id": market_id,
            "side": side,
            "action": "buy",
            "amount": amount,
            "shares": data.get("shares") or data.get("shares_bought") or 0,
            "venue": venue,
            "created_at": created_at,
            "source": source,
            "trade_exec_key": trade_exec_key,
        })

        # Venue monitor: stop-loss always; omit take-profit when Rookie owns trailing exits.
        stop_loss = float(config.get("stop_loss_pct", 0.10))
        take_profit = None if config.get("trailing_peak_return_enabled") else config.get("take_profit_pct")
        set_risk_monitor(market_id, side, stop_loss, take_profit)
        if feature_sample:
            append_model_feature({
                **feature_sample,
                "trade_id": data.get("trade_id"),
                "trade_exec_key": trade_exec_key,
                "market_id": market_id,
                "side": side,
                "amount": amount,
                "mode": config.get("strategy_mode", "balanced"),
            })
        st = load_game_state()
        mt = str((feature_sample or {}).get("market_type") or "unknown")
        _record_market_theme_hint(st, str(market_id), mt)

    return data


def _apply_strategy_optimization(state: dict, config: dict) -> dict:
    """Auto-adjust strategy mode and parameters based on performance."""
    if not config.get("auto_regime", True):
        return config

    wins = int(state.get("wins", 0) or 0)
    losses = int(state.get("losses", 0) or 0)
    api_key = os.environ.get("SIMMER_API_KEY")
    if api_key:
        me = get_agent_me(api_key)
        if isinstance(me, dict):
            wc = me.get("win_count")
            lc = me.get("loss_count")
            if wc is not None or lc is not None:
                wins = int(wc or 0)
                losses = int(lc or 0)
    total = wins + losses
    win_rate = (wins / total) if total > 0 else 0.0
    consecutive = state.get("consecutive_losses", 0)

    updates = {}
    mode = config.get("strategy_mode", "balanced")
    if total >= 6 and (win_rate < 0.50 or consecutive >= 3):
        mode = "defensive"
    elif total >= 6 and win_rate > 0.72 and consecutive == 0:
        mode = "aggressive"
    else:
        mode = "balanced"

    updates["strategy_mode"] = mode
    if mode == "defensive":
        updates["min_edge_divergence"] = max(0.04, config.get("min_edge_divergence", 0.03))
        updates["max_position_usd"] = min(12, config.get("max_position_usd", 20))
        updates["kelly_cap"] = min(0.20, config.get("kelly_cap", 0.25))
        updates["use_kelly_sizing"] = False
    elif mode == "aggressive":
        updates["min_edge_divergence"] = min(0.03, config.get("min_edge_divergence", 0.03))
        updates["max_position_usd"] = min(MAX_BUDGET_SIM / 10, max(15, config.get("max_position_usd", 20)))
        updates["kelly_cap"] = max(0.25, config.get("kelly_cap", 0.25))
        updates["use_kelly_sizing"] = True
    else:
        updates["min_edge_divergence"] = min(0.05, max(0.03, config.get("min_edge_divergence", 0.03)))
        updates["max_position_usd"] = min(MAX_BUDGET_SIM / 10, max(10, config.get("max_position_usd", 20)))
        updates["kelly_cap"] = min(0.25, max(0.20, config.get("kelly_cap", 0.25)))

    if updates:
        persist = bool(config.get("persist_auto_regime_to_disk", True))
        try:
            path = STRATEGY_CONFIG_PATH
            existing = json.loads(path.read_text()) if path.exists() else {}
            changed = any(existing.get(k) != v for k, v in updates.items())
            merged = {**existing, **updates} if changed else existing
            if changed and persist:
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text(json.dumps(merged, indent=2))
                append_config_audit_event(
                    "auto_regime_persist",
                    {"strategy_mode": updates.get("strategy_mode"), "updates": updates},
                )
            elif changed and not persist:
                append_decision_event(
                    {
                        "type": "regime",
                        "persisted": False,
                        "would_apply": updates,
                    }
                )
        except Exception:
            pass
        return {**config, **updates}
    return config


def _evaluator_jsonl_paths(config: dict) -> tuple[Optional[Path], Optional[Path]]:
    """Resolve optional `evaluator_*_jsonl` basenames under data/."""

    def _one(key: str) -> Optional[Path]:
        raw = config.get(key)
        if raw is None or raw == "":
            return None
        name = Path(str(raw).strip()).name
        if not name or name in (".", ".."):
            return None
        return DATA_DIR / name

    return _one("evaluator_features_jsonl"), _one("evaluator_labels_jsonl")


def _maybe_auto_apply_evaluator(state: dict, config: dict) -> dict:
    """
    Periodically run offline evaluator and auto-apply recommended thresholds
    if sample quality is sufficient.
    """
    if not config.get("auto_apply_evaluator", True):
        return config

    interval_min = int(config.get("evaluator_interval_minutes", 30))
    last_eval = state.get("last_model_eval_at")
    if last_eval:
        try:
            last_eval_dt = datetime.fromisoformat(last_eval.replace("Z", "+00:00"))
            if (datetime.now(timezone.utc) - last_eval_dt).total_seconds() < interval_min * 60:
                return config
        except Exception:
            pass

    ev_src = config.get("evaluator_label_sources")
    ev_sources = ev_src if isinstance(ev_src, list) else None
    feat_p, lab_p = _evaluator_jsonl_paths(config)
    eval_result = evaluate_offline(
        return_clip=float(config.get("evaluator_return_clip", 3.0)),
        label_sources=ev_sources,
        monitor_close_weight=float(config.get("evaluator_monitor_close_weight", 1.0)),
        time_split_validate=bool(config.get("evaluator_time_split_validate", True)),
        time_split_train_fraction=float(config.get("evaluator_time_split_train_fraction", 0.75)),
        min_holdout_rows=int(config.get("evaluator_min_holdout_rows", 12)),
        holdout_min_delta=float(config.get("evaluator_holdout_min_delta", 0.02)),
        segment_by_market_type=bool(config.get("evaluator_segment_by_market_type", False)),
        evaluator_segment_min_samples=int(config.get("evaluator_segment_min_samples", 18)),
        segment_merge_score_slack=float(config.get("evaluator_segment_merge_score_slack", 0.04)),
        learning_effective_after=(str(config.get("learning_effective_after") or "").strip() or None),
        features_path=feat_p,
        labels_path=lab_p,
    )
    state = load_game_state()
    state["last_model_eval_at"] = datetime.now(timezone.utc).isoformat()
    save_game_state(state)

    if eval_result.get("ok") and int(eval_result.get("samples") or 0) >= 15:
        try:
            compute_monitor_policy_hints(config)
        except Exception:
            pass

    if not eval_result.get("ok"):
        return config
    if int(eval_result.get("samples", 0)) < int(config.get("evaluator_min_samples", 20)):
        return config

    best_policy = eval_result.get("best_policy") or {}
    if int(best_policy.get("n", 0)) < int(config.get("evaluator_min_policy_n", 8)):
        return config
    baseline = eval_result.get("baseline") or {}
    best_score = float(best_policy.get("score", 0))
    base_score = float(baseline.get("score", 0))
    min_delta = float(config.get("evaluator_min_delta_score", 0.10))
    if (best_score - base_score) < min_delta:
        return config
    min_conf = float(config.get("evaluator_min_confidence", 0.35))
    if float(best_policy.get("confidence", 0)) < min_conf:
        return config

    if eval_result.get("holdout_blocks_apply"):
        return config

    rec = eval_result.get("recommended_updates") or {}
    if not rec:
        return config

    allowed_keys = {"min_expected_edge_pct", "max_slippage_pct", "min_liquidity_24h"}
    updates = {k: rec[k] for k in rec if k in allowed_keys}
    if not updates:
        return config

    try:
        existing = json.loads(STRATEGY_CONFIG_PATH.read_text()) if STRATEGY_CONFIG_PATH.exists() else {}
        merged = {**existing, **updates}
        # Keep guardrails bounded to safe ranges.
        merged["min_expected_edge_pct"] = max(0.005, min(0.10, float(merged.get("min_expected_edge_pct", 0.02))))
        merged["max_slippage_pct"] = max(0.01, min(0.12, float(merged.get("max_slippage_pct", 0.05))))
        merged["min_liquidity_24h"] = max(0, min(50000, float(merged.get("min_liquidity_24h", 500))))
        STRATEGY_CONFIG_PATH.parent.mkdir(parents=True, exist_ok=True)
        STRATEGY_CONFIG_PATH.write_text(json.dumps(merged, indent=2))

        append_config_audit_event(
            "auto_apply_evaluator",
            {
                "updates": updates,
                "eval_samples": eval_result.get("samples"),
                "segment_merge_used": eval_result.get("segment_policy_merge_used"),
                "holdout_passed": (eval_result.get("holdout_validation") or {}).get("passed"),
            },
        )

        state = load_game_state()
        state["last_model_apply_at"] = datetime.now(timezone.utc).isoformat()
        save_game_state(state)
        cfg_out = {**config, **merged}
        try:
            hints = compute_monitor_policy_hints(cfg_out)
            cfg_out = maybe_auto_apply_monitor_hints(cfg_out, hints)
        except Exception:
            pass
        return cfg_out
    except Exception:
        return config


def _candidate_sort_key(expected_edge: float, volume_24h: float, abs_div: float, market_id: str) -> tuple:
    """Sort ascending: best trade first (highest expected edge, then liquidity, then |divergence|)."""
    return (
        -round(float(expected_edge), 8),
        -float(volume_24h),
        -float(abs_div),
        str(market_id),
    )


def _ensemble_sort_tuple(
    expected_edge: float,
    volume_24h: float,
    abs_div: float,
    hours_left: Optional[float],
    slip_ratio: float,
    market_id: str,
    config: dict,
) -> tuple:
    """Weighted score: edge, liquidity, time-to-resolution, slippage headroom (deterministic)."""
    if not config.get("use_ensemble_ranking", True):
        return _candidate_sort_key(expected_edge, volume_24h, abs_div, market_id)
    hours = float(hours_left) if hours_left is not None and hours_left > 0 else 72.0
    vol_norm = min(1.0, math.log1p(max(0.0, float(volume_24h))) / 14.0)
    time_pref = 1.0 / (1.0 + hours / 48.0)
    slip_pen = 1.0 - min(1.0, max(0.0, float(slip_ratio)))
    w = config.get("ensemble_weights") or {}
    e = float(w.get("edge", 0.55))
    v = float(w.get("volume", 0.15))
    t = float(w.get("resolution", 0.15))
    s = float(w.get("slippage", 0.15))
    score = float(expected_edge) * e + vol_norm * v + time_pref * t + slip_pen * s
    lo = float(config.get("preferred_resolution_hours_min", 0) or 0)
    hi = float(config.get("preferred_resolution_hours_max", 0) or 0)
    spot = float(config.get("ensemble_resolution_sweet_spot_bonus", 0) or 0)
    if spot > 0 and hi > lo > 0 and hours_left is not None and float(hours_left) > 0:
        if lo <= float(hours_left) <= hi:
            score += spot
    return (-round(score, 10), -float(volume_24h), -float(abs_div), str(market_id))


def _capital_velocity_metrics(
    positions: list,
    history: list,
    hours: float = 24.0,
) -> dict:
    """Lightweight turnover / time-in-market signals for telemetry."""
    now = datetime.now(timezone.utc)
    cutoff_ts = now.timestamp() - hours * 3600
    recent_buys = 0
    for t in history:
        if t.get("action") != "buy":
            continue
        dt = _parse_iso_datetime(t.get("created_at"))
        if dt is None:
            continue
        ts = dt.timestamp() if dt.tzinfo else dt.replace(tzinfo=timezone.utc).timestamp()
        if ts >= cutoff_ts:
            recent_buys += 1
    open_hours: list[float] = []
    for p in positions:
        if p.get("status") != "active":
            continue
        opened = _infer_position_opened_at(p, history)
        if opened is None:
            continue
        o = opened if opened.tzinfo else opened.replace(tzinfo=timezone.utc)
        open_hours.append((now - o).total_seconds() / 3600.0)
    return {
        "buys_last_24h": recent_buys,
        "avg_open_hold_hours": round(sum(open_hours) / len(open_hours), 2) if open_hours else 0.0,
        "open_positions_sampled": len(open_hours),
    }


def _attach_runtime_telemetry(
    result: dict,
    *,
    component: str,
    failure_code: Optional[str] = None,
    extra: Optional[dict] = None,
) -> dict:
    tel = build_telemetry_envelope(component=component, failure_code=failure_code, extra=extra or {})
    result["telemetry"] = tel
    dec = result.get("decision")
    if not isinstance(dec, dict):
        result["decision"] = merge_decision_with_telemetry({}, tel)
    else:
        result["decision"] = merge_decision_with_telemetry(dec, tel)
    return result


def run_trading_cycle() -> dict:
    """
    Run one trading cycle: fetch opportunities, maybe trade, update game state.
    Returns summary dict for backend/UI.
    """
    api_key = os.environ.get("SIMMER_API_KEY")
    state = load_game_state()

    if not api_key:
        result = {"alive": True, "state": state, "action": "none", "reason": "SIMMER_API_KEY not set"}
        _attach_runtime_telemetry(result, component="cycle", failure_code="missing_api_key")
        append_decision_event({"type": "cycle", **result})
        return result

    review_mode = _is_paused(state)

    config = load_strategy_config()
    config = _apply_strategy_optimization(state, config)
    config = _maybe_auto_apply_evaluator(state, config)
    # Refresh in-memory state in case evaluator/update helpers persisted new fields.
    state = load_game_state()
    cal_boost = runtime_min_expected_edge_boost(config)
    if cal_boost > 0:
        config = {
            **config,
            "min_expected_edge_pct": float(config.get("min_expected_edge_pct", 0.02)) + cal_boost,
        }
    if review_mode:
        # Soft safety mode: keep learning/trading but with much smaller risk.
        config = {
            **config,
            "strategy_mode": "defensive",
            "use_kelly_sizing": False,
            "max_position_usd": min(float(config.get("max_position_usd", 20)), max(1.0, float(config.get("fallback_trade_usd", 1.0)))),
            "min_edge_divergence": max(float(config.get("min_edge_divergence", 0.03)), 0.05),
            "max_total_exposure_pct": min(float(config.get("max_total_exposure_pct", 0.60)), 0.20),
        }

    if _is_loss_streak_entry_paused(state):
        result = {
            "alive": True,
            "state": state,
            "action": "skip",
            "reason": "loss streak entry pause (new buys only; monitor still runs)",
        }
        _attach_runtime_telemetry(result, component="cycle", failure_code="loss_streak_pause")
        append_decision_event({"type": "cycle", **result})
        return result

    balance = get_effective_balance(api_key)
    positions = get_positions(api_key)
    active_exposure = _active_exposure_usd(positions)

    if balance <= 0:
        result = {"alive": True, "state": state, "action": "skip", "reason": "balance is 0"}
        _attach_runtime_telemetry(result, component="cycle", failure_code="zero_balance")
        append_decision_event({"type": "cycle", **result})
        return result
    venue_for_cap = config.get("venue", "sim")
    active_count = len(
        [
            p
            for p in positions
            if str(p.get("status") or "active").lower() not in CLOSED_POSITION_STATUSES
            and (p.get("venue") or venue_for_cap) == venue_for_cap
            and _position_has_material_shares(p)
        ]
    )
    if active_count >= int(config.get("max_positions", 4)):
        result = {"alive": True, "state": state, "action": "skip", "reason": "max positions"}
        _attach_runtime_telemetry(result, component="cycle", failure_code="max_positions")
        append_decision_event({"type": "cycle", **result})
        return result
    max_exposure = balance * float(config.get("max_total_exposure_pct", 0.60))
    if active_exposure >= max_exposure:
        result = {"alive": True, "state": state, "action": "skip", "reason": "max exposure"}
        _attach_runtime_telemetry(result, component="cycle", failure_code="max_exposure")
        append_decision_event({"type": "cycle", **result})
        return result

    min_div = float(config.get("min_edge_divergence", 0.03))
    cycles_without = state.get("cycles_without_trade", 0)
    if cycles_without >= 8 and config.get("allow_relax_min_divergence", True):
        min_div = max(0.01, min_div - 0.01)
        state["cycles_without_trade"] = 0
        save_game_state(state)

    cooldown_min = config.get("cooldown_minutes", 30)
    last_trade = state.get("last_trade_at")
    if last_trade and cooldown_min > 0:
        try:
            last = datetime.fromisoformat(last_trade.replace("Z", "+00:00"))
            if (datetime.now(timezone.utc) - last).total_seconds() < cooldown_min * 60:
                result = {"alive": True, "state": state, "action": "skip", "reason": "cooldown"}
                _attach_runtime_telemetry(result, component="cycle", failure_code="cooldown")
                append_decision_event({"type": "cycle", **result})
                return result
        except Exception:
            pass

    run_resolution_check()
    state = load_game_state()

    opportunities = get_opportunities(
        api_key,
        limit=15 if cycles_without >= 4 else 10,
        min_divergence=min_div,
    )

    if not opportunities:
        state["cycles_without_trade"] = cycles_without + 1
        save_game_state(state)
        result = {
            "alive": True,
            "state": state,
            "action": "none",
            "reason": "no opportunities found",
            "decision": {"scanned": 0, "skips": {"no-opportunities": 1}},
        }
        _attach_runtime_telemetry(result, component="cycle", failure_code="no_opportunities")
        append_decision_event({"type": "cycle", **result})
        return result

    action = "none"
    reason = "no suitable opportunity"
    skip_reasons: dict[str, int] = {}
    max_pos_usd = min(config.get("max_position_usd", 20), MAX_BUDGET_SIM / 10)
    use_kelly = config.get("use_kelly_sizing", False)
    kelly_cap = config.get("kelly_cap", 0.25)
    zero_fee_only = config.get("zero_fee_only", False)
    min_expected_edge = float(config.get("min_expected_edge_pct", 0.02))
    max_slippage = float(config.get("max_slippage_pct", 0.05))
    min_liquidity = float(config.get("min_liquidity_24h", 500))
    market_reentry_cooldown = int(config.get("market_reentry_cooldown_minutes", 90))
    fallback_mode = False

    candidates = opportunities[:10]
    if (
        config.get("allow_zero_divergence_fallback_scan", True)
        and cycles_without >= 8
        and len(opportunities) < 3
    ):
        candidates = get_opportunities(api_key, limit=20, min_divergence=0.0)
        fallback_mode = True

    min_hours_to_resolution = float(config.get("min_hours_to_resolution", 4))
    max_hours_to_resolution = float(config.get("max_hours_to_resolution", 0))
    theme_by_type, theme_by_side = _portfolio_theme_counts(positions, venue_for_cap, state)
    passing: list[dict] = []
    chosen_best: Optional[dict] = None
    fail_reason_by_code = {
        "market-cooldown": "market re-entry cooldown",
        "resolved-past": "all opportunities already resolved/stale",
        "resolves-soon": "all opportunities resolve too soon",
        "resolves-too-late": "all opportunities resolve too late",
        "fee": "zero-fee constraint removed all opportunities",
        "discipline-severe": "discipline safeguard blocked opportunities",
        "edge-skip": "context edge recommendation blocked opportunities",
        "slippage": "slippage too high",
        "price-extreme": "extreme share prices",
        "theme-cap": "theme exposure cap reached",
        "theme-side-cap": "theme-side exposure cap reached",
        "edge-low": "expected edge too low",
        "liquidity": "liquidity too low",
        "size-too-small": "position size below minimum",
    }

    ctx_cache: dict[str, Optional[dict]] = {}

    def _cached_market_context(mid: str) -> Optional[dict]:
        if mid not in ctx_cache:
            ctx_cache[mid] = get_market_context(api_key, mid)
        return ctx_cache[mid]

    for opp in candidates:
        market_id = opp.get("id")
        if not market_id:
            continue
        if _is_market_on_cooldown(state, market_id, market_reentry_cooldown):
            reason = "market re-entry cooldown"
            skip_reasons["market-cooldown"] = skip_reasons.get("market-cooldown", 0) + 1
            continue

        hours_left: Optional[float] = None
        resolves_at = opp.get("resolves_at") or opp.get("end_date") or ""
        if resolves_at:
            try:
                res_dt = datetime.fromisoformat(str(resolves_at).replace("Z", "+00:00"))
                hours_left = (res_dt - datetime.now(timezone.utc)).total_seconds() / 3600
                if hours_left <= 0:
                    reason = f"stale/resolved market ({hours_left:.1f}h)"
                    skip_reasons["resolved-past"] = skip_reasons.get("resolved-past", 0) + 1
                    continue
                if min_hours_to_resolution > 0 and hours_left < min_hours_to_resolution:
                    reason = f"resolves too soon ({hours_left:.1f}h)"
                    skip_reasons["resolves-soon"] = skip_reasons.get("resolves-soon", 0) + 1
                    continue
                if max_hours_to_resolution > 0 and hours_left > max_hours_to_resolution:
                    reason = f"resolves too late ({hours_left:.1f}h > cap)"
                    skip_reasons["resolves-too-late"] = skip_reasons.get("resolves-too-late", 0) + 1
                    continue
            except Exception:
                pass

        context = _cached_market_context(market_id)
        if context:
            ctx_market = context.get("market", {})
            fee_rate_bps = ctx_market.get("fee_rate_bps", 0)
            if zero_fee_only and fee_rate_bps > 0:
                reason = "zero_fee_only: market has fee"
                skip_reasons["fee"] = skip_reasons.get("fee", 0) + 1
                continue
            discipline = context.get("discipline", {})
            if discipline.get("warning_level") == "severe":
                reason = "safeguard: flip-flop severe"
                skip_reasons["discipline-severe"] = skip_reasons.get("discipline-severe", 0) + 1
                continue
            edge_decision = (context.get("edge") or {}).get("recommendation")
            if edge_decision == "SKIP":
                reason = "context edge recommendation: SKIP"
                skip_reasons["edge-skip"] = skip_reasons.get("edge-skip", 0) + 1
                continue
            slip_est = ((context.get("slippage") or {}).get("estimates") or [{}])[0].get("slippage_pct", 0)
            if slip_est and slip_est > max_slippage:
                reason = "slippage too high"
                skip_reasons["slippage"] = skip_reasons.get("slippage", 0) + 1
                continue

        div = opp.get("divergence") or 0
        side = "yes" if div > 0 else "no"
        # Skip very low-probability shares where bid-ask spread causes instant loss
        share_price = opp.get("external_price_yes") or 0.5
        if side == "no":
            share_price = 1 - share_price
        min_share_price = float(config.get("min_share_price", 0.10))
        max_share_price = 1.0 - min_share_price
        if share_price < min_share_price or share_price > max_share_price:
            skip_reasons["price-extreme"] = skip_reasons.get("price-extreme", 0) + 1
            continue
        cand_theme = _infer_market_type(str(opp.get("question") or opp.get("title") or opp.get("name") or ""))
        max_pt = int(config.get("max_positions_per_market_type", 0))
        if max_pt > 0 and theme_by_type.get(cand_theme, 0) >= max_pt:
            skip_reasons["theme-cap"] = skip_reasons.get("theme-cap", 0) + 1
            continue
        max_ss = int(config.get("max_positions_per_theme_same_side", 0))
        if max_ss > 0 and theme_by_side.get((cand_theme, side), 0) >= max_ss:
            skip_reasons["theme-side-cap"] = skip_reasons.get("theme-side-cap", 0) + 1
            continue
        edge = abs(div)
        fee_bps = ((context or {}).get("market") or {}).get("fee_rate_bps", 0) or 0
        est_fee = fee_bps / 10000
        est_slip = (((context or {}).get("slippage") or {}).get("estimates") or [{}])[0].get("slippage_pct", 0) or 0
        expected_edge = edge - est_fee - est_slip
        if expected_edge < min_expected_edge and not fallback_mode:
            reason = "expected edge too low"
            skip_reasons["edge-low"] = skip_reasons.get("edge-low", 0) + 1
            continue
        volume = float(opp.get("volume_24h") or 0)
        if volume and volume < min_liquidity:
            reason = "liquidity too low"
            skip_reasons["liquidity"] = skip_reasons.get("liquidity", 0) + 1
            continue

        if use_kelly:
            price = opp.get("external_price_yes") or 0.5
            if side == "no":
                price = 1 - price
            amount = calculate_kelly_size(edge, price, max_pos_usd, kelly_cap)
        else:
            amount = min(max_pos_usd, balance * 0.1)
        if fallback_mode:
            amount = min(float(config.get("fallback_trade_usd", 1.0)), max_pos_usd, balance * 0.02)

        if amount < 1:
            reason = "amount < 1 (balance too low)"
            skip_reasons["size-too-small"] = skip_reasons.get("size-too-small", 0) + 1
            continue

        slip_ratio = (est_slip / max_slippage) if max_slippage > 0 else 0.0
        feature_sample = {
            "market_id": market_id,
            "question": str(opp.get("question") or opp.get("title") or opp.get("name") or ""),
            "market_type": cand_theme,
            "edge": edge,
            "expected_edge": expected_edge,
            "fee_bps": fee_bps,
            "slippage_pct": est_slip,
            "volume_24h": volume,
            "hours_to_resolution": hours_left,
            "min_edge_divergence": float(config.get("min_edge_divergence", 0.03)),
            "min_expected_edge_pct": min_expected_edge,
            "min_liquidity_24h": min_liquidity,
            "max_slippage_pct": max_slippage,
            "review_mode": review_mode,
            "fallback_mode": fallback_mode,
        }
        passing.append(
            {
                "market_id": market_id,
                "side": side,
                "amount": amount,
                "feature_sample": feature_sample,
                "sort_key": _ensemble_sort_tuple(
                    expected_edge, volume, edge, hours_left, slip_ratio, str(market_id), config
                ),
            }
        )

    picked_rank = 1
    if passing:
        sorted_p = sorted(passing, key=lambda x: x["sort_key"])
        chosen_best = sorted_p[0]
        if config.get("exploration_pick_second_on_near_tie", True) and len(sorted_p) >= 2:
            e0 = float(sorted_p[0]["feature_sample"]["expected_edge"])
            e1 = float(sorted_p[1]["feature_sample"]["expected_edge"])
            v0 = float(sorted_p[0]["feature_sample"]["volume_24h"])
            v1 = float(sorted_p[1]["feature_sample"]["volume_24h"])
            tie_eps = float(config.get("exploration_near_tie_edge_abs", 0.008))
            if abs(e0 - e1) <= tie_eps and v1 > v0 * 1.1:
                chosen_best = sorted_p[1]
                picked_rank = 2
        trade_result = execute_trade(
            chosen_best["market_id"],
            chosen_best["side"],
            chosen_best["amount"],
            dry_run=False,
            feature_sample=chosen_best["feature_sample"],
        )
        if trade_result:
            action = "traded"
            reason = "ok"
            state["trades_count"] = state.get("trades_count", 0) + 1
            state["last_trade_at"] = datetime.now(timezone.utc).isoformat()
            state["cycles_without_trade"] = 0
            save_game_state(state)

    if action != "traded" and cycles_without >= 8 and config.get("allow_fallback_activity_trade", True):
        relaxed = get_opportunities(api_key, limit=20, min_divergence=0.0)
        if relaxed:
            relaxed = sorted(relaxed, key=lambda x: abs(x.get("divergence") or 0), reverse=True)
            for top in relaxed:
                market_id = top.get("id")
                if not market_id or _is_market_on_cooldown(state, market_id, market_reentry_cooldown):
                    continue

                fb_resolves_at = top.get("resolves_at") or top.get("end_date") or ""
                if fb_resolves_at:
                    try:
                        fb_dt = datetime.fromisoformat(str(fb_resolves_at).replace("Z", "+00:00"))
                        if (fb_dt - datetime.now(timezone.utc)).total_seconds() <= 0:
                            continue
                    except Exception:
                        pass

                div = top.get("divergence") or 0
                side = "yes" if div > 0 else "no"
                # Apply share price filter to fallback trades too
                fb_share_price = top.get("external_price_yes") or 0.5
                if side == "no":
                    fb_share_price = 1 - fb_share_price
                fb_min_price = float(config.get("min_share_price", 0.10))
                fb_max_price = 1.0 - fb_min_price
                if fb_share_price < fb_min_price or fb_share_price > fb_max_price:
                    continue

                fb_theme = _infer_market_type(str(top.get("question") or top.get("title") or top.get("name") or ""))
                max_pt_fb = int(config.get("max_positions_per_market_type", 0))
                if max_pt_fb > 0 and theme_by_type.get(fb_theme, 0) >= max_pt_fb:
                    continue
                max_ss_fb = int(config.get("max_positions_per_theme_same_side", 0))
                if max_ss_fb > 0 and theme_by_side.get((fb_theme, side), 0) >= max_ss_fb:
                    continue

                fallback_amount = min(
                    float(config.get("fallback_trade_usd", 1.0)), max_pos_usd, max(1.0, balance * 0.01)
                )
                result = execute_trade(
                    market_id,
                    side,
                    fallback_amount,
                    dry_run=False,
                    reasoning="Fallback activity trade after 2h inactivity",
                    feature_sample={
                        "market_id": market_id,
                        "question": str(top.get("question") or top.get("title") or top.get("name") or ""),
                        "market_type": fb_theme,
                        "edge": abs(div),
                        "expected_edge": abs(div),
                        "fee_bps": 0,
                        "slippage_pct": 0,
                        "volume_24h": float(top.get("volume_24h") or 0),
                        "min_edge_divergence": float(config.get("min_edge_divergence", 0.03)),
                        "min_expected_edge_pct": float(config.get("min_expected_edge_pct", 0.02)),
                        "min_liquidity_24h": float(config.get("min_liquidity_24h", 500)),
                        "max_slippage_pct": float(config.get("max_slippage_pct", 0.05)),
                        "review_mode": review_mode,
                        "fallback_mode": True,
                    },
                )
                if result:
                    action = "traded"
                    reason = "fallback trade"
                    state["trades_count"] = state.get("trades_count", 0) + 1
                    state["last_trade_at"] = datetime.now(timezone.utc).isoformat()
                    state["cycles_without_trade"] = 0
                    save_game_state(state)
                    fallback_mode = True
                    break
                # Tried this fallback candidate but trade did not execute; try next candidate.
            if action != "traded":
                reason = "no valid fallback candidate"

    if action != "traded" and reason == "no suitable opportunity" and skip_reasons:
        top_skip = sorted(skip_reasons.items(), key=lambda kv: kv[1], reverse=True)[0][0]
        reason = fail_reason_by_code.get(top_skip, f"filtered by {top_skip}")

    if action != "traded":
        state["cycles_without_trade"] = state.get("cycles_without_trade", 0) + 1
        save_game_state(state)

    picked = None
    if chosen_best is not None and action == "traded":
        picked = {
            "market_id": chosen_best["market_id"],
            "expected_edge": chosen_best["feature_sample"].get("expected_edge"),
            "volume_24h": chosen_best["feature_sample"].get("volume_24h"),
        }

    velocity = _capital_velocity_metrics(positions, load_trade_history(), 24.0)
    result = {
        "alive": True,
        "state": state,
        "action": action,
        "reason": f"{reason} (review mode)" if review_mode else reason,
        "decision": {
            "scanned": len(candidates),
            "candidates_passing": len(passing),
            "picked": picked,
            "skips": skip_reasons,
            "fallback_mode": fallback_mode,
            "calibration_runtime_boost": cal_boost,
            "capital_velocity": velocity,
            "candidate_rank": picked_rank if action == "traded" and passing else None,
            "open_theme_counts": theme_by_type,
        },
    }
    fail_code: Optional[str] = None
    if action != "traded":
        fail_code = "no_passing_candidates" if not passing else "no_trade_executed"
    _attach_runtime_telemetry(result, component="cycle", failure_code=fail_code)
    append_decision_event({"type": "cycle", **result})
    return result


def _parse_iso_datetime(value: Optional[str]) -> Optional[datetime]:
    if not value:
        return None
    try:
        return datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except Exception:
        return None


def _infer_position_opened_at(
    pos: dict, history: list, side: Optional[str] = None
) -> Optional[datetime]:
    """Best-effort entry time: Simmer fields, else local trade_history (scoped to one leg if side set)."""
    for key in ("opened_at", "created_at", "entered_at"):
        dt = _parse_iso_datetime(pos.get(key))
        if dt is not None and side is None:
            return dt

    market_id = pos.get("market_id")
    if not market_id:
        return None
    leg_side = side
    if leg_side is None:
        if (pos.get("shares_yes") or 0) > 0:
            leg_side = "yes"
        elif (pos.get("shares_no") or 0) > 0:
            leg_side = "no"
    if not leg_side:
        return None

    relevant = [
        t for t in history if t.get("market_id") == market_id and t.get("side") == leg_side
    ]
    relevant.sort(
        key=lambda t: _parse_iso_datetime(t.get("created_at"))
        or datetime.min.replace(tzinfo=timezone.utc)
    )

    opened: Optional[datetime] = None
    for t in reversed(relevant):
        if t.get("action") == "sell":
            break
        dt = _parse_iso_datetime(t.get("created_at"))
        if dt is not None:
            if opened is None or dt < opened:
                opened = dt
    if opened is None and side is not None:
        for key in ("opened_at", "created_at", "entered_at"):
            dt = _parse_iso_datetime(pos.get(key))
            if dt is not None:
                return dt
    return opened


def _net_leg_cost_from_history(history: list, market_id: str, side: str) -> float:
    """Net notional for one leg from local trade_history (buys add, sells subtract)."""
    net = 0.0
    sl = side.lower()
    for t in history:
        if t.get("market_id") != market_id or str(t.get("side") or "").lower() != sl:
            continue
        amt = float(t.get("amount") or 0)
        act = str(t.get("action") or "buy").lower()
        if act == "buy":
            net += amt
        elif act == "sell":
            net -= amt
    return max(0.0, net)


def _compute_local_cost_basis(history: list, market_id: str, side: str) -> float:
    """Sum buy amounts for the CURRENT open leg only (since last sell) of market+side.

    Unlike _net_leg_cost_from_history which accumulates across all time,
    this function only considers buys after the most recent sell — giving
    the actual cost of the shares currently held.
    """
    relevant = [
        t for t in history
        if t.get("market_id") == market_id and str(t.get("side") or "").lower() == side.lower()
    ]
    relevant.sort(
        key=lambda t: _parse_iso_datetime(t.get("created_at"))
        or datetime.min.replace(tzinfo=timezone.utc)
    )

    total_cost = 0.0
    for t in reversed(relevant):
        if t.get("action") == "sell":
            break
        if t.get("action") == "buy":
            total_cost += float(t.get("amount") or 0)
    return total_cost


def _leg_pnl_and_cost(
    pos: dict, history: list, side: str, shares_yes: float, shares_no: float
) -> tuple[float, float]:
    """Allocate Simmer position PnL/cost to one leg (proportional when both legs open)."""
    mid = pos.get("market_id")
    if not mid:
        return 0.0, 0.0
    total_pnl = float(pos.get("pnl") or 0)
    total_cost_api = float(pos.get("cost_basis") or 0)
    cy = _net_leg_cost_from_history(history, str(mid), "yes")
    cn = _net_leg_cost_from_history(history, str(mid), "no")
    sl = side.lower()
    sy, sn = shares_yes, shares_no
    if sy >= 0.01 and sn < 0.01:
        cost = cy if cy > 0 else total_cost_api
        return total_pnl, max(cost, 1e-9)
    if sn >= 0.01 and sy < 0.01:
        cost = cn if cn > 0 else total_cost_api
        return total_pnl, max(cost, 1e-9)
    denom = cy + cn
    if denom > 0:
        cost_leg = cy if sl == "yes" else cn
        pnl_leg = total_pnl * (cost_leg / denom)
        return pnl_leg, max(cost_leg, 1e-9)
    tot_sh = sy + sn
    if total_cost_api > 0 and tot_sh > 0:
        frac = (sy / tot_sh) if sl == "yes" else (sn / tot_sh)
        cost_leg = total_cost_api * frac
        pnl_leg = total_pnl * frac
        return pnl_leg, max(cost_leg, 1e-9)
    return 0.0, 0.0


def _load_leg_peak_returns() -> dict[str, float]:
    if not MONITOR_LEG_PEAKS_PATH.exists():
        return {}
    try:
        raw = json.loads(MONITOR_LEG_PEAKS_PATH.read_text(encoding="utf-8"))
        peaks = raw.get("peaks") if isinstance(raw, dict) else raw
        out: dict[str, float] = {}
        if isinstance(peaks, dict):
            for k, v in peaks.items():
                if isinstance(v, dict) and "peak_return" in v:
                    out[str(k)] = float(v["peak_return"])
                else:
                    try:
                        out[str(k)] = float(v)
                    except (TypeError, ValueError):
                        continue
        return out
    except Exception:
        return {}


def _save_leg_peak_returns(peaks: dict[str, float]) -> None:
    MONITOR_LEG_PEAKS_PATH.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "peaks": peaks,
        "updated_at": datetime.now(timezone.utc).isoformat(),
    }
    MONITOR_LEG_PEAKS_PATH.write_text(json.dumps(payload, indent=2), encoding="utf-8")


def _extract_trade_fee_amount(trade: dict) -> float:
    for k in ("fee", "fee_amount", "fees", "total_fee"):
        v = trade.get(k)
        if v is None:
            continue
        if isinstance(v, (int, float)):
            return float(v)
        if isinstance(v, str):
            try:
                return float(v)
            except ValueError:
                continue
        if isinstance(v, dict):
            a = v.get("amount") or v.get("value")
            if a is not None:
                try:
                    return float(a)
                except (TypeError, ValueError):
                    continue
    return 0.0


def _aggregate_recent_fees(trades: list, max_n: int = 500) -> tuple[float, int]:
    chunk = trades[-max_n:] if len(trades) > max_n else trades
    return sum(_extract_trade_fee_amount(t) for t in chunk), len(chunk)


def run_position_monitor() -> dict:
    """
    Check each open leg (YES and NO independently). Force-close on stop-loss, optional
    fixed take-profit, return-based trailing giveback, max hold per leg, or pre-resolution trim.
    """
    api_key = os.environ.get("SIMMER_API_KEY")
    if not api_key:
        result = {"action": "none", "reason": "SIMMER_API_KEY not set", "closed": 0}
        _attach_runtime_telemetry(result, component="monitor", failure_code="missing_api_key")
        append_decision_event({"type": "monitor", **result})
        return result

    run_resolution_check()

    config = load_strategy_config()
    stop_loss_pct = float(config.get("stop_loss_pct", 0.10))
    take_profit_pct = config.get("take_profit_pct")
    if take_profit_pct is None:
        take_profit_pct = 0.50
    max_hold_hours = float(config.get("max_hold_hours", 48) or 0)
    venue = config.get("venue", "sim")
    trailing_on = bool(config.get("trailing_peak_return_enabled", False))
    giveback_pp = float(config.get("trailing_return_giveback_pp", 0.10))
    min_arm_ret = float(config.get("min_profit_return_to_trail", 0.05))

    positions = get_positions(api_key)
    history = load_trade_history()
    peaks = _load_leg_peak_returns()
    open_leg_keys: set[str] = set()
    closed = 0

    for pos in positions:
        if pos.get("status") != "active":
            continue
        if pos.get("venue") != venue:
            continue
        if not _position_has_material_shares(pos):
            continue

        market_id = pos.get("market_id")
        if not market_id:
            continue

        sy = float(pos.get("shares_yes") or 0)
        sn = float(pos.get("shares_no") or 0)
        legs: list[tuple[str, float]] = []
        if sy >= 0.01:
            legs.append(("yes", sy))
        if sn >= 0.01:
            legs.append(("no", sn))

        for side, shares in legs:
            leg_key = f"{market_id}:{side}"
            open_leg_keys.add(leg_key)

            # Grace period: skip all exit checks for positions younger than min_hold_minutes
            min_hold_min = float(config.get("min_hold_minutes_before_stop_loss", 5))
            if min_hold_min > 0:
                opened_at = _infer_position_opened_at(pos, history, side)
                if opened_at is not None:
                    if opened_at.tzinfo is None:
                        opened_at = opened_at.replace(tzinfo=timezone.utc)
                    held_min = (datetime.now(timezone.utc) - opened_at).total_seconds() / 60
                    if held_min < min_hold_min:
                        continue

            # Use local cost basis for current leg to avoid cumulative PNL distortion
            local_cost = _compute_local_cost_basis(history, market_id, side)
            if local_cost > 0:
                current_value = float(pos.get("current_value") or 0)
                if current_value > 0:
                    # For multi-leg positions, allocate current_value proportionally
                    if sy >= 0.01 and sn >= 0.01:
                        total_shares = sy + sn
                        leg_shares = sy if side == "yes" else sn
                        leg_value = current_value * (leg_shares / total_shares)
                    else:
                        leg_value = current_value
                    pnl_leg = leg_value - local_cost
                    cost_leg = local_cost
                else:
                    pnl_leg, cost_leg = _leg_pnl_and_cost(pos, history, side, sy, sn)
            else:
                pnl_leg, cost_leg = _leg_pnl_and_cost(pos, history, side, sy, sn)

            if cost_leg < 1e-9:
                continue
            ret = pnl_leg / cost_leg
            peak_trail = max(float(peaks.get(leg_key, ret)), ret)

            should_close = False
            reason = ""
            if ret <= -stop_loss_pct:
                should_close = True
                reason = f"stop-loss leg ({ret:.1%})"
            elif (not trailing_on) and take_profit_pct is not None and ret >= float(take_profit_pct):
                should_close = True
                reason = f"take-profit leg ({ret:.1%})"
            elif trailing_on and peak_trail >= min_arm_ret and (peak_trail - ret) >= giveback_pp:
                should_close = True
                reason = (
                    f"trailing giveback leg ({ret:.1%} vs peak {peak_trail:.1%}, "
                    f"Δ={(peak_trail - ret):.1%})"
                )

            if not should_close and ret < 0:
                resolves_at = pos.get("resolves_at") or pos.get("end_date") or ""
                if resolves_at:
                    try:
                        res_dt = datetime.fromisoformat(str(resolves_at).replace("Z", "+00:00"))
                        hours_left = (res_dt - datetime.now(timezone.utc)).total_seconds() / 3600
                        pre_res_thresh = max(0.01, stop_loss_pct * 0.5)
                        if 0 < hours_left < 2 and ret <= -pre_res_thresh:
                            should_close = True
                            reason = f"pre-resolution exit leg ({ret:.1%}, {hours_left:.1f}h left)"
                    except Exception:
                        pass

            if not should_close and max_hold_hours > 0:
                opened_at = _infer_position_opened_at(pos, history, side)
                if opened_at is not None:
                    if opened_at.tzinfo is None:
                        opened_at = opened_at.replace(tzinfo=timezone.utc)
                    held_h = (datetime.now(timezone.utc) - opened_at).total_seconds() / 3600
                    if held_h >= max_hold_hours:
                        should_close = True
                        reason = f"max-hold-time leg ({held_h:.1f}h >= {max_hold_hours}h)"

            if should_close:
                sell_res = sell_position(api_key, market_id, side, shares, venue)
                if sell_res and sell_res.get("success"):
                    closed += 1
                    peaks.pop(leg_key, None)
                    append_trade({
                        "trade_id": sell_res.get("trade_id", ""),
                        "market_id": market_id,
                        "side": side,
                        "action": "sell",
                        "amount": 0,
                        "shares": shares,
                        "venue": venue,
                        "created_at": datetime.now(timezone.utc).isoformat(),
                        "source": "sdk:rookie",
                        "reason": reason,
                    })
                    state = load_game_state()
                    dedup_key = f"{leg_key}:{sell_res.get('trade_id') or uuid4().hex}"
                    already = set(state.get("processed_resolved_ids", []))
                    if dedup_key not in already:
                        process_trade_resolution(state, pnl_leg, cost_leg, [])
                        state = load_game_state()
                        _update_daily_realized_and_pause(state, config, pnl_leg)
                    other_leg = sn if side == "yes" else sy
                    state = load_game_state()
                    if other_leg < 0.01:
                        state = _mark_market_cooldown(state, str(market_id))
                        _prune_market_theme_hint(state, market_id)
                    state = load_game_state()
                    already = set(state.get("processed_resolved_ids", []))
                    already.add(dedup_key)
                    state["processed_resolved_ids"] = list(already)[-500:]
                    save_game_state(state)
                    append_model_label({
                        "market_id": market_id,
                        "side": side,
                        "trade_exec_key": dedup_key,
                        "pnl": pnl_leg,
                        "cost_basis": cost_leg,
                        "return_pct": ret,
                        "peak_return": peak_trail,
                        "won": pnl_leg > 0,
                        "source": "monitor-close",
                    })
            else:
                peaks[leg_key] = peak_trail

    peaks = {k: v for k, v in peaks.items() if k in open_leg_keys}
    _save_leg_peak_returns(peaks)

    result = {"action": "closed" if closed else "none", "reason": "ok", "closed": closed}
    _attach_runtime_telemetry(
        result,
        component="monitor",
        extra={"positions_checked": len([p for p in positions if p.get("status") == "active"])},
    )
    append_decision_event({"type": "monitor", **result})
    return result


def run_resolution_check() -> int:
    """
    Fetch resolved positions from Simmer, process any not yet seen.
    Returns count of newly processed resolutions.
    """
    api_key = os.environ.get("SIMMER_API_KEY")
    if not api_key:
        return 0

    state = load_game_state()

    processed = set(state.get("processed_resolved_ids", []))
    initial_processed = len(processed)
    all_positions = get_positions(api_key)
    resolved = [p for p in all_positions if p.get("status") == "resolved"]
    newly_processed = 0

    for pos in resolved:
        market_id = pos.get("market_id")
        side = "yes" if (pos.get("shares_yes") or 0) > 0 else ("no" if (pos.get("shares_no") or 0) > 0 else "unknown")
        resolved_at = str(pos.get("resolved_at") or pos.get("updated_at") or pos.get("end_date") or "")
        dedup_id = f"{market_id}:{side}:{resolved_at}:{float(pos.get('cost_basis') or 0):.6f}"
        if not market_id or dedup_id in processed:
            continue

        cost_basis = pos.get("cost_basis") or 0
        pnl = pos.get("pnl") or 0
        if cost_basis <= 0:
            processed.add(dedup_id)
            continue

        state = load_game_state()

        process_trade_resolution(state, pnl, cost_basis, [])
        state = load_game_state()
        config = load_strategy_config()
        _update_daily_realized_and_pause(state, config, pnl)
        state = _mark_market_cooldown(state, market_id)
        _prune_market_theme_hint(state, market_id)
        append_model_label({
            "market_id": market_id,
            "side": side,
            "trade_exec_key": dedup_id,
            "pnl": pnl,
            "cost_basis": cost_basis,
            "return_pct": (pnl / cost_basis) if cost_basis else 0,
            "won": pnl > 0,
            "source": "resolved-position",
        })
        processed.add(dedup_id)
        newly_processed += 1

    if newly_processed > 0 or len(processed) != initial_processed:
        state = load_game_state()
        state["processed_resolved_ids"] = list(processed)[-500:]
        save_game_state(state)

    return newly_processed


def process_fee_and_report() -> dict:
    """Simmer-centric snapshot for the scheduler (positions, trades, fees, ledger counters)."""
    state = load_game_state()
    run_resolution_check()

    api_key = os.environ.get("SIMMER_API_KEY")
    briefing = get_briefing(api_key) if api_key else None
    venue = load_strategy_config().get("venue", "sim")
    trades = get_trades(api_key, str(venue)) if api_key else []
    positions = get_positions(api_key) if api_key else []
    fee_sum, fee_n = _aggregate_recent_fees(trades, max_n=500)
    agent_me = get_agent_me(api_key) if api_key else None

    now_iso = datetime.now(timezone.utc).isoformat()
    state = {**state, "last_report_at": now_iso}
    save_game_state(state)

    return {
        "alive": True,
        "state": state,
        "report": {
            "wins": state.get("wins"),
            "losses": state.get("losses"),
            "trades_count": state.get("trades_count"),
            "positions_count": len(positions),
            "briefing": briefing,
            "trades_sample": trades[-10:] if trades else [],
            "fees_recent_sum": fee_sum,
            "fees_recent_trade_count": fee_n,
            "simmer_agent": agent_me,
        },
    }
