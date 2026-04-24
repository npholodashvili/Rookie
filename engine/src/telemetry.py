"""Unified telemetry envelope for cycle/monitor/skill responses."""
from typing import Any, Optional

TELEMETRY_SCHEMA_VERSION = 1
# Automation optimizes economic outcome on Simmer (ledger + risk state in data/).
PRIMARY_AUTOMATION_KPI = "economic_pnl_simmer"


def build_telemetry_envelope(
    *,
    component: str,
    failure_code: Optional[str] = None,
    extra: Optional[dict[str, Any]] = None,
) -> dict[str, Any]:
    env: dict[str, Any] = {
        "schema_version": TELEMETRY_SCHEMA_VERSION,
        "primary_kpi": PRIMARY_AUTOMATION_KPI,
        "component": component,
    }
    if failure_code:
        env["failure_code"] = failure_code
    if extra:
        env.update(extra)
    return env


def merge_decision_with_telemetry(
    decision: Optional[dict[str, Any]],
    telemetry: dict[str, Any],
) -> dict[str, Any]:
    base = dict(decision) if isinstance(decision, dict) else {}
    base["telemetry"] = telemetry
    return base
