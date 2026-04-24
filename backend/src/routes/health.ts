import type { Request, Response } from "express";
import express from "express";
import fs from "fs/promises";
import path from "path";
import { spawn } from "child_process";

const SIMMER_HEALTH_URL = "https://api.simmer.markets/api/sdk/health";

export function healthRoutes(projectRoot: string) {
  const router = express.Router();

  router.get("/", async (_req: Request, res: Response) => {
    const backendStart = Date.now();
    const results: Record<string, { status: string; latency_ms?: number; last_check: string }> = {};

    // Backend
    results.backend = {
      status: "green",
      latency_ms: Date.now() - backendStart,
      last_check: new Date().toISOString(),
    };

    // Simmer API
    try {
      const start = Date.now();
      const r = await fetch(SIMMER_HEALTH_URL, { signal: AbortSignal.timeout(5000) });
      const latency = Date.now() - start;
      results.simmer = {
        status: r.ok ? (latency < 2000 ? "green" : "yellow") : "red",
        latency_ms: latency,
        last_check: new Date().toISOString(),
      };
    } catch {
      results.simmer = { status: "red", last_check: new Date().toISOString() };
    }

    // Python engine
    const engineHealthPath = path.join(projectRoot, "data", "engine_health.json");
    try {
      const data = await fs.readFile(engineHealthPath, "utf-8");
      const parsed = JSON.parse(data);
      const ts = parsed.timestamp ? new Date(parsed.timestamp).getTime() : 0;
      const age = Date.now() - ts;
      results.engine = {
        status: parsed.status === "ok" && age < 120000 ? "green" : age < 300000 ? "yellow" : "red",
        last_check: new Date().toISOString(),
      };
    } catch {
      // Try to run engine to create health file
      const py = process.platform === "win32" ? "python" : "python3";
      const proc = spawn(py, ["-m", "engine.src.main", "state"], {
        cwd: projectRoot,
        env: process.env,
      });
      const done = new Promise<void>((resolve) => proc.on("close", () => resolve()));
      await Promise.race([done, new Promise((r) => setTimeout(r, 5000))]);
      try {
        const data = await fs.readFile(engineHealthPath, "utf-8");
        const parsed = JSON.parse(data);
        results.engine = {
          status: parsed.status === "ok" ? "green" : "red",
          last_check: new Date().toISOString(),
        };
      } catch {
        results.engine = { status: "red", last_check: new Date().toISOString() };
      }
    }

    res.json(results);
  });

  return router;
}
