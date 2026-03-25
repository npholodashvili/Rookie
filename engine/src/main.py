"""
Rookie Trading Engine - CLI entry point.
Invoked by backend for: run_trading_cycle, process_fee_and_report, get_state, etc.
Run from Rookie/: python -m engine.src.main <command>
"""
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

# Ensure project root is on path
ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(ROOT))

from dotenv import load_dotenv

load_dotenv(ROOT / ".env")
load_dotenv(ROOT / "data" / ".env.local", override=True)

from engine.src.calibration_report import build_calibration_report
from engine.src.config import ENGINE_HEALTH_PATH
from engine.src.game_master import load_game_state
from engine.src.offline_evaluator import evaluate_offline
from engine.src.trade_executor import (
    load_strategy_config,
    process_fee_and_report,
    run_position_monitor,
    run_trading_cycle,
)


def write_health(status: str = "ok") -> None:
    """Write engine health file for backend to poll."""
    ENGINE_HEALTH_PATH.parent.mkdir(parents=True, exist_ok=True)
    with open(ENGINE_HEALTH_PATH, "w") as f:
        json.dump({"status": status, "timestamp": datetime.now(timezone.utc).isoformat()}, f)


def main() -> None:
    if len(sys.argv) < 2:
        print(
            json.dumps(
                {
                    "error": "Usage: python -m engine.src.main <cycle|monitor|report|state|evaluate|calibrate>",
                }
            )
        )
        sys.exit(1)

    cmd = sys.argv[1].lower()
    write_health("ok")

    try:
        if cmd == "cycle":
            result = run_trading_cycle()
            print(json.dumps(result))
        elif cmd == "monitor":
            result = run_position_monitor()
            print(json.dumps(result))
        elif cmd == "report":
            result = process_fee_and_report()
            print(json.dumps(result))
        elif cmd == "state":
            state = load_game_state()
            print(json.dumps(state))
        elif cmd == "evaluate":
            result = evaluate_offline()
            print(json.dumps(result))
        elif cmd == "calibrate":
            cfg = load_strategy_config()
            ev = cfg.get("evaluator_label_sources")
            ls = ev if isinstance(ev, list) else None
            result = build_calibration_report(
                label_sources=ls,
                return_clip=float(cfg.get("evaluator_return_clip", 3.0)),
            )
            print(json.dumps(result))
        else:
            print(json.dumps({"error": f"Unknown command: {cmd}"}))
            sys.exit(1)
    except Exception as e:
        write_health("error")
        print(json.dumps({"error": str(e)}))
        sys.exit(1)


if __name__ == "__main__":
    main()
