# Rookie Improvements — Implemented

## Workflow Analysis Summary

### Current Flow
1. **Monitor** (every 1 min): Check positions → close if stop-loss (-20%) or take-profit (+50%) → process resolution
2. **Cycle** (every 15 min): Resolution check → opportunities → filters → trade → strategy optimization
3. **Report** (every 2h): Resolution check → fee -1 → death check → report

### Critical Fixes

| Fix | Description |
|-----|-------------|
| **Trade resolution** | `process_trade_resolution()` now called when monitor closes a position (stop-loss/take-profit) |
| **Market-resolved check** | `run_resolution_check()` fetches resolved positions, processes new ones, tracks `processed_resolved_ids` |
| **Resolution in cycle/report** | Resolution check runs in cycle (every 15 min) and report (every 2h) |

### Profitability & Automation

| Feature | Description |
|---------|-------------|
| **Cooldown** | `cooldown_minutes` enforced between trades |
| **Min 1 trade per 2h** | After 8 cycles (2h) without trade, `min_divergence` relaxed by 0.01, more opportunities fetched |
| **Auto strategy optimization** | Win rate < 55%: tighten (min_edge +0.01, max_position ×0.8); Win rate > 75%: loosen |
| **Circuit breaker** | After 3 consecutive losses, max_position reduced by 30% |
| **Consecutive loss tracking** | `consecutive_losses` in game_state, reset on win |

### Game State Additions

- `processed_resolved_ids`: Market IDs already processed (avoid double-counting)
- `last_trade_at`: For cooldown enforcement
- `cycles_without_trade`: For 2h relaxation
- `consecutive_losses`: For circuit breaker

### Edge Cases Handled

- Resolved positions without cost_basis: skipped
- Position format: filter by `status != "resolved"` for active count
- Strategy config write failures: silent, use in-memory config
- Cooldown parse errors: skip cooldown check

## Best Practices Applied

1. **Kelly sizing** — Optional, configurable
2. **Stop-loss / take-profit** — 1-min monitor + Simmer server-side
3. **Resolution tracking** — Deduplication via processed IDs
4. **Adaptive strategy** — Win rate and drawdown based
5. **Minimum activity** — Relax filters when no trades for 2h

## User Goal: Monitor Only

The platform now:
- Trades every 15 min when opportunities exist
- Relaxes filters after 2h without trades
- Auto-adjusts strategy based on performance
- Processes wins/losses correctly (points, death)
- Requires no user action beyond initial setup

## Profit-focused decision upgrades

| Feature | Description |
|--------|-------------|
| **Ranked execution** | Among passing candidates, trade the one with best **expected_edge** (tie-break: volume, \|div\|). `decision.picked` + `candidates_passing` on cycle result. |
| **Configurable fallbacks** | `allow_relax_min_divergence`, `allow_zero_divergence_fallback_scan`, `allow_fallback_activity_trade` (default true = legacy). |
| **Regime persist toggle** | `persist_auto_regime_to_disk` — false skips writing auto regime to `strategy_config.json`; logs `type: regime` events. |
| **Evaluator label control** | `evaluate_offline(..., label_sources=..., monitor_close_weight=...)`; optional `evaluator_label_sources` + `evaluator_monitor_close_weight` in strategy JSON / Settings. |

## Safety & calibration (recommendations follow-up)

| Feature | Description |
|--------|-------------|
| **max_hours_to_resolution** | Optional cap on time-to-resolution; **0** = off (default). Skip `resolves-too-late` in cycle. |
| **Per-cycle context cache** | Deduplicates `get_market_context` by `market_id` within one cycle. |
| **Calibration report** | [`engine/src/calibration_report.py`](../engine/src/calibration_report.py) → `data/model_calibration_latest.json`; CLI `calibrate`; API `GET/POST /api/learning/calibration`. |
| **Evaluator time-split holdout** | Train policy on older slice; require holdout score gain ≥ `evaluator_holdout_min_delta` or **block** `recommended_updates` (`holdout_blocks_apply`). |
| **Skill vs built-in tag** | `decision.cycle_source` in engine cycle response; see [`docs/SKILLS_TELEMETRY.md`](../docs/SKILLS_TELEMETRY.md). |
| **Tests** | `python -m unittest discover -s tests -v` from repo root. |
