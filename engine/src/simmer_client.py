"""Simmer.markets API client with 200 $SIM budget cap. Uses both SDK and direct API."""
import os
from typing import Any, Optional

import httpx
from dotenv import load_dotenv

from .config import MAX_BUDGET_SIM

load_dotenv()

SIMMER_API_BASE = "https://api.simmer.markets"
_simmer_client_sdk = None


def get_simmer_client():
    """Get Simmer SDK client if API key set. Returns None otherwise."""
    global _simmer_client_sdk
    if _simmer_client_sdk is not None:
        return _simmer_client_sdk

    api_key = os.environ.get("SIMMER_API_KEY")
    if not api_key:
        return None

    try:
        from simmer_sdk import SimmerClient as SDKClient

        venue = os.environ.get("TRADING_VENUE", "sim")
        _simmer_client_sdk = SDKClient(api_key=api_key, venue=venue)
        return _simmer_client_sdk
    except ImportError:
        return None


def _api_request(
    method: str,
    path: str,
    api_key: Optional[str] = None,
    json_body: Optional[dict] = None,
    params: Optional[dict] = None,
) -> Optional[dict]:
    """Make direct API request to Simmer."""
    key = api_key or os.environ.get("SIMMER_API_KEY")
    if not key:
        return None
    url = f"{SIMMER_API_BASE}{path}"
    headers = {"Authorization": f"Bearer {key}", "Content-Type": "application/json"}
    try:
        with httpx.Client(timeout=30.0) as client:
            r = client.request(method, url, json=json_body, params=params, headers=headers)
            r.raise_for_status()
            return r.json() if r.content else {}
    except Exception:
        return None


def get_agent_me(api_key: Optional[str] = None) -> Optional[dict]:
    """Get current agent details (balance, status, PnL)."""
    return _api_request("GET", "/api/sdk/agents/me", api_key=api_key)


def get_effective_balance(api_key: Optional[str] = None) -> float:
    """Return effective balance capped at MAX_BUDGET_SIM."""
    data = get_agent_me(api_key)
    if not data:
        return 0.0
    balance = data.get("balance") or data.get("sim_balance") or 0
    return min(float(balance), MAX_BUDGET_SIM)


def get_positions(api_key: Optional[str] = None) -> list[dict]:
    """Fetch positions from Simmer (active and resolved)."""
    data = _api_request("GET", "/api/sdk/positions", api_key=api_key)
    if not data:
        return []
    return data.get("positions", [])


def get_trades(api_key: Optional[str] = None, venue: str = "sim") -> list[dict]:
    """Fetch trade history from Simmer."""
    data = _api_request("GET", "/api/sdk/trades", api_key=api_key, params={"venue": venue})
    if not data:
        return []
    if isinstance(data, list):
        return data
    trades = data.get("trades", [])
    return trades if isinstance(trades, list) else []


def get_briefing(api_key: Optional[str] = None) -> Optional[dict]:
    """Fetch briefing (portfolio, positions, opportunities, performance)."""
    return _api_request("GET", "/api/sdk/briefing", api_key=api_key)


def get_opportunities(
    api_key: Optional[str] = None,
    limit: int = 10,
    min_divergence: float = 0.03,
) -> list[dict]:
    """Fetch trading opportunities. Handles both 'markets' and 'opportunities' response keys."""
    data = _api_request(
        "GET",
        "/api/sdk/markets/opportunities",
        api_key=api_key,
        params={"limit": limit, "min_divergence": min_divergence},
    )
    if not data:
        return []
    items = data.get("markets") or data.get("opportunities")
    if isinstance(items, list):
        return items
    return data if isinstance(data, list) else []


def get_market_context(api_key: Optional[str] = None, market_id: str = "") -> Optional[dict]:
    """Fetch market context (fee_rate_bps, safeguards, flip-flop warnings)."""
    if not market_id:
        return None
    return _api_request("GET", f"/api/sdk/context/{market_id}", api_key=api_key)


def sell_position(
    api_key: Optional[str] = None,
    market_id: str = "",
    side: str = "yes",
    shares: float = 0,
    venue: str = "sim",
) -> Optional[dict]:
    """Sell/close a position. Returns trade result or None."""
    if not market_id or shares < 1:
        return None
    body = {
        "market_id": market_id,
        "side": side,
        "action": "sell",
        "shares": round(shares, 2),
        "amount": 0,
        "venue": venue,
        "source": "sdk:rookie",
        "reasoning": "Stop-loss or take-profit",
    }
    return _api_request("POST", "/api/sdk/trade", api_key=api_key, json_body=body)


def check_health() -> dict:
    """Check Simmer API health. Returns {status, latency_ms}."""
    try:
        import time
        start = time.perf_counter()
        r = httpx.get(f"{SIMMER_API_BASE}/api/sdk/health", timeout=5.0)
        latency_ms = (time.perf_counter() - start) * 1000
        return {"status": "green" if r.status_code == 200 else "red", "latency_ms": round(latency_ms, 0)}
    except Exception:
        return {"status": "red", "latency_ms": None}
