import type { Request, Response } from "express";
import express from "express";

import { addLog } from "../logs.js";

const SIMMER_REGISTER_URL = "https://api.simmer.markets/api/sdk/agents/register";

export function agentRoutes() {
  const router = express.Router();

  router.post("/register", async (req: Request, res: Response) => {
    const { name, description } = req.body || {};
    if (!name || typeof name !== "string") {
      return res.status(400).json({ error: "name is required" });
    }

    try {
      const r = await fetch(SIMMER_REGISTER_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          description: typeof description === "string" ? description.trim() : "",
        }),
        signal: AbortSignal.timeout(15000),
      });

      const data = await r.json();
      if (!r.ok) {
        addLog("error", `Agent registration failed: ${data.error || r.status}`);
        return res.status(r.status).json(data);
      }

      addLog("success", `Agent registered: ${name.trim()}`);
      res.json({
        api_key: data.api_key,
        claim_url: data.claim_url,
        claim_code: data.claim_code,
      });
    } catch (e) {
      res.status(500).json({ error: String(e) });
    }
  });

  return router;
}
