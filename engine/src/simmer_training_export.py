"""Build label rows from Simmer `get_trades` for offline evaluation (Simmer-canonical path).

Join to `model_features.jsonl` on `market_id` + `side`, or `trade_id` when both rows include it.
Run: python -m engine.src.main export-simmer-labels
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Optional

from .config import MODEL_LABELS_SIMMER_PATH
from .simmer_client import get_trades


def _num(x: Any) -> Optional[float]:
    if x is None:
        return None
    try:
        v = float(x)
        return v if v == v else None  # NaN
    except (TypeError, ValueError):
        return None


def trade_to_label_row(t: dict[str, Any]) -> Optional[dict[str, Any]]:
    """One label row per trade when economics are present (best-effort across API shapes)."""
    mid = t.get("market_id")
    side = t.get("side")
    if not mid or not side:
        return None
    pnl = _num(t.get("pnl"))
    if pnl is None:
        pnl = _num(t.get("realized_pnl"))
    cost = _num(t.get("cost_basis"))
    if cost is None or cost <= 0:
        cost = _num(t.get("cost"))
    if cost is None or cost <= 0:
        cost = _num(t.get("amount"))
    ret = _num(t.get("return_pct"))
    if ret is None and pnl is not None and cost is not None and cost > 0:
        ret = pnl / cost
    if pnl is None and ret is not None and cost is not None and cost > 0:
        pnl = ret * cost
    if pnl is None or cost is None or cost <= 0 or ret is None:
        return None
    tid = t.get("trade_id") or t.get("id")
    row: dict[str, Any] = {
        "market_id": str(mid),
        "side": str(side).lower(),
        "pnl": pnl,
        "cost_basis": cost,
        "return_pct": ret,
        "won": pnl > 0,
        "source": "simmer-trade",
        "timestamp": t.get("created_at") or t.get("timestamp"),
    }
    if tid:
        row["trade_id"] = str(tid)
    return row


def export_simmer_trade_labels(
    api_key: str,
    venue: str = "sim",
    out_path: Optional[Path] = None,
) -> dict[str, Any]:
    path = out_path or MODEL_LABELS_SIMMER_PATH
    trades = get_trades(api_key, venue)
    rows: list[dict[str, Any]] = []
    for t in trades:
        if not isinstance(t, dict):
            continue
        row = trade_to_label_row(t)
        if row:
            rows.append(row)
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        for row in rows:
            f.write(json.dumps(row, ensure_ascii=False) + "\n")
    return {"ok": True, "path": str(path), "rows": len(rows), "trades_in": len(trades)}
