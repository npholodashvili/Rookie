"""Game Master: score tracking, rules enforcement, death trigger, graveyard."""
import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from .config import GAME_STATE_PATH, GRAVEYARD_PATH, STRATEGY_CONFIG_PATH, TRADE_HISTORY_PATH


def load_game_state() -> dict:
    """Load game state from JSON."""
    if not GAME_STATE_PATH.exists():
        return _default_game_state()
    try:
        with open(GAME_STATE_PATH, "r") as f:
            data = json.load(f)
        return {**_default_game_state(), **data}
    except Exception:
        return _default_game_state()


def _default_game_state() -> dict:
    return {
        "points": 100,
        "trades_count": 0,
        "wins": 0,
        "losses": 0,
        "last_report_at": None,
        "last_fee_at": None,
        "alive": True,
        "agent_id": None,
        "started_at": None,
        "processed_resolved_ids": [],
        "last_trade_at": None,
        "cycles_without_trade": 0,
        "consecutive_losses": 0,
        "daily_realized_pnl": 0.0,
        "daily_realized_pnl_date": None,
        "pause_until": None,
        "last_model_eval_at": None,
        "last_model_apply_at": None,
        "market_reentry_cooldowns": {},
        "market_theme_hints": {},
        "loss_streak_entry_pause_until": None,
    }


def save_game_state(state: dict) -> None:
    """Persist game state."""
    GAME_STATE_PATH.parent.mkdir(parents=True, exist_ok=True)
    with open(GAME_STATE_PATH, "w") as f:
        json.dump(state, f, indent=2)


def apply_win(state: dict) -> dict:
    """+1 point for win."""
    state["points"] = state.get("points", 100) + 1
    state["wins"] = state.get("wins", 0) + 1
    return state


def apply_loss(state: dict) -> dict:
    """-1 point for loss."""
    state["points"] = max(0, state.get("points", 100) - 1)
    state["losses"] = state.get("losses", 0) + 1
    return state


def apply_bonus(state: dict) -> dict:
    """+2 points if trade profit >= 50% of investment."""
    state["points"] = state.get("points", 100) + 2
    return state


def apply_fee(state: dict) -> dict:
    """-1 point every 2 hours."""
    state["points"] = max(0, state.get("points", 100) - 1)
    state["last_fee_at"] = datetime.now(timezone.utc).isoformat()
    return state


def apply_missed_report(state: dict) -> dict:
    """-1 point for missed report."""
    state["points"] = max(0, state.get("points", 100) - 1)
    return state


def apply_lying(state: dict) -> dict:
    """-2 points for lying/fabrication."""
    state["points"] = max(0, state.get("points", 100) - 2)
    return state


def record_report(state: dict) -> dict:
    """Mark report as sent."""
    state["last_report_at"] = datetime.now(timezone.utc).isoformat()
    return state


def check_death(state: dict) -> bool:
    """Return True if agent is dead (points <= 0)."""
    return state.get("points", 100) <= 0 and state.get("alive", True)


def trigger_death(
    state: dict,
    reason: str = "Points depleted",
    improvements: str = "Execute more winning trades than losing. Adjust strategy when win/loss < 70/30.",
) -> dict:
    """Write to graveyard, set alive=false, return updated state."""
    state["alive"] = False
    state["died_at"] = datetime.now(timezone.utc).isoformat()

    record = {
        "agent_id": state.get("agent_id"),
        "died_at": state["died_at"],
        "final_points": state.get("points", 0),
        "lifecycle": {
            "trades": state.get("trades_count", 0),
            "wins": state.get("wins", 0),
            "losses": state.get("losses", 0),
            "duration_hours": _duration_hours(state),
        },
        "reason": reason,
        "improvements": improvements,
    }

    graveyard = []
    if GRAVEYARD_PATH.exists():
        try:
            with open(GRAVEYARD_PATH, "r") as f:
                graveyard = json.load(f)
        except Exception:
            pass

    graveyard.append(record)
    GRAVEYARD_PATH.parent.mkdir(parents=True, exist_ok=True)
    with open(GRAVEYARD_PATH, "w") as f:
        json.dump(graveyard, f, indent=2)

    save_game_state(state)
    return state


def _duration_hours(state: dict) -> float:
    """Compute lifecycle duration in hours."""
    started = state.get("started_at")
    died = state.get("died_at")
    if not started or not died:
        return 0.0
    try:
        s = datetime.fromisoformat(started.replace("Z", "+00:00"))
        d = datetime.fromisoformat(died.replace("Z", "+00:00"))
        return (d - s).total_seconds() / 3600
    except Exception:
        return 0.0


def _strategy_snapshot_for_pause() -> dict:
    try:
        return json.loads(STRATEGY_CONFIG_PATH.read_text(encoding="utf-8"))
    except Exception:
        return {}


def maybe_set_loss_streak_entry_pause(state: dict) -> None:
    """Pause new entries (not monitor) after N consecutive losses — reads strategy file."""
    cfg = _strategy_snapshot_for_pause()
    th = int(cfg.get("loss_streak_pause_threshold", 0))
    if th <= 0:
        return
    if int(state.get("consecutive_losses", 0)) < th:
        return
    minutes = max(5, int(cfg.get("loss_streak_pause_minutes", 45)))
    until = datetime.now(timezone.utc).timestamp() + minutes * 60
    state["loss_streak_entry_pause_until"] = datetime.fromtimestamp(until, timezone.utc).isoformat()


def process_trade_resolution(
    state: dict,
    pnl: float,
    cost_basis: float,
    simmer_trades: list,
) -> dict:
    """
    Apply win/loss/bonus based on trade outcome.
    simmer_trades: list from Simmer API for validation (anti-lying).
    """
    if not state.get("alive", True):
        return state

    if pnl > 0:
        state = apply_win(state)
        state["consecutive_losses"] = 0
        state.pop("loss_streak_entry_pause_until", None)
        if cost_basis > 0 and (pnl / cost_basis) >= 0.5:
            state = apply_bonus(state)
    else:
        state = apply_loss(state)
        state["consecutive_losses"] = state.get("consecutive_losses", 0) + 1
        maybe_set_loss_streak_entry_pause(state)

    save_game_state(state)

    if check_death(state):
        state = trigger_death(state)

    return state
