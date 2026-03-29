import type { Request, Response } from "express";
import express from "express";
import { spawn } from "child_process";
import fs from "fs/promises";
import path from "path";

import { addLog } from "../logs.js";
import { broadcast } from "../websocket.js";
import { getStatus, setLastCycle, getPaused, setPaused } from "../engineStatus.js";

const SKILL_SCRIPTS: Record<string, string> = {
  "polymarket-ai-divergence": "skills/polymarket-ai-divergence/ai_divergence.py",
  "polymarket-weather-trader": "skills/polymarket-weather-trader/weather_trader.py",
};

export function engineRoutes(projectRoot: string) {
  const router = express.Router();
  const dataDir = path.join(projectRoot, "data");

  const TELEMETRY_SCHEMA_VERSION = 1;

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
        let parsed: Record<string, unknown> = {};
        try {
          parsed = JSON.parse((out || "").trim() || "{}") as Record<string, unknown>;
        } catch {
          reject(new Error(err.trim() || `Engine non-JSON stdout (exit ${code ?? "?"})`));
          return;
        }
        if (code !== 0) {
          const msg =
            typeof parsed.error === "string" && parsed.error
              ? parsed.error
              : err.trim() || `engine exited with code ${code}`;
          reject(new Error(msg));
          return;
        }
        resolve(parsed);
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
          const parsed = JSON.parse((out || "").trim() || "{}") as {
            automaton?: { trades_executed?: number; skip_reason?: string };
            decision?: Record<string, unknown>;
          };
          const telemetry = {
            schema_version: TELEMETRY_SCHEMA_VERSION,
            primary_kpi: "economic_pnl_simmer",
            component: "skill_cycle",
            cycle_source: "skill",
            skill: skillSlug,
            exit_code: code,
          };
          const baseDecision =
            typeof parsed.decision === "object" && parsed.decision !== null ? { ...parsed.decision } : {};
          resolve({
            action: parsed.automaton?.trades_executed ? "traded" : "none",
            reason: parsed.automaton?.skip_reason || (code === 0 ? "ok" : err || "skill exited"),
            alive: true,
            state: {},
            decision: { ...baseDecision, telemetry },
            telemetry,
          });
        } catch {
          resolve({
            action: "none",
            reason: err || "Skill output not parseable",
            alive: true,
            state: {},
            decision: {
              telemetry: {
                schema_version: TELEMETRY_SCHEMA_VERSION,
                primary_kpi: "economic_pnl_simmer",
                component: "skill_cycle",
                cycle_source: "skill",
                skill: skillSlug,
                failure_code: "parse_error",
              },
            },
            telemetry: {
              schema_version: TELEMETRY_SCHEMA_VERSION,
              primary_kpi: "economic_pnl_simmer",
              component: "skill_cycle",
              cycle_source: "skill",
              skill: skillSlug,
              failure_code: "parse_error",
            },
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
      let runResult: object;
      if (skill !== "built-in" && SKILL_SCRIPTS[skill]) {
        const skillResult = await runSkill(skill);
        let postMonitor: object = {};
        try {
          postMonitor = (await runEngine("monitor")) as object;
        } catch (e) {
          addLog("warn", `Post-skill monitor: ${String(e)}`);
        }
        runResult = { ...skillResult, post_skill_monitor: postMonitor };
      } else {
        runResult = (await runEngine("cycle")) as object;
      }

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

  router.post("/pause", (req: Request, res: Response) => {
    const reason = (req.body as { reason?: string })?.reason ?? "manual pause via API";
    setPaused(true, reason);
    addLog("warn", `Engine paused: ${reason}`);
    broadcast({ type: "paused", payload: { paused: true, reason } });
    res.json({ ok: true, paused: true, reason });
  });

  router.post("/resume", (_req: Request, res: Response) => {
    setPaused(false);
    addLog("info", "Engine resumed");
    broadcast({ type: "paused", payload: { paused: false } });
    res.json({ ok: true, paused: false });
  });

  router.get("/paused", (_req: Request, res: Response) => {
    res.json(getPaused());
  });

  return router;
}
