import type { Request, Response } from "express";
import { spawn } from "child_process";
import express from "express";
import fs from "fs/promises";
import path from "path";

export function dataRoutes(dataDir: string) {
  const router = express.Router();

  const readJson = async (file: string) => {
    const p = path.join(dataDir, file);
    const data = await fs.readFile(p, "utf-8");
    return JSON.parse(data);
  };

  const writeJson = async (file: string, data: object) => {
    const p = path.join(dataDir, file);
    await fs.mkdir(path.dirname(p), { recursive: true });
    await fs.writeFile(p, JSON.stringify(data, null, 2));
  };

  // Game state
  router.get("/game-state", async (_req: Request, res: Response) => {
    try {
      const data = await readJson("game_state.json");
      res.json(data);
    } catch {
      res.status(404).json({ error: "Game state not found" });
    }
  });

  // Strategy config
  router.get("/strategy", async (_req: Request, res: Response) => {
    try {
      const data = await readJson("strategy_config.json");
      res.json(data);
    } catch {
      res.status(404).json({ error: "Strategy config not found" });
    }
  });

  router.put("/strategy", async (req: Request, res: Response) => {
    try {
      await writeJson("strategy_config.json", req.body);
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: String(e) });
    }
  });

  // Trade history
  router.get("/trades", async (_req: Request, res: Response) => {
    try {
      const data = await readJson("trade_history.json");
      res.json(Array.isArray(data) ? data : []);
    } catch {
      res.json([]);
    }
  });

  // Graveyard
  router.get("/graveyard", async (_req: Request, res: Response) => {
    try {
      const data = await readJson("graveyard.json");
      res.json(Array.isArray(data) ? data : []);
    } catch {
      res.json([]);
    }
  });

  // App config (OpenClaw, Telegram)
  const configPath = path.join(dataDir, "app_config.json");
  const defaultConfig = {
    openclaw_url: "",
    openclaw_hooks_path: "/hooks",
    openclaw_hooks_token: "",
    telegram_bot_token: "",
    telegram_chat_id: "",
  };

  router.get("/config", async (_req: Request, res: Response) => {
    try {
      const data = await fs.readFile(configPath, "utf-8");
      const config = JSON.parse(data);
      res.json({ ...defaultConfig, ...config });
    } catch {
      res.json(defaultConfig);
    }
  });

  router.put("/config", async (req: Request, res: Response) => {
    try {
      const body = req.body || {};
      let existing: Record<string, string> = {};
      try {
        const data = await fs.readFile(configPath, "utf-8");
        existing = JSON.parse(data);
      } catch {}
      const config = {
        ...defaultConfig,
        ...existing,
        openclaw_url: String(body.openclaw_url ?? existing.openclaw_url ?? "").trim(),
        openclaw_hooks_path: (String(body.openclaw_hooks_path ?? existing.openclaw_hooks_path ?? "/hooks").trim() || "/hooks").replace(/\/$/, ""),
        openclaw_hooks_token: String(body.openclaw_hooks_token ?? existing.openclaw_hooks_token ?? "").trim(),
        telegram_bot_token: String(body.telegram_bot_token ?? existing.telegram_bot_token ?? "").trim(),
        telegram_chat_id: String(body.telegram_chat_id ?? existing.telegram_chat_id ?? "").trim(),
      };
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      await fs.writeFile(configPath, JSON.stringify(config, null, 2));

      // Append to .env.local so Python engine picks up on next spawn
      const envPath = path.join(dataDir, ".env.local");
      let envContent = "";
      try {
        envContent = await fs.readFile(envPath, "utf-8");
      } catch {}
      const lines = envContent.split("\n").filter((l) => !l.startsWith("OPENCLAW_") && !l.startsWith("TELEGRAM_"));
      if (config.openclaw_url) lines.push(`OPENCLAW_URL=${config.openclaw_url}`);
      if (config.openclaw_hooks_path) lines.push(`OPENCLAW_HOOKS_PATH=${config.openclaw_hooks_path}`);
      if (config.openclaw_hooks_token) lines.push(`OPENCLAW_HOOKS_TOKEN=${config.openclaw_hooks_token}`);
      if (config.telegram_bot_token) lines.push(`TELEGRAM_BOT_TOKEN=${config.telegram_bot_token}`);
      if (config.telegram_chat_id) lines.push(`TELEGRAM_CHAT_ID=${config.telegram_chat_id}`);
      await fs.writeFile(envPath, lines.filter(Boolean).join("\n") + "\n");

      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: String(e) });
    }
  });

  // Save API key (writes to data/.env.local - load with dotenv in engine)
  router.post("/config/api-key", async (req: Request, res: Response) => {
    const { api_key } = req.body || {};
    if (!api_key || typeof api_key !== "string") {
      return res.status(400).json({ error: "api_key required" });
    }
    try {
      const envPath = path.join(dataDir, ".env.local");
      let envContent = "";
      try {
        envContent = await fs.readFile(envPath, "utf-8");
      } catch {}
      const lines = envContent.split("\n").filter((l) => !l.startsWith("SIMMER_API_KEY="));
      lines.push(`SIMMER_API_KEY=${api_key.trim()}`);
      await fs.mkdir(path.dirname(envPath), { recursive: true });
      await fs.writeFile(envPath, lines.filter(Boolean).join("\n") + "\n");
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: String(e) });
    }
  });

  // Reports (stored in data/reports/)
  router.get("/reports", async (_req: Request, res: Response) => {
    try {
      const reportsDir = path.join(dataDir, "reports");
      await fs.mkdir(reportsDir, { recursive: true });
      const files = await fs.readdir(reportsDir);
      const reports = await Promise.all(
        files
          .filter((f) => f.endsWith(".json"))
          .sort()
          .reverse()
          .slice(0, 50)
          .map(async (f) => {
            const data = await fs.readFile(path.join(reportsDir, f), "utf-8");
            return JSON.parse(data);
          })
      );
      res.json(reports);
    } catch {
      res.json([]);
    }
  });

  // Learning analytics (engine instrumentation + state)
  router.get("/learning", async (_req: Request, res: Response) => {
    try {
      const state = await readJson("game_state.json").catch(() => ({}));
      const strategy = await readJson("strategy_config.json").catch(() => ({}));
      const history = await readJson("trade_history.json").catch(() => []);
      const journalPath = path.join(dataDir, "decision_journal.jsonl");
      const modelEvalPath = path.join(dataDir, "model_eval_latest.json");
      let journal: Array<Record<string, unknown>> = [];
      try {
        const text = await fs.readFile(journalPath, "utf-8");
        journal = text
          .split("\n")
          .filter(Boolean)
          .slice(-1000)
          .map((l) => JSON.parse(l));
      } catch {}

      const now = Date.now();
      const dayAgo = now - 24 * 60 * 60 * 1000;
      const recent = journal.filter((e) => {
        const t = String(e.timestamp || "");
        const ms = Date.parse(t);
        return Number.isFinite(ms) && ms >= dayAgo;
      });
      const cycleEvents = recent.filter((e) => e.type === "cycle");
      const tradedEvents = cycleEvents.filter((e) => e.action === "traded");
      const skipReasons: Record<string, number> = {};
      for (const e of cycleEvents) {
        const skips = (e.decision as { skips?: Record<string, number> } | undefined)?.skips || {};
        for (const [k, v] of Object.entries(skips)) skipReasons[k] = (skipReasons[k] || 0) + Number(v || 0);
      }

      const wins = Number(state.wins || 0);
      const losses = Number(state.losses || 0);
      const wlTotal = wins + losses;
      const winRate = wlTotal > 0 ? wins / wlTotal : 0;
      const cycleTradeRate = cycleEvents.length > 0 ? tradedEvents.length / cycleEvents.length : 0;
      const dailyPnl = Number(state.daily_realized_pnl || 0);
      const drawdownPressure = Number(state.consecutive_losses || 0);
      const learningScore = Math.max(
        0,
        Math.min(
          100,
          Math.round(
            (winRate * 50) +
            (cycleTradeRate * 25) +
            (dailyPnl >= 0 ? 15 : Math.max(0, 15 + dailyPnl / 5)) +
            Math.max(0, 10 - drawdownPressure * 2)
          )
        )
      );

      let modelEval: Record<string, unknown> | null = null;
      let baselineVsAdaptive: Record<string, unknown> | null = null;
      try {
        const evalRaw = await fs.readFile(modelEvalPath, "utf-8");
        modelEval = JSON.parse(evalRaw);
        const baseline = (modelEval?.baseline || {}) as Record<string, unknown>;
        const best = (modelEval?.best_policy || {}) as Record<string, unknown>;
        const baseScore = Number(baseline.score || 0);
        const bestScore = Number(best.score || 0);
        baselineVsAdaptive = {
          base_score: baseScore,
          adaptive_score: bestScore,
          delta_score: bestScore - baseScore,
          base_win_rate: Number(baseline.win_rate || 0),
          adaptive_win_rate: Number(best.win_rate || 0),
          adaptive_confidence: Number(best.confidence || 0),
        };
      } catch {}

      res.json({
        score: learningScore,
        wins,
        losses,
        win_rate: winRate,
        cycle_events_24h: cycleEvents.length,
        traded_cycles_24h: tradedEvents.length,
        cycle_trade_rate_24h: cycleTradeRate,
        skip_reasons_24h: skipReasons,
        daily_realized_pnl: dailyPnl,
        consecutive_losses: drawdownPressure,
        paused: Boolean(state.pause_until && Date.parse(String(state.pause_until)) > Date.now()),
        last_model_eval_at: state.last_model_eval_at ?? null,
        last_model_apply_at: state.last_model_apply_at ?? null,
        strategy_mode: strategy.strategy_mode || "balanced",
        auto_regime: Boolean(strategy.auto_regime ?? true),
        total_history_rows: Array.isArray(history) ? history.length : 0,
        model_eval: modelEval,
        baseline_vs_adaptive: baselineVsAdaptive,
      });
    } catch (e) {
      res.status(500).json({ error: String(e) });
    }
  });

  // Read-only calibration (expected edge / divergence bins vs outcomes). File written by engine `calibrate`.
  router.get("/learning/calibration", async (_req: Request, res: Response) => {
    try {
      const p = path.join(dataDir, "model_calibration_latest.json");
      const raw = await fs.readFile(p, "utf-8");
      res.json(JSON.parse(raw));
    } catch {
      res.status(404).json({
        ok: false,
        error: "No calibration file yet. POST /api/learning/calibrate or run: python -m engine.src.main calibrate",
      });
    }
  });

  router.post("/learning/calibrate", async (_req: Request, res: Response) => {
    const projectRoot = path.dirname(dataDir);
    const py = process.platform === "win32" ? "python" : "python3";
    const proc = spawn(py, ["-m", "engine.src.main", "calibrate"], {
      cwd: projectRoot,
      env: { ...process.env },
    });
    let errBuf = "";
    proc.stderr?.on("data", (d) => (errBuf += d.toString()));
    proc.on("close", async (code) => {
      try {
        const p = path.join(dataDir, "model_calibration_latest.json");
        const raw = await fs.readFile(p, "utf-8");
        res.status(code === 0 ? 200 : 500).json(JSON.parse(raw));
      } catch {
        res.status(500).json({ ok: false, error: errBuf || `calibrate exited ${code}` });
      }
    });
  });

  // Decision-hour outcomes: bucket by trade ENTRY time, outcome attached when resolved.
  router.get("/hourly-outcomes", async (_req: Request, res: Response) => {
    try {
      const featuresPath = path.join(dataDir, "model_features.jsonl");
      const labelsPath = path.join(dataDir, "model_labels.jsonl");
      const apiKey = process.env.SIMMER_API_KEY;

      const readJsonl = async (filePath: string): Promise<Array<Record<string, unknown>>> => {
        try {
          const text = await fs.readFile(filePath, "utf-8");
          return text
            .split("\n")
            .filter(Boolean)
            .map((l) => {
              try {
                return JSON.parse(l) as Record<string, unknown>;
              } catch {
                return null;
              }
            })
            .filter((x): x is Record<string, unknown> => Boolean(x));
        } catch {
          return [];
        }
      };

      const features = await readJsonl(featuresPath);
      const labels = await readJsonl(labelsPath);

      // Best effort question map for market-type classification.
      const questionByMarket = new Map<string, string>();
      if (apiKey) {
        try {
          const base = "https://api.simmer.markets";
          const headers = { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" };
          const opts: RequestInit = { headers, signal: AbortSignal.timeout(15000) };
          const r = await fetch(`${base}/api/sdk/trades?venue=sim`, opts);
          const d = (await r.json()) as Record<string, unknown>;
          const trades = ((d as Record<string, unknown>).trades || d) as Array<Record<string, unknown>>;
          if (Array.isArray(trades)) {
            for (const t of trades) {
              const mid = String(t.market_id || "");
              const q = String(t.question || "");
              if (mid && q && !questionByMarket.has(mid)) questionByMarket.set(mid, q);
            }
          }
        } catch {}
      }

      const keyOf = (row: Record<string, unknown>): string =>
        `${String(row.market_id || "")}:${String(row.side || "unknown")}`;

      // Queue labels per key and attach each label to one prior feature (entry decision).
      const labelsByKey = new Map<string, Array<Record<string, unknown>>>();
      for (const lb of labels) {
        const key = keyOf(lb);
        if (!labelsByKey.has(key)) labelsByKey.set(key, []);
        labelsByKey.get(key)!.push(lb);
      }
      for (const arr of labelsByKey.values()) {
        arr.sort((a, b) => Date.parse(String(a.timestamp || "")) - Date.parse(String(b.timestamp || "")));
      }

      const feats = [...features].sort(
        (a, b) => Date.parse(String(a.timestamp || "")) - Date.parse(String(b.timestamp || ""))
      );

      const inferMarketType = (question: string): string => {
        const q = question.toLowerCase();
        if (!q) return "unknown";
        if (/(bitcoin|btc|ethereum|eth|solana|doge|token|crypto|coin|price)/.test(q)) return "crypto";
        if (/(weather|temperature|rain|snow|storm|hurricane|climate)/.test(q)) return "weather";
        if (/(election|president|senate|congress|vote|politic)/.test(q)) return "politics";
        if (/(vs|o\/u|points|rebounds|assists|goal|match|cup|nfl|nba|mlb|nhl|soccer|football|baseball|hockey|basketball)/.test(q)) return "sports";
        return "other";
      };

      type Bucket = { hour: number; wins: number; losses: number; n: number; avg_return_pct: number };
      const mkBuckets = (): Bucket[] =>
        Array.from({ length: 24 }, (_, hour) => ({ hour, wins: 0, losses: 0, n: 0, avg_return_pct: 0 }));
      const overall = mkBuckets();
      const byType = new Map<string, Bucket[]>();
      const ensureType = (t: string): Bucket[] => {
        if (!byType.has(t)) byType.set(t, mkBuckets());
        return byType.get(t)!;
      };

      let paired = 0;
      for (const ft of feats) {
        const key = keyOf(ft);
        const queue = labelsByKey.get(key) || [];
        if (!queue.length) continue;
        const ftTs = Date.parse(String(ft.timestamp || ""));
        if (!Number.isFinite(ftTs)) continue;

        // Match to first label with timestamp >= feature timestamp, else first remaining.
        let idx = queue.findIndex((lb) => Date.parse(String(lb.timestamp || "")) >= ftTs);
        if (idx < 0) idx = 0;
        const lb = queue.splice(idx, 1)[0];
        if (!lb) continue;

        const won = Boolean(lb.won);
        const ret = Number(lb.return_pct ?? 0);
        const hour = new Date(ftTs).getHours(); // local server hour bucket
        const marketId = String(ft.market_id || "");
        const taggedType = String(ft.market_type || "").toLowerCase();
        const featureQuestion = String(ft.question || "");
        const q = featureQuestion || questionByMarket.get(marketId) || "";
        const marketType = ["crypto", "sports", "weather", "politics", "other", "unknown"].includes(taggedType)
          ? taggedType
          : inferMarketType(q);

        const o = overall[hour];
        o.n += 1;
        if (won) o.wins += 1;
        else o.losses += 1;
        o.avg_return_pct += ret;

        const tBuckets = ensureType(marketType);
        const t = tBuckets[hour];
        t.n += 1;
        if (won) t.wins += 1;
        else t.losses += 1;
        t.avg_return_pct += ret;

        paired += 1;
      }

      const finalize = (buckets: Bucket[]): Bucket[] =>
        buckets.map((b) => ({
          ...b,
          avg_return_pct: b.n > 0 ? b.avg_return_pct / b.n : 0,
        }));

      const overallFinal = finalize(overall);
      const byTypeFinal = Object.fromEntries(
        Array.from(byType.entries()).map(([k, v]) => [k, finalize(v)])
      );

      const totalWins = overallFinal.reduce((s, b) => s + b.wins, 0);
      const totalLosses = overallFinal.reduce((s, b) => s + b.losses, 0);
      const total = totalWins + totalLosses;
      const topHours = [...overallFinal]
        .filter((b) => b.n >= 3)
        .sort((a, b) => (b.wins / Math.max(1, b.n)) - (a.wins / Math.max(1, a.n)))
        .slice(0, 3)
        .map((b) => ({ hour: b.hour, n: b.n, win_rate: b.wins / Math.max(1, b.n) }));

      res.json({
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        paired_samples: paired,
        features: features.length,
        labels: labels.length,
        summary: {
          total,
          wins: totalWins,
          losses: totalLosses,
          win_rate: total > 0 ? totalWins / total : 0,
          top_hours: topHours,
        },
        overall: overallFinal,
        by_market_type: byTypeFinal,
      });
    } catch (e) {
      res.status(500).json({ error: String(e) });
    }
  });

  // Trade audit: join local history + labels with Simmer positions/trades
  router.get("/trade-audit", async (_req: Request, res: Response) => {
    try {
      const apiKey = process.env.SIMMER_API_KEY;
      const localTrades: Array<Record<string, unknown>> = await readJson("trade_history.json").catch(() => []);

      // Read model labels (local resolution data)
      const labelsPath = path.join(dataDir, "model_labels.jsonl");
      const labelMap = new Map<string, Record<string, unknown>>();
      try {
        const text = await fs.readFile(labelsPath, "utf-8");
        for (const line of text.split("\n")) {
          if (!line.trim()) continue;
          try {
            const lb = JSON.parse(line);
            const key = `${lb.market_id}:${lb.side || "unknown"}`;
            labelMap.set(key, lb);
          } catch {}
        }
      } catch {}

      // Fetch Simmer positions + trades
      let simmerPositions: Array<Record<string, unknown>> = [];
      let simmerTrades: Array<Record<string, unknown>> = [];
      if (apiKey) {
        const base = "https://api.simmer.markets";
        const headers = { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" };
        const opts: RequestInit = { headers, signal: AbortSignal.timeout(15000) };
        try {
          const r = await fetch(`${base}/api/sdk/positions`, opts);
          const d = await r.json() as Record<string, unknown>;
          simmerPositions = (d.positions || d) as Array<Record<string, unknown>>;
          if (!Array.isArray(simmerPositions)) simmerPositions = [];
        } catch {}
        try {
          const r = await fetch(`${base}/api/sdk/trades?venue=sim`, opts);
          const d = await r.json() as Record<string, unknown>;
          simmerTrades = ((d as Record<string, unknown>).trades || d) as Array<Record<string, unknown>>;
          if (!Array.isArray(simmerTrades)) simmerTrades = [];
        } catch {}
      }

      // Index Simmer data by market_id
      const simmerPosMap = new Map<string, Record<string, unknown>>();
      for (const p of simmerPositions) {
        const mid = String(p.market_id || "");
        if (mid) simmerPosMap.set(mid, p);
      }
      const simmerTradeMap = new Map<string, Array<Record<string, unknown>>>();
      for (const t of simmerTrades) {
        const mid = String(t.market_id || "");
        if (!mid) continue;
        if (!simmerTradeMap.has(mid)) simmerTradeMap.set(mid, []);
        simmerTradeMap.get(mid)!.push(t);
      }

      // Build local buy entries only (skip sell records for row grouping)
      const buys = (Array.isArray(localTrades) ? localTrades : []).filter(
        (t) => t.action !== "sell"
      );
      // Find matching sell for each buy
      const sells = (Array.isArray(localTrades) ? localTrades : []).filter(
        (t) => t.action === "sell"
      );
      const sellMap = new Map<string, Record<string, unknown>>();
      for (const s of sells) {
        const key = `${s.market_id}:${s.side || "unknown"}`;
        sellMap.set(key, s);
      }

      const rows = buys.map((buy) => {
        const mid = String(buy.market_id || "");
        const side = String(buy.side || "unknown");
        const key = `${mid}:${side}`;
        const localSell = sellMap.get(key) || null;
        const label = labelMap.get(key) || null;
        const simPos = simmerPosMap.get(mid) || null;
        const simTrades = simmerTradeMap.get(mid) || [];

        const sharesYes = simPos ? Number((simPos as Record<string, unknown>).shares_yes ?? 0) : 0;
        const sharesNo = simPos ? Number((simPos as Record<string, unknown>).shares_no ?? 0) : 0;
        const materialSimShares = sharesYes >= 0.01 || sharesNo >= 0.01;

        // Simmer outcome from position
        let simStatus = simPos ? String((simPos as Record<string, unknown>).status || "") : "";
        let simPnl: number | null = simPos ? Number((simPos as Record<string, unknown>).pnl ?? 0) : null;
        let simOutcome = simPos ? String((simPos as Record<string, unknown>).outcome || "") : "";
        let simCostBasis: number | null = simPos ? Number((simPos as Record<string, unknown>).cost_basis ?? 0) : null;
        const simQuestion = simPos ? String((simPos as Record<string, unknown>).question || "") : "";

        // If no Simmer position but there are Simmer trades, infer outcome from trades
        if (!simPos && simTrades.length > 0) {
          const sellTrades = simTrades.filter((t) => String(t.action || "").toLowerCase() === "sell");
          if (sellTrades.length > 0) {
            simStatus = "sold";
            simOutcome = "sold";
            const totalPnl = simTrades.reduce((s, t) => s + Number(t.pnl ?? 0), 0);
            if (totalPnl !== 0) simPnl = totalPnl;
          } else {
            simStatus = "gone";
            simOutcome = "gone";
          }
        } else if (!simPos && simTrades.length === 0) {
          simStatus = "gone";
          simOutcome = "gone";
        }

        // API quirk: status still "active"/"open" but zero shares (already flat on Simmer)
        const stLow = simStatus.toLowerCase();
        if (simPos && !materialSimShares && (stLow === "active" || stLow === "open")) {
          simStatus = "closed";
          if (!simOutcome) simOutcome = "closed";
        }

        // Determine local outcome: label > sell record > (if simmer says gone, mark as gone) > open
        let outcomeLocal = "open";
        if (label) {
          outcomeLocal = label.won ? "win" : "loss";
        } else if (localSell) {
          outcomeLocal = "closed";
        } else if (simStatus === "gone" || simStatus === "sold" || simStatus === "resolved" || simStatus === "closed") {
          outcomeLocal = "gone";
        }

        // Question: try simmer position, then simmer trades
        let question = simQuestion;
        if (!question && simTrades.length > 0) {
          question = String((simTrades[0] as Record<string, unknown>).question || "");
        }

        return {
          market_id: mid,
          question,
          side,
          shares: buy.shares ?? null,
          investment: Number(buy.amount || 0),
          created_at: buy.created_at || null,

          // Local outcome
          outcome_local: outcomeLocal,
          pnl_local: label ? Number(label.pnl ?? 0) : null,
          return_pct_local: label ? Number(label.return_pct ?? 0) : null,
          reason_local: localSell ? String((localSell as Record<string, unknown>).reason || "") : (label ? String(label.source || "") : ""),

          // Simmer outcome
          outcome_simmer: simOutcome || simStatus || "",
          pnl_simmer: simPnl,
          cost_basis_simmer: simCostBasis,
          return_pct_simmer: simCostBasis && simCostBasis > 0 && simPnl !== null ? simPnl / simCostBasis : null,
          status_simmer: simStatus,
          shares_yes: sharesYes,
          shares_no: sharesNo,
          resolves_at: simPos ? String((simPos as Record<string, unknown>).resolves_at ?? (simPos as Record<string, unknown>).end_date ?? "") : "",
          simmer_trades_count: simTrades.length,
        };
      });

      rows.sort((a, b) => {
        const ta = a.created_at ? new Date(a.created_at as string).getTime() : 0;
        const tb = b.created_at ? new Date(b.created_at as string).getTime() : 0;
        return tb - ta;
      });

      res.json({ rows, total: rows.length });
    } catch (e) {
      res.status(500).json({ error: String(e) });
    }
  });

  return router;
}
