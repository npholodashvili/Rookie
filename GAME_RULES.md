# Rookie operational rules (Simmer-first)

Rookie is **not** a points game. Risk and reporting are tied to **Simmer economics** (balances, positions, fees) and a small **local ledger** in `data/game_state.json` (wins/losses from resolved positions and monitor closes, pauses, cooldowns).

## Position monitor (per leg)

- **YES** and **NO** are evaluated **independently** when both have size.
- **Stop-loss** applies per leg as a fraction of that leg’s inferred **cost** (local trade history allocation when Simmer returns one combined position).
- **Take-profit (fixed)** applies per leg when **return trailing** is off.
- **Return trailing** (optional): track **peak** leg return (`pnl/cost`); after return ≥ `min_profit_return_to_trail`, close if peak − current return ≥ `trailing_return_giveback_pp` (fractions in `strategy_config.json`, same as stop-loss style). When trailing is on, Rookie **does not** set Simmer venue take-profit (avoids double exits); stop-loss may still be set on the venue.
- **Max hold** is evaluated **per leg** using entry time from local buys for that side (fallback to Simmer position timestamps).
- **Market re-entry cooldown** applies when the **last** open leg on that market is closed (not when only one side of a hedge is closed).

## Reporting

- The scheduled **report** is a **Simmer snapshot** (briefing, positions, recent trades, fee aggregates when fee fields exist). There is **no** periodic points fee.

## Risk limits (Settings / `data/strategy_config.json`)

- **Daily loss pause** and **loss-streak entry pause** still apply to **new buys**; the monitor can close positions regardless.
- **Auto regime** prefers **Simmer `agents/me` win/loss counts** when the API key is set; otherwise it falls back to the local ledger.

## Training / evaluator

- Default labels: `model_labels.jsonl` (from Rookie monitor/resolution). **Simmer-exported labels:** run `python -m engine.src.main export-simmer-labels` → `data/model_labels_simmer.jsonl`, then set strategy `evaluator_labels_jsonl` to that basename (optional `evaluator_features_jsonl` for alternate feature files). Evaluator joins on `market_id`+`side`, or `trade_id` when both feature and label rows include it.

## External AI

- Rookie does **not** embed LLM clients or OpenClaw. Strategy review may be done manually with external tools.
