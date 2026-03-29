import type { Request, Response } from "express";
import express from "express";
import fs from "fs/promises";
import path from "path";

const SIMMER_BASE = "https://api.simmer.markets";

/** Mirrors the share-check logic from frontend/src/lib/positions.ts */
function isLivePosition(p: Record<string, unknown>): boolean {
  const st = String(p.status ?? "").toLowerCase();
  if (["resolved", "gone", "sold", "closed", "empty"].includes(st)) return false;
  const sy = Number(p.shares_yes ?? 0);
  const sn = Number(p.shares_no ?? 0);
  if (sy < 0.01 && sn < 0.01) return false;
  return st === "active" || st === "open" || !st;
}

export function auditRoutes(dataDir: string) {
  const router = express.Router();

  router.get("/alignment", async (_req: Request, res: Response) => {
    const apiKey = process.env.SIMMER_API_KEY;
    if (!apiKey) return res.status(503).json({ error: "SIMMER_API_KEY not configured" });

    try {
      const headers = { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" };
      const [simPosRaw, simMeRaw] = await Promise.all([
        fetch(`${SIMMER_BASE}/api/sdk/positions`, { headers, signal: AbortSignal.timeout(15000) })
          .then((r) => r.json())
          .catch(() => null),
        fetch(`${SIMMER_BASE}/api/sdk/agents/me`, { headers, signal: AbortSignal.timeout(15000) })
          .then((r) => r.json())
          .catch(() => null),
      ]);

      const [localHistory, localState] = await Promise.all([
        fs.readFile(path.join(dataDir, "trade_history.json"), "utf-8").then(JSON.parse).catch(() => []),
        fs.readFile(path.join(dataDir, "game_state.json"), "utf-8").then(JSON.parse).catch(() => ({})),
      ]);

      const simPositions: Record<string, unknown>[] = (simPosRaw?.positions ?? simPosRaw ?? []) as Record<string, unknown>[];
      const simActive = simPositions.filter(isLivePosition);
      const simMe = (simMeRaw ?? {}) as Record<string, unknown>;

      const localTrades: Record<string, unknown>[] = Array.isArray(localHistory) ? localHistory : [];
      const localBuys = localTrades.filter((t) => !t.action || t.action === "buy");
      const localSells = localTrades.filter((t) => t.action === "sell");

      // Build sets for divergence checks
      const simActiveMarkets = new Set(simActive.map((p) => String(p.market_id ?? "")));
      const localBuyMarkets = new Set(localBuys.map((t) => String(t.market_id ?? "")));
      const localSoldMarkets = new Set(localSells.map((t) => String(t.market_id ?? "")));

      // Positions Simmer shows as active but Rookie has no local buy for
      const inSimmerOnly = simActive
        .filter((p) => !localBuyMarkets.has(String(p.market_id ?? "")))
        .map((p) => ({
          market_id: p.market_id,
          question: String(p.question ?? "").slice(0, 64),
          pnl: Number(p.pnl ?? 0),
          status: p.status,
        }));

      // Local buys that Simmer doesn't show as an active position AND not in local sells (orphaned)
      const inLocalOnly = localBuys
        .filter((t) => !simActiveMarkets.has(String(t.market_id ?? "")) && !localSoldMarkets.has(String(t.market_id ?? "")))
        .slice(-15)
        .map((t) => ({ market_id: t.market_id, trade_id: t.trade_id, created_at: t.created_at }));

      const simWins = Number(simMe.win_count ?? 0);
      const simLosses = Number(simMe.loss_count ?? 0);
      const localWins = Number(localState.wins ?? 0);
      const localLosses = Number(localState.losses ?? 0);
      const simPnl = Number(simMe.sim_pnl ?? simMe.total_pnl ?? 0);
      const simBalance = Number(simMe.balance ?? simMe.sim_balance ?? 0);

      const divergences: string[] = [];
      if (inSimmerOnly.length > 0)
        divergences.push(`${inSimmerOnly.length} Simmer position(s) not in local history`);
      if (inLocalOnly.length > 0)
        divergences.push(`${inLocalOnly.length} local buy(s) not resolved/closed in Simmer`);
      if (Math.abs(simWins - localWins) > 3)
        divergences.push(`Win count gap: Simmer ${simWins} vs Local ${localWins}`);
      if (Math.abs(simLosses - localLosses) > 3)
        divergences.push(`Loss count gap: Simmer ${simLosses} vs Local ${localLosses}`);

      res.json({
        generated_at: new Date().toISOString(),
        aligned: divergences.length === 0,
        divergences,
        simmer: {
          active_positions: simActive.length,
          wins: simWins,
          losses: simLosses,
          balance: simBalance,
          pnl: simPnl,
        },
        local: {
          total_trades: localTrades.length,
          buys: localBuys.length,
          sells: localSells.length,
          wins: localWins,
          losses: localLosses,
          points: Number(localState.points ?? 0),
        },
        in_simmer_not_local: inSimmerOnly,
        in_local_not_simmer: inLocalOnly,
      });
    } catch (e) {
      res.status(500).json({ error: String(e) });
    }
  });

  return router;
}
