# Skills vs built-in engine — telemetry

## What runs on each cycle

- **`strategy.skill === "built-in"`** (default): Node calls `python -m engine.src.main cycle` — full Rookie pipeline (ranking, filters, features, game state, offline evaluator hooks).
- **Named skill** (`polymarket-ai-divergence`, `polymarket-weather-trader`): Node runs the skill script instead; outcomes and logging depend on that script, not `trade_executor.py`.

## Unified visibility

- **`last_decision.cycle_source`**: `"builtin"` | `"skill"` (set in [`backend/src/routes/engine.ts`](../backend/src/routes/engine.ts)) so dashboards/logs show which path ran.
- **Risk**: Position **monitor** (`/api/engine/monitor`) always uses the Python engine for stop-loss / max-hold — skills do not replace monitor unless you change backend wiring.

## Recommendations

- For comparable learning data, prefer **built-in** while experimenting, or extend skills to write the same `model_features.jsonl` / `model_labels.jsonl` shape after trades.
- Do not disable monitor for live capital without another risk layer.
