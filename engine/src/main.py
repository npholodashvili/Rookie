"""
Rookie Trading Engine - CLI entry point.
Invoked by backend for: run_trading_cycle, process_fee_and_report, get_state, etc.
Run from Rookie/: python -m engine.src.main <command>
"""
import json
import os
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
from engine.src.config import DATA_DIR, ENGINE_HEALTH_PATH
from engine.src.game_master import load_game_state
from engine.src.offline_evaluator import evaluate_offline
from engine.src.simmer_training_export import export_simmer_trade_labels
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
                    "error": "Usage: python -m engine.src.main <cycle|monitor|report|state|evaluate|calibrate|export-simmer-labels>",
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
            cfg = load_strategy_config()
            ev = cfg.get("evaluator_label_sources")
            ls = ev if isinstance(ev, list) else None

            def _jsonl_path(key: str):
                raw = cfg.get(key)
                if raw is None or raw == "":
                    return None
                name = Path(str(raw).strip()).name
                if not name or name in (".", ".."):
                    return None
                return DATA_DIR / name

            result = evaluate_offline(
                return_clip=float(cfg.get("evaluator_return_clip", 3.0)),
                label_sources=ls,
                monitor_close_weight=float(cfg.get("evaluator_monitor_close_weight", 1.0)),
                time_split_validate=bool(cfg.get("evaluator_time_split_validate", True)),
                time_split_train_fraction=float(cfg.get("evaluator_time_split_train_fraction", 0.75)),
                min_holdout_rows=int(cfg.get("evaluator_min_holdout_rows", 12)),
                holdout_min_delta=float(cfg.get("evaluator_holdout_min_delta", 0.02)),
                segment_by_market_type=bool(cfg.get("evaluator_segment_by_market_type", False)),
                evaluator_segment_min_samples=int(cfg.get("evaluator_segment_min_samples", 18)),
                segment_merge_score_slack=float(cfg.get("evaluator_segment_merge_score_slack", 0.04)),
                learning_effective_after=(str(cfg.get("learning_effective_after") or "").strip() or None),
                features_path=_jsonl_path("evaluator_features_jsonl"),
                labels_path=_jsonl_path("evaluator_labels_jsonl"),
            )
            print(json.dumps(result))
        elif cmd == "export-simmer-labels":
            api_key = os.environ.get("SIMMER_API_KEY")
            if not api_key:
                print(json.dumps({"error": "SIMMER_API_KEY not set"}))
                sys.exit(1)
            cfg = load_strategy_config()
            venue = str(cfg.get("venue", "sim"))
            result = export_simmer_trade_labels(api_key, venue=venue)
            print(json.dumps(result))
        elif cmd == "calibrate":
            cfg = load_strategy_config()
            ev = cfg.get("evaluator_label_sources")
            ls = ev if isinstance(ev, list) else None
            result = build_calibration_report(
                label_sources=ls,
                return_clip=float(cfg.get("evaluator_return_clip", 3.0)),
                learning_effective_after=(str(cfg.get("learning_effective_after") or "").strip() or None),
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
