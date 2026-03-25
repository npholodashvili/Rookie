"""OpenClaw webhook client for wake and agent messages."""
import json
import os
from pathlib import Path
from typing import Optional

import httpx
from dotenv import load_dotenv

from .config import PROJECT_ROOT, STRATEGY_CONFIG_PATH

load_dotenv()

STRATEGY_PATH_ABSOLUTE = str(STRATEGY_CONFIG_PATH.resolve())


def is_configured() -> bool:
    """Return True if OpenClaw URL and token are set."""
    return bool(os.environ.get("OPENCLAW_URL") and os.environ.get("OPENCLAW_HOOKS_TOKEN"))


def _hooks_base() -> str:
    """Base URL for hooks (e.g. http://host:port/hooks)."""
    base = os.environ.get("OPENCLAW_URL", "").rstrip("/")
    path = os.environ.get("OPENCLAW_HOOKS_PATH", "/hooks").strip().rstrip("/") or "/hooks"
    if not path.startswith("/"):
        path = "/" + path
    return base + path


def wake(text: str, mode: str = "now") -> bool:
    """POST to {path}/wake. Returns True if successful."""
    url = _hooks_base() + "/wake"
    token = os.environ.get("OPENCLAW_HOOKS_TOKEN")
    if not url or not token:
        return False
    try:
        r = httpx.post(
            url,
            json={"text": text, "mode": mode},
            headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
            timeout=10.0,
        )
        return r.status_code == 200
    except Exception:
        return False


def send_agent_message(
    message: str,
    name: str = "Rookie",
    wake_mode: str = "now",
) -> bool:
    """POST to {path}/agent. Returns True if successful."""
    url = _hooks_base() + "/agent"
    token = os.environ.get("OPENCLAW_HOOKS_TOKEN")
    if not url or not token:
        return False
    try:
        r = httpx.post(
            url,
            json={
                "message": message,
                "name": name,
                "wakeMode": wake_mode,
            },
            headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
            timeout=30.0,
        )
        return r.status_code == 200
    except Exception:
        return False


def wake_on_10th_trade(trade_count: int, wins: int, losses: int) -> bool:
    """Wake OpenClaw on every 10th trade with strategy path and win/loss."""
    if trade_count <= 0 or trade_count % 10 != 0:
        return False
    text = (
        f"10th trade completed (total={trade_count}). "
        f"Win/loss: {wins}/{losses}. "
        f"Strategy config path: {STRATEGY_PATH_ABSOLUTE}"
    )
    return wake(text, mode="now")


def request_strategy_adjustment(wins: int, losses: int, config_snapshot: dict) -> bool:
    """Ask OpenClaw to adjust strategy when win/loss < 70/30."""
    total = wins + losses
    if total < 5:
        return False
    ratio = wins / total if total > 0 else 0
    if ratio >= 0.7:
        return False

    message = (
        f"Win/loss ratio is {wins}/{losses} ({ratio:.0%}) — below 70% target. "
        f"Please adjust strategy at: {STRATEGY_PATH_ABSOLUTE}. "
        f"Current config: {json.dumps(config_snapshot, indent=2)}"
    )
    return send_agent_message(message, name="Rookie-StrategyAdjust")


def check_health() -> dict:
    """Check OpenClaw webhook reachability. Returns {status, latency_ms}."""
    if not is_configured():
        return {"status": "unconfigured", "latency_ms": None}
    try:
        import time
        start = time.perf_counter()
        ok = wake("Health check", mode="now")
        latency_ms = (time.perf_counter() - start) * 1000
        return {"status": "green" if ok else "red", "latency_ms": round(latency_ms, 0)}
    except Exception:
        return {"status": "red", "latency_ms": None}
