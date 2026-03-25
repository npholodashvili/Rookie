"""Trade executor: fetch opportunities, execute trades, set risk monitor, persist history."""
import json
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from dotenv import load_dotenv

from .config import (
    DECISION_JOURNAL_PATH,
    MAX_BUDGET_SIM,
    MODEL_FEATURES_PATH,
    MODEL_LABELS_PATH,
    STRATEGY_CONFIG_PATH,
    TRADE_HISTORY_PATH,
)
from .game_master import (
    apply_fee,
    check_death,
    load_game_state,
    process_trade_resolution,
    save_game_state,
    trigger_death,
)
from .openclaw_client import request_strategy_adjustment, wake_on_10th_trade
from .offline_evaluator import evaluate_offline
from .simmer_client import (
    _api_request,
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
        "max_hold_hours": 24,
        "max_total_exposure_pct": 0.60,
        "venue": "sim",
        "signal_sources": ["simmer", "openclaw"],
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
        "allow_relax_min_divergence": True,
        "allow_zero_divergence_fallback_scan": True,
        "allow_fallback_activity_trade": True,
        "persist_auto_regime_to_disk": True,
        "skill": "built-in",
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
    history = load_trade_history()
    history.append(trade)
    TRADE_HISTORY_PATH.parent.mkdir(parents=True, exist_ok=True)
    with open(TRADE_HISTORY_PATH, "w") as f:
        json.dump(history, f, indent=2)


def append_decision_event(event: dict) -> None:
    """Append cycle/monitor decision event to JSONL journal for analytics."""
    record = {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        **event,
    }
    DECISION_JOURNAL_PATH.parent.mkdir(parents=True, exist_ok=True)
    with open(DECISION_JOURNAL_PATH, "a", encoding="utf-8") as f:
        f.write(json.dumps(record) + "\n")


def append_model_feature(sample: dict) -> None:
    """Append executed-trade feature sample for offline evaluation."""
    record = {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        **sample,
    }
    MODEL_FEATURES_PATH.parent.mkdir(parents=True, exist_ok=True)
    with open(MODEL_FEATURES_PATH, "a", encoding="utf-8") as f:
        f.write(json.dumps(record) + "\n")


def append_model_label(label: dict) -> None:
    """Append resolved outcome label for model training/evaluation."""
    record = {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        **label,
    }
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
        "reasoning": reasoning or "Rookie trading game",
        "dry_run": dry_run,
    }

    data = _api_request("POST", "/api/sdk/trade", api_key=api_key, json_body=body)
    if not data:
        return None

    if not dry_run and data.get("trade_id"):
        append_trade({
            "trade_id": data.get("trade_id"),
            "market_id": market_id,
            "side": side,
            "action": "buy",
            "amount": amount,
            "venue": venue,
            "created_at": datetime.now(timezone.utc).isoformat(),
            "source": source,
        })

        # Set risk monitor
        stop_loss = config.get("stop_loss_pct", 0.10)
        take_profit = config.get("take_profit_pct")
        set_risk_monitor(market_id, side, stop_loss, take_profit)
        if feature_sample:
            append_model_feature({
                **feature_sample,
                "trade_id": data.get("trade_id"),
                "market_id": market_id,
                "side": side,
                "amount": amount,
                "mode": config.get("strategy_mode", "balanced"),
            })

    return data


def _apply_strategy_optimization(state: dict, config: dict) -> dict:
    """Auto-adjust strategy mode and parameters based on performance."""
    if not config.get("auto_regime", True):
        return config

    wins = state.get("wins", 0)
    losses = state.get("losses", 0)
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
    eval_result = evaluate_offline(
        return_clip=float(config.get("evaluator_return_clip", 3.0)),
        label_sources=ev_sources,
        monitor_close_weight=float(config.get("evaluator_monitor_close_weight", 1.0)),
        time_split_validate=bool(config.get("evaluator_time_split_validate", True)),
        time_split_train_fraction=float(config.get("evaluator_time_split_train_fraction", 0.75)),
        min_holdout_rows=int(config.get("evaluator_min_holdout_rows", 12)),
        holdout_min_delta=float(config.get("evaluator_holdout_min_delta", 0.02)),
    )
    state = load_game_state()
    state["last_model_eval_at"] = datetime.now(timezone.utc).isoformat()
    save_game_state(state)

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

        state = load_game_state()
        state["last_model_apply_at"] = datetime.now(timezone.utc).isoformat()
        save_game_state(state)
        return {**config, **merged}
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


