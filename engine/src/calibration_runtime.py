"""Runtime adjustment of entry floor using last calibration report (conservative, in-cycle only)."""
import json
from pathlib import Path
from typing import Optional

from .config import MODEL_CALIBRATION_PATH


def _parse_bucket_lo_hi(bucket: str) -> Optional[tuple[float, float]]:
    """Parse '0.02-0.06' into (0.02, 0.06)."""
    b = (bucket or "").strip()
    if "-" not in b:
        return None
    parts = b.split("-", 1)
    try:
        return float(parts[0]), float(parts[1])
    except ValueError:
        return None


def _bucket_covers_edge(bucket: str, edge: float) -> bool:
    rng = _parse_bucket_lo_hi(bucket)
    if not rng:
        return False
    lo, hi = rng
    return lo <= edge < hi or (edge >= lo and hi >= 1.0 and edge <= hi)


def runtime_min_expected_edge_boost(config: dict) -> float:
    """
    If the calibration bin that contains the current min_expected_edge shows weak win rate,
    add a small in-memory boost (does not write strategy file by itself).
    """
    if not config.get("use_calibration_runtime_adjustment", True):
        return 0.0
    path = MODEL_CALIBRATION_PATH
    if not path.exists():
        return 0.0
    try:
        cal = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return 0.0

    paired = int(cal.get("paired_samples") or 0)
    if paired < int(config.get("calibration_runtime_min_samples", 35)):
        return 0.0

    current = float(config.get("min_expected_edge_pct", 0.02))
    min_bin_n = int(config.get("calibration_runtime_min_bin_n", 12))
    low_wr = float(config.get("calibration_runtime_low_win_rate", 0.44))
    step = float(config.get("calibration_runtime_boost_step", 0.005))
    cap = float(config.get("calibration_runtime_boost_cap", 0.02))

    bins = cal.get("by_expected_edge_bin") or []
    boost = 0.0
    for b in bins:
        if not isinstance(b, dict):
            continue
        bucket = str(b.get("bucket") or "")
        if not _bucket_covers_edge(bucket, current):
            continue
        n = int(b.get("n") or 0)
        if n < min_bin_n:
            return 0.0
        wr = float(b.get("win_rate") or 0.0)
        if wr < low_wr:
            boost = min(cap, step)
        break

    return boost
