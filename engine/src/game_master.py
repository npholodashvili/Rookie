"""Runtime state: trade ledger counters, pauses, cooldowns (no game points / death)."""
import json
from datetime import datetime, timezone
from pathlib import Path

from .config import GAME_STATE_PATH, STRATEGY_CONFIG_PATH
from .io_utils import atomic_write_json, file_lock


def load_game_state() -> dict:
    """Load persisted runtime state."""
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
        "trades_count": 0,
        "wins": 0,
        "losses": 0,
        "last_report_at": None,
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
    """Persist runtime state."""
    with file_lock(GAME_STATE_PATH):
        atomic_write_json(GAME_STATE_PATH, state)


def apply_win(state: dict) -> dict:
    state["wins"] = state.get("wins", 0) + 1
    return state


def apply_loss(state: dict) -> dict:
    state["losses"] = state.get("losses", 0) + 1
    return state


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
    """Update win/loss counters and streaks from a closed or resolved trade (economic outcome)."""
    if pnl > 0:
        state = apply_win(state)
        state["consecutive_losses"] = 0
        state.pop("loss_streak_entry_pause_until", None)
    else:
        state = apply_loss(state)
        state["consecutive_losses"] = state.get("consecutive_losses", 0) + 1
        maybe_set_loss_streak_entry_pause(state)

    save_game_state(state)
    return state
