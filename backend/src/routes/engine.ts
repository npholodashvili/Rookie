import type { Request, Response } from "express";
import express from "express";
import { spawn } from "child_process";
import fs from "fs/promises";
import path from "path";

import { addLog } from "../logs.js";
import { broadcast } from "../websocket.js";
import { getStatus, setLastCycle } from "../engineStatus.js";

const SKILL_SCRIPTS: Record<string, string> = {
  "polymarket-ai-divergence": "skills/polymarket-ai-divergence/ai_divergence.py",
  "polymarket-weather-trader": "skills/polymarket-weather-trader/weather_trader.py",
};

const ENGINE_COMMAND_TIMEOUT_MS: Record<string, number> = {
  cycle: 90_000,
  monitor: 90_000,
  report: 90_000,
  calibrate: 180_000,
  evaluate: 180_000,
};

const inFlightByCommand = new Map<string, { startedAt: number; requestId: string }>();

function makeRequestId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function engineRoutes(projectRoot: string) {
  const router = express.Router();
  const dataDir = path.join(projectRoot, "data");

  const TELEMETRY_SCHEMA_VERSION = 1;

  const runEngine = (cmd: string, requestId: string): Promise<object> => {
    return new Promise((resolve, reject) => {
      const py = process.platform === "win32" ? "python" : "python3";
      const proc = spawn(py, ["-m", "engine.src.main", cmd], {
        cwd: projectRoot,
        env: { ...process.env, ROOKIE_REQUEST_ID: requestId },
      });
      const timeoutMs = ENGINE_COMMAND_TIMEOUT_MS[cmd] ?? 90_000;
      const timeout = setTimeout(() => {
        proc.kill();
        reject(new Error(`engine ${cmd} timed out after ${timeoutMs}ms [${requestId}]`));
      }, timeoutMs);

      let out = "";
      let err = "";

      proc.stdout?.on("data", (d) => (out += d.toString()));
      proc.stderr?.on("data", (d) => (err += d.toString()));

      proc.on("close", (code) => {
        clearTimeout(timeout);
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
        resolve({ ...parsed, request_id: requestId });
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

  const runSkill = async (skillSlug: string, requestId: string): Promise<object> => {
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
    env.ROOKIE_REQUEST_ID = requestId;

    return new Promise((resolve, reject) => {
      const py = process.platform === "win32" ? "python" : "python3";
      const scriptPath = path.join(projectRoot, scriptRel);
      const proc = spawn(py, [scriptPath, "--live", "--quiet"], {
        cwd: projectRoot,
        env,
      });

      const timeoutMs = ENGINE_COMMAND_TIMEOUT_MS.cycle;
      const timeout = setTimeout(() => {
        proc.kill();
        reject(new Error(`skill ${skillSlug} timed out after ${timeoutMs}ms [${requestId}]`));
      }, timeoutMs);
      let out = "";
      let err = "";

      proc.stdout?.on("data", (d) => (out += d.toString()));
      proc.stderr?.on("data", (d) => (err += d.toString()));

      proc.on("close", (code) => {
        clearTimeout(timeout);
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
            request_id: requestId,
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
            request_id: requestId,
          });
        }
      });
    });
  };

  const withSingleFlight = async <T>(
    command: string,
    requestId: string,
    runner: () => Promise<T>
  ): Promise<T> => {
    const current = inFlightByCommand.get(command);
    if (current) {
      throw new Error(
        `engine ${command} already running (${Math.round((Date.now() - current.startedAt) / 1000)}s, request=${current.requestId})`
      );
    }
    inFlightByCommand.set(command, { startedAt: Date.now(), requestId });
    try {
      return await runner();
    } finally {
      inFlightByCommand.delete(command);
    }
  };

  router.post("/cycle", async (_req: Request, res: Response) => {
    const requestId = makeRequestId("cycle");
    addLog("info", "Running trading cycle...", { request_id: requestId });
    try {
      const runResult = await withSingleFlight("cycle", requestId, async () => {
        let strategy: { skill?: string } = {};
        try {
          const cfg = await fs.readFile(path.join(dataDir, "strategy_config.json"), "utf-8");
          strategy = JSON.parse(cfg);
        } catch {}

        const skill = strategy.skill || "built-in";
        if (skill !== "built-in" && SKILL_SCRIPTS[skill]) {
          const skillResult = await runSkill(skill, requestId);
          let postMonitor: object = {};
          try {
            postMonitor = (await withSingleFlight("monitor", requestId, async () =>
              runEngine("monitor", requestId)
            )) as object;
          } catch (e) {
            addLog("warn", `Post-skill monitor: ${String(e)}`, { request_id: requestId });
          }
          return { ...skillResult, post_skill_monitor: postMonitor };
        }
        return (await runEngine("cycle", requestId)) as object;
      });

      const result = runResult as {
        action?: string;
        reason?: string;
        decision?: Record<string, unknown>;
        alive?: boolean;
        state?: { trades_count?: number };
      };
      broadcast({ type: "state", payload: result });
      const action = result?.action ?? "none";
      const reason = result?.reason ?? "";
      const msg =
        action === "traded"
          ? `Cycle completed: trade executed (total trades: ${result?.state?.trades_count ?? "?"})`
          : reason && reason !== "ok"
            ? `Cycle completed: ${action} — ${reason}`
            : `Cycle completed: ${action}`;
      addLog(action === "traded" ? "success" : "info", msg, { request_id: requestId });
      const decision = {
        ...(typeof result?.decision === "object" && result.decision !== null ? result.decision : {}),
        cycle_source:
          typeof result?.decision?.cycle_source === "string" ? result.decision.cycle_source : "builtin",
      };
      setLastCycle(action, reason, decision);
      res.json({ ...result, decision });
    } catch (e) {
      const msg = String(e);
      const status = msg.includes("already running") ? 409 : 500;
      addLog(status === 409 ? "warn" : "error", `Cycle failed: ${msg}`, { request_id: requestId });
      res.status(status).json({ error: msg, request_id: requestId });
    }
  });

  router.post("/monitor", async (_req: Request, res: Response) => {
    const requestId = makeRequestId("monitor");
    try {
      const result = (await withSingleFlight("monitor", requestId, async () =>
        runEngine("monitor", requestId)
      )) as { action?: string; closed?: number };
      if (result?.closed && result.closed > 0) {
        addLog("success", `Position monitor: closed ${result.closed} position(s)`, { request_id: requestId });
        broadcast({ type: "state", payload: result });
      }
      res.json(result);
    } catch (e) {
      const msg = String(e);
      const status = msg.includes("already running") ? 409 : 500;
      addLog(status === 409 ? "warn" : "error", `Monitor failed: ${msg}`, { request_id: requestId });
      res.status(status).json({ error: msg, request_id: requestId });
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
    const requestId = makeRequestId("report");
    addLog("info", "Generating Simmer snapshot report...", { request_id: requestId });
    try {
      const result = (await withSingleFlight("report", requestId, async () =>
        runEngine("report", requestId)
      )) as { report?: { fees_recent_sum?: number; positions_count?: number } };
      broadcast({ type: "report", payload: result });
      const fr = result?.report?.fees_recent_sum;
      const pc = result?.report?.positions_count;
      addLog("success", `Report generated. Fees (recent sum): ${fr ?? "—"} · positions: ${pc ?? "—"}`, {
        request_id: requestId,
      });
      res.json(result);
    } catch (e) {
      const msg = String(e);
      const status = msg.includes("already running") ? 409 : 500;
      addLog(status === 409 ? "warn" : "error", `Report failed: ${msg}`, { request_id: requestId });
      res.status(status).json({ error: msg, request_id: requestId });
    }
  });

  return router;
}
