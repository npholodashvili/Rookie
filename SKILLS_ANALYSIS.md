# Skills Folder — Adoption Analysis

## Overview

The `Skills/` folder contains **12 Simmer/ClawHub skills** — pre-built trading strategies that use the Simmer API. Below is what they do and how Rookie can adopt them.

---

## Skills Inventory

| Skill | Purpose | Venue | Signal Source |
|-------|---------|-------|---------------|
| **polymarket-weather-trader** | Temperature markets (NOAA forecasts) | Polymarket | NOAA API |
| **polymarket-fast-loop** | BTC/ETH/SOL 5-min sprint markets | Polymarket | Binance momentum |
| **polymarket-ai-divergence** | AI vs market price divergence | Polymarket | Simmer opportunities API |
| **polymarket-copytrading** | Mirror whale wallets | Polymarket | Target wallet positions |
| **polymarket-signal-sniper** | Breaking news / sentiment | Polymarket | External signals |
| **polymarket-mert-sniper** | Near-expiry conviction | Polymarket | Market skew |
| **polymarket-elon-tweets** | Elon tweet signals | Polymarket | Twitter |
| **polymarket-wallet-xray** | Wallet analysis (no trading) | — | On-chain |
| **prediction-trade-journal** | Trade logging, calibration | — | — |
| **simmer** | Meta: Simmer docs | — | — |
| **simmer-skill-builder** | Template for new skills | — | — |
| **simmer-x402** | Payment protocol | — | — |

---

## Can We Adopt Them?

**Yes, with some adaptation.** Here’s how.

### Compatibility

| Aspect | Rookie Engine | Skills |
|--------|---------------|--------|
| API | Simmer REST (httpx) | Simmer SDK (SimmerClient) |
| Venue | `sim` ($SIM, 200 cap) | Mostly `polymarket` (real USDC) |
| Config | `strategy_config.json` | `config.json` + `simmer_sdk.skill` |
| Entry point | `run_trading_cycle()` | `python skill.py --live` |

### Main Differences

1. **Venue** — Skills default to Polymarket; Rookie uses `sim` ($SIM). For Rookie we need `TRADING_VENUE=sim`.
2. **Budget** — Skills use their own limits; Rookie caps at 200 $SIM.
3. **Game rules** — Skills don’t know about points, fees, death, graveyard.
4. **Config** — Skills use `simmer_sdk.skill.load_config`; Rookie uses `strategy_config.json`.

---

## Adoption Options

### Option A: Run Skills as Subprocesses (Easiest)

**Idea:** Call skill scripts from the backend instead of (or in addition to) the engine.

```ts
// Instead of: spawn("python", ["-m", "engine.src.main", "cycle"])
// Run: spawn("python", ["Skills/polymarket-ai-divergence/ai_divergence.py", "--live"])
```

**Pros:** Minimal changes, reuse full skill logic.  
**Cons:** No game rules (points, fees, death). Skills don’t report back in Rookie’s format. Need `TRADING_VENUE=sim` and budget handling.

**Verdict:** Works for experimentation, but game rules must be enforced outside the skill.

---

### Option B: Adopt AI-Divergence Logic (Best Fit)

**polymarket-ai-divergence** is closest to Rookie’s current flow:

- Uses `/api/sdk/markets/opportunities` (same as Rookie)
- Kelly sizing, fee filtering, safeguards
- Zero-fee filter, flip-flop detection

**Idea:** Port its logic into `trade_executor.py`:

- Use its opportunity parsing (note: it expects `opportunities`, Rookie uses `markets` — check Simmer response)
- Add Kelly sizing
- Add fee filtering (skip non-zero-fee markets)
- Add context/safeguard checks before trading

**Pros:** Improves Rookie’s strategy without changing architecture.  
**Cons:** Some refactor; need to verify API response shape.

---

### Option C: Skill Selector in UI

**Idea:** Let the user choose which skill runs each cycle.

- Settings: dropdown “Active skill: Rookie (built-in) | AI Divergence | Weather | Fast Loop”
- Backend runs the chosen skill’s script with `TRADING_VENUE=sim`
- Game rules still enforced by Rookie (points, fees, death) based on Simmer trades

**Pros:** User can switch strategies.  
**Cons:** Skills don’t return structured data for Rookie; need to infer outcomes from Simmer API. More plumbing.

---

### Option D: Use prediction-trade-journal

**prediction-trade-journal** logs trades and produces calibration reports.

**Idea:** After each Rookie trade, call `log_trade()` from the journal skill (if available) to get better analytics.

**Pros:** Better trade tracking and calibration.  
**Cons:** Optional; not required for core game.

---

## Recommended Path

### Phase 1: Adopt AI-Divergence Patterns (Option B)

1. **Response shape** — Confirm whether Simmer returns `markets` or `opportunities` for `/api/sdk/markets/opportunities` and align Rookie’s parsing.
2. **Kelly sizing** — Add optional Kelly-based position sizing in `trade_executor.py` (from ai_divergence).
3. **Fee filter** — Add a “zero-fee only” option in strategy config.
4. **Context checks** — Before trading, call `GET /api/sdk/context/{market_id}` and respect flip-flop and slippage warnings.

### Phase 2: Optional Skill Runner (Option A/C)

1. Add a “Skill” setting: `built-in | polymarket-ai-divergence | polymarket-weather-trader`
2. When a skill is selected, run its script with:
   - `TRADING_VENUE=sim`
   - `SIMMER_API_KEY` from Rookie config
   - `AUTOMATON_MAX_BET` = Rookie’s `max_position_usd`
3. After the skill runs, Rookie still applies game rules by reading trades from Simmer.

---

## Skills That Need Extra Work

| Skill | Issue |
|-------|--------|
| **polymarket-weather-trader** | Needs weather markets; uses `tags=weather`. $SIM may have few. |
| **polymarket-fast-loop** | Targets 5-min markets; needs `get_fast_markets` or Gamma. Different discovery path. |
| **polymarket-copytrading** | Needs target wallet addresses; different setup. |
| **polymarket-signal-sniper** | Depends on external signal APIs. |
| **polymarket-mert-sniper** | Near-expiry logic; different market selection. |

---

## Dependency Check

Skills use `simmer_sdk.skill`:

```python
from simmer_sdk.skill import load_config, update_config, get_config_path
```

This is part of `simmer-sdk`. Confirm with:

```bash
pip show simmer-sdk
python -c "from simmer_sdk.skill import load_config; print('OK')"
```

If it fails, the skill package may expect a different structure (e.g. installed via ClawHub).

---

## Summary

| Question | Answer |
|----------|--------|
| Can we adopt them? | Yes. |
| Easiest to adopt? | **polymarket-ai-divergence** — same opportunities API, similar flow. |
| Full skill execution? | Possible via subprocess with `TRADING_VENUE=sim` and budget limits. |
| Game rules? | Must be enforced by Rookie; skills are unaware. |
| Next step? | Implement Phase 1: adopt AI-divergence patterns (Kelly, fees, context) in `trade_executor.py`. |
