"""Heuristic hints for monitor params from labeled outcomes (read-only unless auto_apply enabled)."""
import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .config import MODEL_FEATURES_PATH, MODEL_LABELS_PATH, MONITOR_POLICY_HINTS_PATH
from .config_audit import append_config_audit_event


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


def compute_monitor_policy_hints(config: dict) -> dict[str, Any]:
    """
    Compare avg return: monitor-close vs resolved-position.
    Suggests bounded tweaks to stop_loss_pct / max_hold_hours when data supports it.
    """
    features = _read_jsonl(MODEL_FEATURES_PATH)
    labels = _read_jsonl(MODEL_LABELS_PATH)
    label_map: dict[str, dict] = {}
    for lb in labels:
        key = f"{lb.get('market_id')}::{lb.get('side', 'unknown')}"
        prev = label_map.get(key)
        prev_ts = str((prev or {}).get("timestamp") or "")
        cur_ts = str(lb.get("timestamp") or "")
        if not prev or cur_ts >= prev_ts:
            label_map[key] = lb
        ex = lb.get("trade_exec_key")
        if ex:
            label_map[f"exec::{ex}"] = lb

    mon_ret: list[float] = []
    res_ret: list[float] = []
    for ft in features:
        ex = ft.get("trade_exec_key")
        if ex:
            lb = label_map.get(f"exec::{ex}")
        else:
            lb = None
        key = f"{ft.get('market_id')}::{ft.get('side', 'unknown')}"
        if not lb:
            lb = label_map.get(key)
        if not lb:
            continue
        src = str(lb.get("source") or "")
        ret = float(lb.get("return_pct") or 0)
        if src == "monitor-close":
            mon_ret.append(ret)
        elif src == "resolved-position":
            res_ret.append(ret)

    mon_n, res_n = len(mon_ret), len(res_ret)
    mon_avg = sum(mon_ret) / mon_n if mon_n else 0.0
    res_avg = sum(res_ret) / res_n if res_n else 0.0

    hints: dict[str, Any] = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "monitor_close_n": mon_n,
        "resolved_position_n": res_n,
        "monitor_avg_return_pct": mon_avg,
        "resolved_avg_return_pct": res_avg,
        "suggested_stop_loss_pct": None,
        "suggested_max_hold_hours": None,
        "rationale": "",
    }

    min_mon = int(config.get("monitor_hints_min_monitor_samples", 10))
    min_res = int(config.get("monitor_hints_min_resolved_samples", 8))
    gap = float(config.get("monitor_hints_underperform_gap", 0.02))

    cur_stop = float(config.get("stop_loss_pct", 0.10))
    cur_hold = float(config.get("max_hold_hours", 24) or 0)

    if mon_n >= min_mon and res_n >= min_res and mon_avg < res_avg - gap:
        hints["rationale"] = "monitor-close underperforms resolved exits; slightly tighter risk may help"
        new_stop = max(0.05, round(cur_stop * 0.92, 4))
        hints["suggested_stop_loss_pct"] = new_stop
        if cur_hold > 0:
            hints["suggested_max_hold_hours"] = max(4.0, round(cur_hold * 0.92, 2))
    elif mon_n >= min_mon and mon_avg > res_avg + gap * 2 and res_n >= min_res:
        hints["rationale"] = "monitor exits outperform; current exit policy is reasonable"
    else:
        hints["rationale"] = "insufficient contrast or samples for monitor tweak"

    MONITOR_POLICY_HINTS_PATH.parent.mkdir(parents=True, exist_ok=True)
    MONITOR_POLICY_HINTS_PATH.write_text(json.dumps(hints, indent=2), encoding="utf-8")
    return hints


def maybe_auto_apply_monitor_hints(config: dict, hints: dict[str, Any]) -> dict:
    """Optionally merge suggested stop/hold into strategy file (bounded)."""
    if not config.get("auto_apply_monitor_hints", False):
        return config
    if not hints.get("suggested_stop_loss_pct") and not hints.get("suggested_max_hold_hours"):
        return config

    from .config import STRATEGY_CONFIG_PATH

    try:
        existing = json.loads(STRATEGY_CONFIG_PATH.read_text()) if STRATEGY_CONFIG_PATH.exists() else {}
    except Exception:
        return config

    updates: dict[str, Any] = {}
    ss = hints.get("suggested_stop_loss_pct")
    sh = hints.get("suggested_max_hold_hours")
    if ss is not None:
        updates["stop_loss_pct"] = max(0.05, min(0.25, float(ss)))
    if sh is not None:
        updates["max_hold_hours"] = max(2.0, min(168.0, float(sh)))

    if not updates:
        return config

    merged = {**existing, **updates}
    STRATEGY_CONFIG_PATH.write_text(json.dumps(merged, indent=2), encoding="utf-8")
    append_config_audit_event(
        "auto_apply_monitor_hints",
        {"updates": updates, "rationale": hints.get("rationale", "")},
    )
    return {**config, **updates}
