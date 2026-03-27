"""Append-only audit log for strategy / auto-learning changes (who, what, when)."""
import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

from .config import CONFIG_AUDIT_PATH


def append_config_audit_event(
    event_type: str,
    payload: dict[str, Any],
    source: str = "engine",
) -> None:
    """Write one JSONL record. Safe to call from auto-apply, regime, or manual API paths."""
    record = {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "type": event_type,
        "source": source,
        **payload,
    }
    CONFIG_AUDIT_PATH.parent.mkdir(parents=True, exist_ok=True)
    with open(CONFIG_AUDIT_PATH, "a", encoding="utf-8") as f:
        f.write(json.dumps(record, default=str) + "\n")
