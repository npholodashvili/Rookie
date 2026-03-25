# Rookie Platform — Deep Readiness Analysis

## Executive Summary

The platform has **structural gaps** that prevent it from working end-to-end. The core loop (trade → resolve → update points) is **incomplete**: trades execute, but win/loss is never applied. Trading cycles run only on manual click, not on a schedule. Backend env loading may miss the Simmer API key. Below is a detailed breakdown.

---

## 1. Critical: Trade Resolution Never Applied

### The Problem

`process_trade_resolution()` in `game_master.py` exists and correctly applies +1 (win), -1 (loss), +2 (bonus). **It is never called.**

| File | Issue |
|------|-------|
| `engine/src/trade_executor.py` | `process_trade_resolution` is imported but never invoked |
| `engine/src/game_master.py` | Logic is correct; no caller |

### Consequence

- Wins and losses stay at 0 forever
- Points only change via fees (-1 every 2h) and reports
- The game cannot be won or lost based on trading performance

### What's Missing

We need logic that:

1. Fetches positions from Simmer with `status=resolved` or `status=all`
2. Fetches trades from Simmer (trades include PnL when resolved)
3. Compares to local `trade_history.json` to find trades we haven't yet "resolved" in game state
4. For each newly resolved trade: compute PnL, cost basis, call `process_trade_resolution()`
5. Track which trade IDs we've already processed (e.g. in game_state or a separate file) to avoid double-counting

### Simmer API Support

- `GET /api/sdk/positions?status=resolved` — returns resolved positions with PnL
- `GET /api/sdk/trades` — returns trades; resolved trades include `pnl`, `outcome`
- `GET /api/sdk/briefing` — includes venues with positions and performance

---

## 2. Critical: No Scheduled Trading Cycles

### The Problem

| Component | What runs | When |
|-----------|-----------|------|
| Scheduler | `report` only | Every 2 hours (cron: `0 */2 * * *`) |
| Trading cycle | `cycle` | **Never** (only when user clicks "Run Cycle") |

### Consequence

- No autonomous trading
- Agent does nothing unless the user manually triggers a cycle

### Fix

Add a cron job for trading cycles, e.g. every 15–30 minutes:

```ts
cron.schedule("*/15 * * * *", () => runCycle(projectRoot));  // every 15 min
```

---

## 3. High: Backend Env Loading

### The Problem

- `backend/src/server.ts:12` — `dotenv.config()` loads from cwd
- When running `cd backend && npm run dev`, cwd is `backend/`, so it loads `backend/.env`
- Project root `.env` and `data/.env.local` are **not** loaded by the backend

### Consequence

- Backend uses `process.env.SIMMER_API_KEY` for `/api/simmer/*` proxy
- If the user saves the API key via Settings UI → it goes to `data/.env.local`
- Backend never loads that file → Simmer proxy returns 503 "SIMMER_API_KEY not configured"

### Fix

Load env from project root and optionally from `data/.env.local`:

```ts
const PROJECT_ROOT = path.resolve(__dirname, "../..");
dotenv.config({ path: path.join(PROJECT_ROOT, ".env") });
dotenv.config({ path: path.join(PROJECT_ROOT, "data", ".env.local") });
```

---

## 4. High: Engine Spawn Env

### The Problem

- `backend/src/routes/engine.ts` and `scheduler.ts` spawn with `env: process.env` (or `{ ...process.env }`)
- Backend does not merge `app_config.json` or `data/.env.local` into `env` before spawning

### Current Behavior

- Engine's `main.py` loads `ROOT/.env` and `ROOT/data/.env.local` via `load_dotenv`
- So the engine **does** get `SIMMER_API_KEY` and `OPENCLAW_*` from `data/.env.local` when it runs
- Backend does not need to pass them if the engine loads dotenv itself

### Conclusion

Engine env is **OK** as long as `data/.env.local` exists and has the keys. The backend env issue is separate (for the Simmer proxy).

---

## 5. Medium: Simmer / Opportunities API

### Opportunities Response

Simmer `GET /api/sdk/markets/opportunities` may return:

- `{ markets: [...] }` — we handle this
- `{ opportunities: [...] }` or similar — need to verify actual response shape

### Trade Response

`POST /api/sdk/trade` returns `trade_id` — we check `data.get("trade_id")`. Simmer may return different fields (e.g. `id`). Verify against actual API response.

---

## 6. Medium: OpenClaw Webhooks 404

### Status

- OpenClaw returns 404 on `/hooks/wake`
- Hooks must be enabled in OpenClaw config
- User needs to add `hooks.enabled: true` and `hooks.token` on the OpenClaw host

### Impact

- 10th-trade wake does not work
- Strategy adjustment when win/loss &lt; 70/30 does not work
- Game logic can still run; OpenClaw is optional for enhancement

---

## 7. Low: Engine Health (Red)

### Cause

- `engine_health.json` is written by `main.py` when the engine runs
- If the engine has never been run (or only `state` was run), the file may be stale or missing
- Health check runs `engine.state` to trigger a run and create the file

### Fix

Run "Run Cycle" or "Report" once from the UI to create the health file.

---

## 8. Low: check_death Logic

### Current

```python
return state.get("points", 100) <= 0 and state.get("alive", True)
```

Returns True when points ≤ 0 **and** alive. Correct: we trigger death when points hit 0 and we're still marked alive.

---

## 9. Data Flow Summary

```
User clicks "Run Cycle"
    → POST /api/engine/cycle
    → spawn engine "cycle"
    → run_trading_cycle()
        → get_opportunities, execute_trade, append_trade, set_risk_monitor
        → trades_count += 1
        → wake_on_10th_trade (if 10th)
        → request_strategy_adjustment (if win/loss < 70/30)
    → process_trade_resolution() NEVER CALLED

Every 2 hours
    → scheduler runs "report"
    → process_fee_and_report()
        → apply_fee (-1 point)
        → check_death, trigger_death if needed
        → build report
    → process_trade_resolution() NEVER CALLED
```

---

## 10. Priority Fix List

| # | Priority | Fix |
|---|----------|-----|
| 1 | **Critical** | Implement trade resolution: fetch resolved positions/trades from Simmer, detect new resolutions, call `process_trade_resolution()` |
| 2 | **Critical** | Add scheduled trading cycles (e.g. every 15 min) |
| 3 | **High** | Backend: load `.env` and `data/.env.local` from project root |
| 4 | **Medium** | Verify Simmer opportunities and trade response formats |
| 5 | **Medium** | Enable OpenClaw hooks on the OpenClaw host |
| 6 | **Low** | Run engine once to create `engine_health.json` |

---

## 11. What Works Today

- Backend and frontend start
- Simmer API proxy (if backend has SIMMER_API_KEY)
- Health check (backend, Simmer, OpenClaw, engine)
- Settings UI (strategy, OpenClaw, Telegram, API key, agent registration)
- Manual "Run Cycle" and "Report"
- Report generation every 2 hours
- Fee deduction every 2 hours
- Death trigger when points hit 0 (from fees)
- Graveyard record on death
- Trade execution and risk monitor (stop-loss)
- Local trade history persistence
