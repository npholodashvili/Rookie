import type { Request, Response } from "express";
import express from "express";

import { setLastSimmerCall } from "../engineStatus.js";

const SIMMER_BASE = "https://api.simmer.markets";

export function simmerRoutes() {
  const router = express.Router();
  const hasMaterialShares = (p: Record<string, unknown>) =>
    Number(p.shares_yes ?? 0) >= 0.01 || Number(p.shares_no ?? 0) >= 0.01;

  const proxy = async (req: Request, res: Response, path: string, method = "GET", body?: object) => {
    setLastSimmerCall();
    const apiKey = process.env.SIMMER_API_KEY;
    if (!apiKey) {
      return res.status(503).json({ error: "SIMMER_API_KEY not configured" });
    }

    const url = `${SIMMER_BASE}${path}`;
    const opts: RequestInit = {
      method,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      signal: AbortSignal.timeout(15000),
    };
    if (body) opts.body = JSON.stringify(body);

    try {
      const r = await fetch(url, opts);
      const data = await r.json().catch(() => ({}));
      res.status(r.status).json(data);
    } catch (e) {
      res.status(502).json({ error: String(e) });
    }
  };

  router.get("/agents/me", (req, res) => proxy(req, res, "/api/sdk/agents/me"));
  router.get("/positions", async (req, res) => {
    setLastSimmerCall();
    const apiKey = process.env.SIMMER_API_KEY;
    if (!apiKey) return res.status(503).json({ error: "SIMMER_API_KEY not configured" });
    const includeClosed = String(req.query.include_closed || "").trim() === "1";
    try {
      const r = await fetch(`${SIMMER_BASE}/api/sdk/positions`, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        signal: AbortSignal.timeout(15000),
      });
      const data = (await r.json().catch(() => ({}))) as { positions?: Array<Record<string, unknown>> };
      const list = Array.isArray(data?.positions) ? data.positions : Array.isArray(data) ? (data as Array<Record<string, unknown>>) : [];
      const filtered = includeClosed
        ? list
        : list.filter((p) => {
            const st = String(p.status || "").toLowerCase();
            return (st === "active" || st === "open" || st === "") && hasMaterialShares(p);
          });
      filtered.sort((a, b) => {
        const ta = Date.parse(String(a.updated_at || a.created_at || a.resolves_at || "")) || 0;
        const tb = Date.parse(String(b.updated_at || b.created_at || b.resolves_at || "")) || 0;
        return tb - ta;
      });
      res.status(r.status).json({ positions: filtered });
    } catch (e) {
      res.status(502).json({ error: String(e) });
    }
  });
  router.get("/trades", (req, res) => {
    const venue = req.query.venue || "sim";
    const limit = Number(req.query.limit || 300);
    const recentDays = Number(req.query.recent_days || 3);
    proxy(req, res, `/api/sdk/trades?venue=${venue}&limit=${Number.isFinite(limit) ? limit : 300}&recent_days=${Number.isFinite(recentDays) ? recentDays : 3}`);
  });
  router.get("/briefing", (req, res) => proxy(req, res, "/api/sdk/briefing"));
  router.get("/portfolio", (req, res) => proxy(req, res, "/api/sdk/portfolio"));
  router.get("/opportunities", (req, res) => {
    const limit = req.query.limit || 10;
    const min_div = req.query.min_divergence || 0.03;
    proxy(req, res, `/api/sdk/markets/opportunities?limit=${limit}&min_divergence=${min_div}`);
  });

  router.post("/close-position", (req, res) => {
    const { market_id, side, shares, venue } = req.body || {};
    if (!market_id || !side || !shares) {
      return res.status(400).json({ error: "market_id, side, shares required" });
    }
    proxy(req, res, "/api/sdk/trade", "POST", {
      market_id,
      side,
      shares: Number(shares),
      action: "sell",
      venue: venue || "sim",
    });
  });

  return router;
}
