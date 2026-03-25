import type { Request, Response } from "express";
import express from "express";
import { spawn } from "child_process";
import fs from "fs/promises";
import path from "path";

import { addLog } from "../logs.js";
import { broadcast } from "../websocket.js";
import { getStatus, setLastCycle } from "../engineStatus.js";

const SKILL_SCRIPTS: Record<string, string> = {
  "polymarket-ai-divergence": "Skills/polymarket-ai-divergence/ai_divergence.py",
  "polymarket-weather-trader": "Skills/polymarket-weather-trader/weather_trader.py",
};

export function engineRoutes(projectRoot: string) {
  const router = express.Router();
  const dataDir = path.join(projectRoot, "data");

  const runEngine = (cmd: string): Promise<object> => {
    return new Promise((resolve, reject) => {
      const py = process.platform === "win32" ? "python" : "python3";
      const proc = spawn(py, ["-m", "engine.src.main", cmd], {
        cwd: projectRoot,
        env: process.env,
      });

      let out = "";
      let err = "";

      proc.stdout?.on("data", (d) => (out += d.toString()));
      proc.stderr?.on("data", (d) => (err += d.toString()));

      proc.on("close", (code) => {
        try {
          resolve(JSON.parse(out || "{}"));
        } catch {
          reject(new Error(err || "Engine error"));
        }
      });
    });
  };

  const loadDataEnv = async (): Promise<Record<string, string>> => {
    const envPath = path.join(dataDir, ".env.local");
    try {
      const content = await fs.readFile(envPath, "utf-8");
      const out: Record<string, string> = {};
      for (const line of content.split("\n")) {
        const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
        if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, "").trim();
      }
      return out;
    } catch {
      return {};
    }
  };

  const runSkill = async (skillSlug: string): Promise<object> => {
    const scriptRel = SKILL_SCRIPTS[skillSlug];
    if (!scriptRel) throw new Error(`Unknown skill: ${skillSlug}`);

    let strategy: { max_position_usd?: number } = {};
    try {
      const cfg = await fs.readFile(path.join(dataDir, "strategy_config.json"), "utf-8");
      strategy = JSON.parse(cfg);
    } catch {}

    const dataEnv = await loadDataEnv();
    const env = { ...process.env, ...dataEnv };
    env.TRADING_VENUE = "sim";
    env.AUTOMATON_MAX_BET = String(strategy.max_position_usd ?? 20);
    env.PYTHONIOENCODING = "utf-8";

    return new Promise((resolve, reject) => {
      const py = process.platform === "win32" ? "python" : "python3";
      const scriptPath = path.join(projectRoot, scriptRel);
      const proc = spawn(py, [scriptPath, "--live", "--quiet"], {
        cwd: projectRoot,
        env,
      });

      let out = "";
      let err = "";

      proc.stdout?.on("data", (d) => (out += d.toString()));
      proc.stderr?.on("data", (d) => (err += d.toString()));

      proc.on("close", (code) => {
        try {
          const parsed = JSON.parse(out || "{}");
          resolve({
            action: parsed.automaton?.trades_executed ? "traded" : "none",
            reason: parsed.automaton?.skip_reason || (code === 0 ? "ok" : err || "skill exited"),
            alive: true,
            state: {},
          });
        } catch {
          resolve({
            action: "none",
            reason: err || "Skill output not parseable",
            alive: true,
            state: {},
          });
        }
      });
    });
  };

  router.post("/cycle", async (_req: Request, res: Response) => {
    addLog("info", "Running trading cycle...");
    try {
      let strategy: { skill?: string } = {};
      try {
        const cfg = await fs.readFile(path.join(dataDir, "strategy_config.json"), "utf-8");
        strategy = JSON.parse(cfg);
      } catch {}

      const skill = strategy.skill || "built-in";
      const runResult =
        skill !== "built-in" && SKILL_SCRIPTS[skill]
          ? await runSkill(skill)
          : await runEngine("cycle");

      const result = runResult as {
        action?: string;
        reason?: string;
        decision?: Record<string, unknown>;
        alive?: boolean;
        state?: { trades_count?: number };
      };
      if (skill !== "built-in") {
        addLog("info", `Ran skill: ${skill}`);
      }
      broadcast({ type: "state", payload: result });
      const action = result?.action ?? "none";
      const reason = result?.reason ?? "";
      const msg =
        action === "traded"
          ? `Cycle completed: trade executed (total trades: ${result?.state?.trades_count ?? "?"})`
          : reason && reason !== "ok"
            ? `Cycle completed: ${action} — ${reason}`
            : `Cycle completed: ${action}`;
      addLog(action === "traded" ? "success" : "info", msg);
      const decision = {
        ...(typeof result?.decision === "object" && result.decision !== null ? result.decision : {}),
        cycle_source: skill !== "built-in" ? "skill" : "builtin",
      };
      setLastCycle(action, reason, decision);
      res.json({ ...result, decision });
    } catch (e) {
      addLog("error", `Cycle failed: ${String(e)}`);
      res.status(500).json({ error: String(e) });
    }
  });

  router.post("/monitor", async (_req: Request, res: Response) => {
    try {
      const result = (await runEngine("monitor")) as { action?: string; closed?: number };
      if (result?.closed && result.closed > 0) {
        addLog("success", `Position monitor: closed ${result.closed} position(s)`);
        broadcast({ type: "state", payload: result });
      }
      res.json(result);
    } catch (e) {
      addLog("error", `Monitor failed: ${String(e)}`);
      res.status(500).json({ error: String(e) });
    }
  });

  router.get("/status", async (_req: Request, res: Response) => {
    try {
      const status = getStatus();
      let strategy: Record<string, unknown> = {};
      try {
        const cfg = await fs.readFile(path.join(dataDir, "strategy_config.json"), "utf-8");
        strategy = JSON.parse(cfg);
      } catch {}
      res.json({ ...status, strategy });
    } catch (e) {
      res.status(500).json({ error: String(e) });
    }
  });

  router.post("/report", async (_req: Request, res: Response) => {
    addLog("info", "Generating report (fee applied)...");
    try {
      const result = (await runEngine("report")) as { alive?: boolean; report?: { points?: number } };
      broadcast({ type: "report", payload: result });
      addLog("success", `Report generated. Points: ${result?.report?.points ?? "—"}`);
      res.json(result);
    } catch (e) {
      addLog("error", `Report failed: ${String(e)}`);
      res.status(500).json({ error: String(e) });
    }
  });

  return router;
}
