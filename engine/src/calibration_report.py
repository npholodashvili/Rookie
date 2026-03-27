"""Read-only calibration: expected edge / divergence bins vs realized outcomes (no live trading impact)."""
import json
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

from .config import MODEL_CALIBRATION_PATH, MODEL_FEATURES_PATH, MODEL_LABELS_PATH
from .offline_evaluator import parse_learning_effective_after


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


def _parse_ts(raw: Any) -> Optional[datetime]:
    if not raw:
        return None
    try:
        return datetime.fromisoformat(str(raw).replace("Z", "+00:00"))
    except Exception:
        return None


def _bin_expected_edge(x: float) -> str:
    edges = [0.0, 0.02, 0.03, 0.04, 0.06, 0.10, 1.0]
    for i in range(len(edges) - 1):
        lo, hi = edges[i], edges[i + 1]
        if lo <= x < hi or (i == len(edges) - 2 and x >= lo and x <= hi):
            return f"{lo:.2f}-{hi:.2f}"
    return "other"


def _bin_edge(x: float) -> str:
    x = abs(float(x))
    if x < 0.02:
        return "0-0.02"
    if x < 0.04:
        return "0.02-0.04"
    if x < 0.06:
        return "0.04-0.06"
    if x < 0.10:
        return "0.06-0.10"
    return "0.10+"


def build_calibration_report(
    label_sources: Optional[list[str]] = None,
    return_clip: float = 3.0,
    learning_effective_after: Optional[str] = None,
) -> dict:
    """
    Join features to latest labels; aggregate win rate and avg return by bins.
    Safe / read-only — does not modify strategy or execute trades.
    """
    features = _read_jsonl(MODEL_FEATURES_PATH)
    labels = _read_jsonl(MODEL_LABELS_PATH)

    filter_sources = None
    if label_sources is not None and len(label_sources) > 0:
        filter_sources = frozenset(str(s) for s in label_sources)

    label_map: dict[str, dict] = {}
    for lb in labels:
        key = f"{lb.get('market_id')}::{lb.get('side', 'unknown')}"
        label_map[key] = lb

    cutoff = parse_learning_effective_after(learning_effective_after)
    dropped_cutoff = 0

    joined: list[dict] = []
    for ft in features:
        key = f"{ft.get('market_id')}::{ft.get('side', 'unknown')}"
        lb = label_map.get(key)
        if not lb:
            continue
        src = str(lb.get("source") or "unknown")
        if filter_sources is not None and src not in filter_sources:
            continue
        if cutoff is not None:
            fts = _parse_ts(ft.get("timestamp"))
            if fts is None:
                dropped_cutoff += 1
                continue
            fo = fts if fts.tzinfo else fts.replace(tzinfo=timezone.utc)
            if fo.astimezone(timezone.utc) < cutoff:
                dropped_cutoff += 1
                continue
        exp = float(ft.get("expected_edge", 0))
        edge = float(ft.get("edge", 0))
        ret = float(lb.get("return_pct", 0))
        ret = max(-1.0, min(float(return_clip), ret))
        joined.append(
            {
                "expected_edge": exp,
                "edge": edge,
                "market_type": str(ft.get("market_type") or "unknown"),
                "won": bool(lb.get("won", False)),
                "return_pct": ret,
                "label_source": src,
            }
        )

    def summarize(rows: list[dict], key_fn) -> list[dict]:
        buckets: dict[str, list[dict]] = defaultdict(list)
        for r in rows:
            buckets[key_fn(r)].append(r)
        out = []
        for name in sorted(buckets.keys()):
            b = buckets[name]
            n = len(b)
            wins = sum(1 for x in b if x["won"])
            out.append(
                {
                    "bucket": name,
                    "n": n,
                    "win_rate": wins / n if n else 0.0,
                    "avg_return_pct": sum(x["return_pct"] for x in b) / n if n else 0.0,
                }
            )
        return out

    by_expected = summarize(joined, lambda r: _bin_expected_edge(r["expected_edge"]))
    by_edge = summarize(joined, lambda r: _bin_edge(r["edge"]))

    by_type: dict[str, list[dict]] = defaultdict(list)
    for r in joined:
        by_type[r["market_type"]].append(r)
    market_types = {
        mt: {
            "n": len(rs),
            "win_rate": sum(1 for x in rs if x["won"]) / len(rs) if rs else 0.0,
            "avg_return_pct": sum(x["return_pct"] for x in rs) / len(rs) if rs else 0.0,
        }
        for mt, rs in by_type.items()
    }

    result = {
        "ok": True,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "return_clip": return_clip,
        "label_sources_filter": list(label_sources) if filter_sources else None,
        "learning_window": {
            "cutoff": cutoff.isoformat() if cutoff else None,
            "dropped_before_cutoff": dropped_cutoff,
        },
        "paired_samples": len(joined),
        "by_expected_edge_bin": by_expected,
        "by_abs_divergence_bin": by_edge,
        "by_market_type": market_types,
        "note": "Read-only. Use bins with n>=10 before changing min_expected_edge; wide CI on small n.",
    }
    MODEL_CALIBRATION_PATH.parent.mkdir(parents=True, exist_ok=True)
    MODEL_CALIBRATION_PATH.write_text(json.dumps(result, indent=2), encoding="utf-8")
    return result
