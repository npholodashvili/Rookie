"""Configuration and paths for the trading engine."""
import os
from pathlib import Path

# Project root (Rookie/)
PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
DATA_DIR = PROJECT_ROOT / "data"

GAME_STATE_PATH = DATA_DIR / "game_state.json"
TRADE_HISTORY_PATH = DATA_DIR / "trade_history.json"
DECISION_JOURNAL_PATH = DATA_DIR / "decision_journal.jsonl"
MODEL_FEATURES_PATH = DATA_DIR / "model_features.jsonl"
MODEL_LABELS_PATH = DATA_DIR / "model_labels.jsonl"
MODEL_EVAL_PATH = DATA_DIR / "model_eval_latest.json"
MODEL_CALIBRATION_PATH = DATA_DIR / "model_calibration_latest.json"
STRATEGY_CONFIG_PATH = DATA_DIR / "strategy_config.json"
GRAVEYARD_PATH = DATA_DIR / "graveyard.json"

# Budget cap (real-world scenario)
MAX_BUDGET_SIM = 200.0

# Health file for backend to check engine status
ENGINE_HEALTH_PATH = DATA_DIR / "engine_health.json"

# Strategy / learning change audit (append-only JSONL)
CONFIG_AUDIT_PATH = DATA_DIR / "config_audit.jsonl"

# Read-only hints for exit parameters (Phase B)
MONITOR_POLICY_HINTS_PATH = DATA_DIR / "monitor_policy_hints.json"
