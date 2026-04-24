# Rookie

**Rookie** is a trading stack for **[Simmer](https://simmer.markets)** (SIM venue): a Python engine that finds opportunities, sizes risk, and logs outcomes, plus a **Node** control plane and **React** dashboard. **Simmer** is the source of truth for balances, positions, and (when exposed) fees; Rookie keeps a small **local ledger** for pauses, cooldowns, and learning labels.

## Features

- **Built-in cycle** — opportunity scan, filters (edge, liquidity, slippage, resolution window), ensemble-style ranking, Simmer context API, position caps, theme limits, optional skill scripts.
- **Risk** — per-leg monitor: stop-loss, optional fixed take-profit, optional **return trailing** (peak giveback), max-hold per leg, daily loss pause, loss-streak entry pause, exposure and per-theme caps.
- **Learning** — offline evaluator with optional time-split holdout and auto-apply of safe threshold tweaks; calibration report; optional `learning_effective_after` to drop early/noisy history.
- **Ops** — scheduled cycle (15 min), monitor, periodic Simmer snapshot report; optional Telegram advisor; WebSocket + REST API; decision journal and config audit trail. No in-repo AI or OpenClaw integration (use external tools beside Rookie if you want).

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
.\start-rookie.ps1
```

This runs **preflight checks** (Node/npm/Python, `npm install` if `node_modules` missing, `python -m engine.src.main state`, frontend `tsc --noEmit`), then frees ports **3001** and **5173**, starts backend and frontend in separate windows, and waits for `GET /health`. Use `.\start.ps1` as an alias for the same script, or `.\restart.ps1` to kill listeners first.

- **Skip checks (fast):** `.\start-rookie.ps1 -SkipPreflight`
- **Full frontend build in preflight:** `.\start-rookie.ps1 -FullTest`
- **Do not open browser:** `.\start-rookie.ps1 -NoBrowser`

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
| `CALIBRATE_DAILY_CRON` | Set to `off` to disable nightly calibration cron |
| `TELEGRAM_DISABLE_POLL` | `1` = no `getUpdates` poll (second backend instance) |

UI **Settings** can persist API key and integrations into `data/.env.local` and `data/app_config.json`.

## Engine CLI

Run from **repo root**:

```bash
python -m engine.src.main cycle    # one trading cycle
python -m engine.src.main monitor  # position monitor pass
python -m engine.src.main report   # Simmer snapshot report payload
python -m engine.src.main state    # runtime ledger JSON
python -m engine.src.main evaluate   # offline evaluator → model_eval_latest.json
python -m engine.src.main calibrate  # calibration → model_calibration_latest.json
python -m engine.src.main export-simmer-labels  # model_labels_simmer.jsonl from Simmer trades
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
├── GAME_RULES.md       # Operational risk rules, monitor semantics, evaluator notes
└── IMPROVEMENTS_IMPLEMENTED.md
```

## Documentation

- **[GAME_RULES.md](GAME_RULES.md)** — monitor per-leg rules, reporting, risk settings, Simmer label export.
- **[docs/](docs/)** — codebase notes, skills telemetry, recommendations.

## License

See [LICENSE](LICENSE).