def run_trading_cycle() -> dict:
    """
    Run one trading cycle: fetch opportunities, maybe trade, update game state.
    Returns summary dict for backend/UI.
    """
    api_key = os.environ.get("SIMMER_API_KEY")
    state = load_game_state()

    if not state.get("alive", True):
        result = {"alive": False, "state": state, "action": "none", "reason": "agent dead"}
        append_decision_event({"type": "cycle", **result})
        return result

    if not api_key:
        result = {"alive": True, "state": state, "action": "none", "reason": "SIMMER_API_KEY not set"}
        append_decision_event({"type": "cycle", **result})
        return result

    review_mode = _is_paused(state)

    config = load_strategy_config()
    config = _apply_strategy_optimization(state, config)
    config = _maybe_auto_apply_evaluator(state, config)
    # Refresh in-memory state in case evaluator/update helpers persisted new fields.
    state = load_game_state()
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

    balance = get_effective_balance(api_key)
    positions = get_positions(api_key)
    active_exposure = _active_exposure_usd(positions)

    if balance <= 0:
        result = {"alive": True, "state": state, "action": "skip", "reason": "balance is 0"}
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
        append_decision_event({"type": "cycle", **result})
        return result
    max_exposure = balance * float(config.get("max_total_exposure_pct", 0.60))
    if active_exposure >= max_exposure:
        result = {"alive": True, "state": state, "action": "skip", "reason": "max exposure"}
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
                append_decision_event({"type": "cycle", **result})
                return result
        except Exception:
            pass

    run_resolution_check()

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
        and not candidates
    ):
        candidates = get_opportunities(api_key, limit=20, min_divergence=0.0)
        fallback_mode = True

    min_hours_to_resolution = float(config.get("min_hours_to_resolution", 4))
    max_hours_to_resolution = float(config.get("max_hours_to_resolution", 0))
    passing: list[dict] = []
    chosen_best: Optional[dict] = None

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

        resolves_at = opp.get("resolves_at") or opp.get("end_date") or ""
        if resolves_at:
            try:
                res_dt = datetime.fromisoformat(str(resolves_at).replace("Z", "+00:00"))
                hours_left = (res_dt - datetime.now(timezone.utc)).total_seconds() / 3600
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

        feature_sample = {
            "market_id": market_id,
            "question": str(opp.get("question") or opp.get("title") or opp.get("name") or ""),
            "market_type": _infer_market_type(str(opp.get("question") or opp.get("title") or opp.get("name") or "")),
            "edge": edge,
            "expected_edge": expected_edge,
            "fee_bps": fee_bps,
            "slippage_pct": est_slip,
            "volume_24h": volume,
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
                "sort_key": _candidate_sort_key(expected_edge, volume, edge, str(market_id)),
            }
        )

    if passing:
        chosen_best = sorted(passing, key=lambda x: x["sort_key"])[0]
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

            if wake_on_10th_trade(state["trades_count"], state.get("wins", 0), state.get("losses", 0)):
                pass

            win_ratio = state["wins"] / max(1, state["wins"] + state["losses"])
            if win_ratio < 0.7 and state["wins"] + state["losses"] >= 5:
                request_strategy_adjustment(state["wins"], state["losses"], config)

    if action != "traded" and cycles_without >= 8 and config.get("allow_fallback_activity_trade", True):
        relaxed = get_opportunities(api_key, limit=20, min_divergence=0.0)
        if relaxed:
            relaxed = sorted(relaxed, key=lambda x: abs(x.get("divergence") or 0), reverse=True)
            top = relaxed[0]
            market_id = top.get("id")
            if market_id and not _is_market_on_cooldown(state, market_id, market_reentry_cooldown):
                div = top.get("divergence") or 0
                side = "yes" if div > 0 else "no"
                fallback_amount = min(float(config.get("fallback_trade_usd", 1.0)), max_pos_usd, max(1.0, balance * 0.01))
                result = execute_trade(
                    market_id,
                    side,
                    fallback_amount,
                    dry_run=False,
                    reasoning="Fallback activity trade after 2h inactivity",
                    feature_sample={
                        "market_id": market_id,
                        "question": str(top.get("question") or top.get("title") or top.get("name") or ""),
                        "market_type": _infer_market_type(str(top.get("question") or top.get("title") or top.get("name") or "")),
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

    result = {
        "alive": state.get("alive", True),
        "state": state,
        "action": action,
        "reason": f"{reason} (review mode)" if review_mode else reason,
        "decision": {
            "scanned": len(candidates),
            "candidates_passing": len(passing),
            "picked": picked,
            "skips": skip_reasons,
            "fallback_mode": fallback_mode,
        },
    }
    append_decision_event({"type": "cycle", **result})
    return result


def _parse_iso_datetime(value: Optional[str]) -> Optional[datetime]:
    if not value:
        return None
    try:
        return datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except Exception:
        return None


def _infer_position_opened_at(pos: dict, history: list) -> Optional[datetime]:
    """Best-effort entry time: Simmer fields, else local trade_history (current open leg)."""
    for key in ("opened_at", "created_at", "entered_at"):
        dt = _parse_iso_datetime(pos.get(key))
        if dt is not None:
            return dt

    market_id = pos.get("market_id")
    if not market_id:
        return None
    side = None
    if (pos.get("shares_yes") or 0) > 0:
        side = "yes"
    elif (pos.get("shares_no") or 0) > 0:
        side = "no"
    if not side:
        return None

    relevant = [t for t in history if t.get("market_id") == market_id and t.get("side") == side]
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
    return opened


def run_position_monitor() -> dict:
    """
    Check positions every run. Force-close on stop-loss, take-profit, max hold time,
    or pre-resolution trim. Called every 1 minute by scheduler.
    """
    api_key = os.environ.get("SIMMER_API_KEY")
    if not api_key:
        result = {"action": "none", "reason": "SIMMER_API_KEY not set", "closed": 0}
        append_decision_event({"type": "monitor", **result})
        return result

    run_resolution_check()

    config = load_strategy_config()
    stop_loss_pct = float(config.get("stop_loss_pct", 0.10))
    take_profit_pct = config.get("take_profit_pct")
    if take_profit_pct is None:
        take_profit_pct = 0.50
    max_hold_hours = float(config.get("max_hold_hours", 24) or 0)
    venue = config.get("venue", "sim")

    positions = get_positions(api_key)
    history = load_trade_history()
    closed = 0
    for pos in positions:
        if pos.get("status") != "active":
            continue
        if pos.get("venue") != venue:
            continue
        if not _position_has_material_shares(pos):
            continue

        market_id = pos.get("market_id")
        cost_basis = pos.get("cost_basis") or 0
        pnl = pos.get("pnl") or 0
        if cost_basis <= 0:
            continue

        pnl_pct = pnl / cost_basis

        side = None
        shares = 0
        if (pos.get("shares_yes") or 0) > 0:
            side = "yes"
            shares = pos.get("shares_yes") or 0
        elif (pos.get("shares_no") or 0) > 0:
            side = "no"
            shares = pos.get("shares_no") or 0

        if not side or shares < 1:
            continue

        should_close = False
        reason = ""
        if pnl_pct <= -stop_loss_pct:
            should_close = True
            reason = f"stop-loss ({pnl_pct:.1%})"
        elif take_profit_pct is not None and pnl_pct >= take_profit_pct:
            should_close = True
            reason = f"take-profit ({pnl_pct:.1%})"

        if not should_close and pnl_pct < 0:
            resolves_at = pos.get("resolves_at") or pos.get("end_date") or ""
            if resolves_at:
                try:
                    res_dt = datetime.fromisoformat(str(resolves_at).replace("Z", "+00:00"))
                    hours_left = (res_dt - datetime.now(timezone.utc)).total_seconds() / 3600
                    pre_res_thresh = max(0.01, stop_loss_pct * 0.5)
                    if 0 < hours_left < 2 and pnl_pct <= -pre_res_thresh:
                        should_close = True
                        reason = f"pre-resolution exit ({pnl_pct:.1%}, {hours_left:.1f}h left)"
                except Exception:
                    pass

        if not should_close and max_hold_hours > 0:
            opened_at = _infer_position_opened_at(pos, history)
            if opened_at is not None:
                if opened_at.tzinfo is None:
                    opened_at = opened_at.replace(tzinfo=timezone.utc)
                held_h = (datetime.now(timezone.utc) - opened_at).total_seconds() / 3600
                if held_h >= max_hold_hours:
                    should_close = True
                    reason = f"max-hold-time ({held_h:.1f}h >= {max_hold_hours}h)"

        if should_close:
            result = sell_position(api_key, market_id, side, shares, venue)
            if result and result.get("success"):
                closed += 1
                append_trade({
                    "trade_id": result.get("trade_id", ""),
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
                if state.get("alive", True):
                    dedup_key = f"{market_id}:{side}"
                    already = set(state.get("processed_resolved_ids", []))
                    if dedup_key not in already:
                        process_trade_resolution(state, pnl, cost_basis, [])
                        state = load_game_state()
                        _update_daily_realized_and_pause(state, config, pnl)
                    state = _mark_market_cooldown(state, market_id)
                    already = set(state.get("processed_resolved_ids", []))
                    already.add(dedup_key)
                    state["processed_resolved_ids"] = list(already)[-500:]
                    save_game_state(state)
                append_model_label({
                    "market_id": market_id,
                    "side": side,
                    "pnl": pnl,
                    "cost_basis": cost_basis,
                    "return_pct": (pnl / cost_basis) if cost_basis else 0,
                    "won": pnl > 0,
                    "source": "monitor-close",
                })

    result = {"action": "closed" if closed else "none", "reason": "ok", "closed": closed}
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
    if not state.get("alive", True):
        return 0

    processed = set(state.get("processed_resolved_ids", []))
    initial_processed = len(processed)
    all_positions = get_positions(api_key)
    resolved = [p for p in all_positions if p.get("status") == "resolved"]
    newly_processed = 0

    for pos in resolved:
        market_id = pos.get("market_id")
        side = "yes" if (pos.get("shares_yes") or 0) > 0 else ("no" if (pos.get("shares_no") or 0) > 0 else "unknown")
        dedup_id = f"{market_id}:{side}"
        if not market_id or dedup_id in processed:
            continue

        cost_basis = pos.get("cost_basis") or 0
        pnl = pos.get("pnl") or 0
        if cost_basis <= 0:
            processed.add(dedup_id)
            continue

        state = load_game_state()
        if not state.get("alive", True):
            break

        process_trade_resolution(state, pnl, cost_basis, [])
        state = load_game_state()
        config = load_strategy_config()
        _update_daily_realized_and_pause(state, config, pnl)
        state = _mark_market_cooldown(state, market_id)
        append_model_label({
            "market_id": market_id,
            "side": side,
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
    """Apply 2h fee and generate report. Called by backend scheduler."""
    state = load_game_state()
    if not state.get("alive", True):
        return {"alive": False, "state": state}

    run_resolution_check()

    state = apply_fee(state)
    save_game_state(state)

    if check_death(state):
        state = trigger_death(state)
        return {"alive": False, "state": state}

    # Build report from Simmer
    api_key = os.environ.get("SIMMER_API_KEY")
    briefing = get_briefing(api_key) if api_key else None
    trades = get_trades(api_key, "sim") if api_key else []
    positions = get_positions(api_key) if api_key else []

    state = {**state, "last_report_at": state.get("last_fee_at")}
    save_game_state(state)

    return {
        "alive": True,
        "state": state,
        "report": {
            "points": state.get("points"),
            "wins": state.get("wins"),
            "losses": state.get("losses"),
            "trades_count": state.get("trades_count"),
            "positions_count": len(positions),
            "briefing": briefing,
            "trades_sample": trades[-10:] if trades else [],
        },
    }
