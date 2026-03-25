import type { Request, Response } from "express";
import express from "express";

import { setLastSimmerCall } from "../engineStatus.js";

const SIMMER_BASE = "https://api.simmer.markets";

export function simmerRoutes() {
  const router = express.Router();

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
  router.get("/positions", (req, res) => proxy(req, res, "/api/sdk/positions"));
  router.get("/trades", (req, res) => {
    const venue = req.query.venue || "sim";
    proxy(req, res, `/api/sdk/trades?venue=${venue}`);
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
