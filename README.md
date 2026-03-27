# Rookie

**Rookie** is a trading stack for **[Simmer](https://simmer.markets)** (SIM venue): a Python engine that finds opportunities, sizes risk, and logs outcomes, plus a **Node** control plane and **React** dashboard. A lightweight **game layer** (points, fees, reports) runs alongside **economic PnL** on Simmer.

## Features

- **Built-in cycle** — opportunity scan, filters (edge, liquidity, slippage, resolution window), ensemble-style ranking, Simmer context API, position caps, theme limits, optional skill scripts.
- **Risk** — stop-loss / take-profit / max-hold monitor (1 min), daily loss pause, loss-streak entry pause, exposure and per-theme caps.
- **Learning** — offline evaluator with optional time-split holdout and auto-apply of safe threshold tweaks; calibration report; optional `learning_effective_after` to drop early/noisy history.
- **Ops** — scheduled cycle (15 min), monitor, 2h fee/report; optional Telegram advisor; optional OpenClaw hooks; WebSocket + REST API; decision journal and config audit trail.

## Stack

| Layer | Tech |
|--------|------|
| Engine | Python 3 (`engine/`) — Simmer SDK / HTTP, JSON state under `data/` |
| API & scheduler | Node + Express + `node-cron` (`backend/`) — port **3001** |
| UI | React + Vite (`frontend/`) — dev port **5173** |

## Prerequisites

- **Node.js** 18+ and **npm**
- **Python** 3.10+ with `pip`
- Simmer **API key** ([Simmer docs](https://simmer.markets))

## Quick start

### Windows (recommended)

From the repo root:

```powershell
.\start.ps1
```

This frees ports **3001** and **5173**, then starts backend and frontend in separate windows. Use `.\restart.ps1` to recycle processes.

### Manual

```bash
# Python deps (from repo root)
pip install -r engine/requirements.txt

# Backend
cd backend && npm install && npm run dev

# Frontend (new terminal)
cd frontend && npm install && npm run dev
```

- **Dashboard:** http://localhost:5173  
- **API:** http://localhost:3001 (e.g. `GET /health`, `GET /api/learning`)

Put secrets in **`.env`** at the repo root and/or **`data/.env.local`** (see below). The backend also loads `data/.env.local` for the engine.

## Environment

| Variable | Purpose |
|----------|---------|
| `SIMMER_API_KEY` | Simmer API (required for live trading) |
| `PORT` | Backend port (default `3001`) |
| `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` | Optional Telegram advisor |
| `OPENCLAW_URL` / `OPENCLAW_HOOKS_TOKEN` | Optional OpenClaw webhooks |
| `CALIBRATE_DAILY_CRON` | Set to `off` to disable nightly calibration cron |
| `TELEGRAM_DISABLE_POLL` | `1` = no `getUpdates` poll (second backend instance) |

UI **Settings** can persist API key and integrations into `data/.env.local` and `data/app_config.json`.

## Engine CLI

Run from **repo root**:

```bash
python -m engine.src.main cycle    # one trading cycle
python -m engine.src.main monitor  # position monitor pass
python -m engine.src.main report   # 2h fee + report payload
python -m engine.src.main state    # game state JSON
python -m engine.src.main evaluate   # offline evaluator → model_eval_latest.json
python -m engine.src.main calibrate  # calibration → model_calibration_latest.json
```

The backend normally invokes these via **`POST /api/engine/*`** and the scheduler.

## Project layout

```
├── backend/          # Express API, scheduler, WebSocket, Telegram advisor
├── frontend/         # Vite + React dashboard
├── engine/             # Trading engine (trade_executor, game_master, clients)
├── data/               # Runtime JSON/JSONL (gitignored where noted in .gitignore)
├── docs/               # Extra design / telemetry notes
├── skills/             # Optional Python skill scripts (wired from backend)
├── start.ps1 / restart.ps1
├── GAME_RULES.md       # Points, fees, death rules, strategy knobs
└── IMPROVEMENTS_IMPLEMENTED.md
```

## Documentation

- **[GAME_RULES.md](GAME_RULES.md)** — scoring, reporting cadence, death, engine risk settings.
- **[docs/](docs/)** — codebase notes, skills telemetry, recommendations.

## License

See [LICENSE](LICENSE).
