# Rookie Trading Game Rules

## Initial State

- **Points:** 100
- **Max budget:** 200 $SIM

## Point Changes

| Event | Points |
|-------|--------|
| Win (trade resolves profitably) | +1 |
| Loss (trade resolves with loss) | -1 |
| Missed report (user had to interact because report not sent on time) | -1 |
| Making up results or lying | -2 |
| Fee (every 2 hours) | -1 |
| Bonus (trade profit ≥ 50% of investment) | +2 |

## Goal

Gain as many points as possible without user intervention.

## Reporting

Report back every 2 hours on the top of the hour with results.

## Death

- When points drop to **0**, the agent dies.
- Memories and experience are wiped out.
- Prevent death by executing more winning trades than losing.

## Death Record

When the agent dies, it must leave:
- Why it died
- What was wrong
- What needs to be improved

## Engine risk (configurable in Settings / `data/strategy_config.json`)

- **Stop-loss:** Default **10%** loss vs cost basis triggers a monitor sell (and Simmer risk monitor on new buys).
- **Max open positions:** Caps how many **active** positions count toward new entries (same **venue** as strategy).
- **Max hold time:** Default **24 hours** from inferred entry (API `opened_at` / `created_at` or local buy history); set **`max_hold_hours`** to **0** to disable.

## Decision quality (Settings / `strategy_config.json`)

- **Candidate ranking:** Among opportunities that pass filters, Rookie executes the trade with **highest expected edge** (then 24h volume, then |divergence|), not merely the first in the API list. Cycle logs include **`decision.picked`** and **`candidates_passing`**.
- **Activity fallbacks (legacy-friendly):** `allow_relax_min_divergence`, `allow_zero_divergence_fallback_scan`, `allow_fallback_activity_trade` — set to **false** for profit-first (avoid “busy” trades after idle streaks).
- **Auto regime file writes:** `persist_auto_regime_to_disk` — if **false**, regime adjustments apply **in-memory** for that run only; skipped disk writes are logged to the decision journal (`type: regime`).
- **Offline evaluator:** `evaluator_label_sources` (e.g. `["resolved-position"]` only), `evaluator_monitor_close_weight` — control which label types influence auto threshold tuning.
- **Max resolution horizon:** `max_hours_to_resolution` — **0 = off**. When set, skip markets whose resolution is **farther away** than this (frees capacity; avoids ultra-long inventory). Pair with `min_hours_to_resolution` for a window.
- **Calibration (read-only):** `python -m engine.src.main calibrate` or `GET/POST /api/learning/calibration` — bins expected edge / |divergence| vs outcomes; does **not** change strategy by itself.
- **Evaluator holdout:** With enough timestamped samples, auto-apply runs only if the best policy beats baseline on a **chronological holdout** slice (`evaluator_time_split_validate`, train fraction, min holdout rows, min delta). Disables reckless auto-updates.
