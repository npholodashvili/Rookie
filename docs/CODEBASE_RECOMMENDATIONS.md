# Rookie — codebase review & capability roadmap

Post-implementation pass: how to move toward an agent that **logically picks trades** and **wins more often** (economic edge, not just activity).

## Ops: Telegram advisor (`/report`, `/status`)

- **Only one Node backend** should poll `getUpdates` for the same bot token. Two processes (e.g. Cursor + `start.ps1`) → duplicate messages and conflicting data.
- The backend uses an exclusive lock file **`data/.telegram_poll.lock`** (gitignored): the first process polls; others log a warning and skip polling. For a second API-only backend, set **`TELEGRAM_DISABLE_POLL=1`**.

## What works well today

- **Built-in engine** ([`engine/src/trade_executor.py`](../engine/src/trade_executor.py)): gated pipeline, ranked candidate pick, Simmer context (fees, slippage, discipline), exposure/position caps, monitor exits, feature/label logging, offline threshold search.
- **Backend** ([`backend/src/routes/engine.ts`](../backend/src/routes/engine.ts), [`scheduler.ts`](../backend/src/scheduler.ts)): reliable cadence, skill vs built-in routing.
- **Observability**: decision journal, model features/labels, advisor, learning API, UI (Dashboard, Trade History, Hourly Analysis).

## Gaps vs “really capable” agent

### 1. Two trading brains (built-in vs Skills)

- **Cycle** runs either `engine.src.main cycle` **or** a Skill script ([`engine.ts` `SKILL_SCRIPTS`](../backend/src/routes/engine.ts)); behavior diverges.
- **Recommendation:** Document which path owns features/labels. If Skills stay, add a **shared post-trade hook** (append feature/label with `source: skill`) or run **monitor-only** built-in for risk while skill proposes size/side. Long-term: **one** decision entry point that plugs strategies as modules with the same telemetry.

### 2. Signal is still “divergence sign”

- Core alpha assumption: `side = sign(divergence)` with filters. No **calibration** (does +0.04 mean ~4pp true edge?).
- **Recommendation:** Offline job or `/api` read-only report: bin `|divergence|` / `expected_edge` → realized `return_pct` (per `market_type`, venue). Use to set **data-driven floors** and to **down-weight Kelly** until calibrated.

### 3. Learning scope is narrow

- Auto-apply adjusts only `min_expected_edge_pct`, `max_slippage_pct`, `min_liquidity_24h` ([`_maybe_auto_apply_evaluator`](../engine/src/trade_executor.py)).
- **Recommendation:** Extend grid or use **segmented policies** (e.g. separate thresholds per `market_type` if sample size allows). Add **time-based train/test split** on feature timestamps to reduce overfitting.

### 4. Game scoring vs portfolio PnL

- Points, 2h fee, and “activity” pressure are **not** identical to maximizing `$SIM` PnL.
- **Recommendation:** Treat **portfolio PnL / drawdown** as primary KPI in advisor and dashboard copy; optionally scale game fee to bankroll or make it configurable for “sim only” runs.

### 5. Context API cost and latency

- Each candidate triggers `get_market_context`; with ranking you still evaluate up to 10 markets per cycle.
- **Recommendation:** Batch endpoint from Simmer if available; or cache context by `market_id` for TTL inside cycle; or pre-filter with cheaper opportunity fields before context.

### 6. Resolution horizon

- `min_hours_to_resolution` avoids markets resolving **too soon**; there is no symmetric **max** horizon to avoid tying capital in far-dated illiquid markets.
- **Recommendation:** Optional `max_hours_to_resolution` (or `max_days_to_resolution`) in strategy + Settings.

### 7. Testing

- Little automated test coverage on pure decision helpers (`_candidate_sort_key`, evaluator weighting, regime persist flag).
- **Recommendation:** `pytest` with small fixtures for JSONL samples and strategy dicts; CI optional.

### 8. Skills ↔ OpenClaw

- OpenClaw is used for **wake / messaging** ([`openclaw_client.py`](../engine/src/openclaw_client.py)), not for per-market reasoning in the hot path.
- **Recommendation:** If you want LLM assistance, define a **strict schema** (market_id, side, max_size, confidence) and call only when `expected_edge` in a band where history is weak—never replace hard risk limits.

## Suggested priority order

1. ~~**Calibration report**~~ — Implemented: `calibrate` command + `/api/learning/calibration`.
2. ~~**`max_hours_to_resolution`**~~ — Implemented in cycle filters.
3. ~~**Unify telemetry**~~ — Partial: `cycle_source` on cycle decision; see `docs/SKILLS_TELEMETRY.md`.
4. ~~**Time-split evaluator**~~ — Implemented with holdout gate before auto-apply.
5. ~~**Tests**~~ — Starter suite under `tests/test_engine_safety.py`.

**Still valuable next steps:** segmented policies by `market_type`, Simmer context batching/caching TTL across cycles, Kelly calibration from bins, optional game-fee scaling.

This file is advisory; track implementation in `IMPROVEMENTS_IMPLEMENTED.md` as items land.
