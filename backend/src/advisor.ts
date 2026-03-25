import fs from "fs/promises";
import path from "path";

type AnyRec = Record<string, any>;

async function getJson(url: string): Promise<AnyRec> {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(15000) });
    return (await r.json().catch(() => ({}))) as AnyRec;
  } catch {
    return {};
  }
}

export async function buildAdvisorReport(port: number, projectRoot: string, trigger: string): Promise<{ report: AnyRec; text: string }> {
  const base = `http://127.0.0.1:${port}/api`;
  const [health, learning, hourly, me, portfolio, gameState] = await Promise.all([
    getJson(`${base}/health`),
    getJson(`${base}/learning`),
    getJson(`${base}/hourly-outcomes`),
    getJson(`${base}/simmer/agents/me`),
    getJson(`${base}/simmer/portfolio`),
    getJson(`${base}/game-state`),
  ]);

  const pnlPortfolio = Number(portfolio?.sim_pnl ?? 0);
  const pnlAgent = Number(me?.sim_pnl ?? me?.total_pnl ?? 0);
  const pnlGap = pnlPortfolio - pnlAgent;
  const simmerWins = Number(me?.win_count ?? 0);
  const simmerLosses = Number(me?.loss_count ?? 0);
  const rookieWins = Number(gameState?.wins ?? 0);
  const rookieLosses = Number(gameState?.losses ?? 0);

  const evalDelta = Number(learning?.baseline_vs_adaptive?.delta_score ?? learning?.model_eval?.improvement_over_baseline_score ?? 0);
  const evalConf = Number(learning?.baseline_vs_adaptive?.adaptive_confidence ?? learning?.model_eval?.best_policy?.confidence ?? 0);
  const paired = Number(hourly?.paired_samples ?? 0);
  const topHours = Array.isArray(hourly?.summary?.top_hours) ? hourly.summary.top_hours : [];

  const problems: string[] = [];
  if (String(health?.backend?.status || "red") !== "green") problems.push("backend not green");
  if (String(health?.simmer?.status || "red") === "red") problems.push("simmer red");
  if (Math.abs(pnlGap) > 25) problems.push("PnL gap agent vs portfolio is high");
  if (paired < 20) problems.push("low paired learning samples");
  if (evalDelta <= 0.01) problems.push("weak learning signal");

  const verdict = problems.length === 0 ? "OK" : problems.length <= 2 ? "WATCH" : "ACTION_NEEDED";
  const now = new Date();
  const report = {
    generated_at: now.toISOString(),
    trigger,
    verdict,
    problems,
    alignment: {
      pnl_portfolio: pnlPortfolio,
      pnl_agents_me: pnlAgent,
      pnl_gap: pnlGap,
      simmer_wins: simmerWins,
      simmer_losses: simmerLosses,
      rookie_wins: rookieWins,
      rookie_losses: rookieLosses,
      simmer_trades: Number(me?.trades_count ?? 0),
      rookie_buys: Number(gameState?.trades_count ?? 0),
    },
    learning: {
      score: Number(learning?.score ?? 0),
      paired_samples: paired,
      eval_delta_score: evalDelta,
      eval_confidence: evalConf,
      cycle_trade_rate_24h: Number(learning?.cycle_trade_rate_24h ?? 0),
      daily_realized_pnl: Number(learning?.daily_realized_pnl ?? 0),
      strategy_mode: String(learning?.strategy_mode ?? "unknown"),
      top_hours: topHours,
    },
    health,
  };

  const reportsDir = path.join(projectRoot, "data", "reports");
  await fs.mkdir(reportsDir, { recursive: true });
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  await fs.writeFile(path.join(reportsDir, `advisor-${stamp}.json`), JSON.stringify(report, null, 2), "utf-8");

  const text =
    `Rookie Advisor (${trigger})\n` +
    `Verdict: ${verdict}\n` +
    `(Economic KPI: portfolio PnL; game points are separate.)\n` +
    `PnL: portfolio=${fmt(pnlPortfolio)} | agents/me=${fmt(pnlAgent)} | gap=${fmt(pnlGap)}\n` +
    `W/L: Simmer ${simmerWins}/${simmerLosses} | Rookie ${rookieWins}/${rookieLosses}\n` +
    `Learning: score=${Math.round(Number(learning?.score ?? 0))}, paired=${paired}, delta=${evalDelta.toFixed(3)}, conf=${(evalConf * 100).toFixed(0)}%\n` +
    `Mode: ${String(learning?.strategy_mode ?? "unknown")} | 24h trade-rate=${(Number(learning?.cycle_trade_rate_24h ?? 0) * 100).toFixed(0)}%\n` +
    `Top hours: ${formatTopHours(topHours)}\n` +
    (problems.length ? `Issues: ${problems.join("; ")}` : "Issues: none");

  return { report, text };
}

function fmt(v: number): string {
  return `${v >= 0 ? "+" : ""}${v.toFixed(2)}`;
}

function formatTopHours(topHours: any[]): string {
  if (!Array.isArray(topHours) || !topHours.length) return "n/a";
  return topHours
    .map((h) => `${String(h.hour).padStart(2, "0")}:00(${Math.round(Number(h.win_rate || 0) * 100)}%,n=${Number(h.n || 0)})`)
    .join(", ");
}

function formatResolutionCountdown(pos: AnyRec): string {
  const raw =
    pos.resolves_at ?? pos.end_date ?? pos.resolution_time ?? pos.resolution_date ?? pos.close_time ?? "";
  if (raw === null || raw === undefined || String(raw).trim() === "") return "n/a";
  const s = String(raw).trim();
  try {
    const normalized = s.includes("T") ? s.replace(/Z$/i, "+00:00") : s;
    const t = new Date(normalized);
    if (Number.isNaN(t.getTime())) return "n/a";
    const ms = t.getTime() - Date.now();
    if (ms <= 0) return "due now / past";
    const totalM = Math.floor(ms / 60000);
    const d = Math.floor(totalM / 1440);
    const h = Math.floor((totalM % 1440) / 60);
    const m = totalM % 60;
    if (d > 0) return `${d}d ${h}h ${m}m`;
    if (h > 0) return `${h}h ${m}m`;
    return `${m}m`;
  } catch {
    return "n/a";
  }
}

function truncate(s: string, max: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  return `${t.slice(0, max - 1)}…`;
}

/** Open Simmer positions for Telegram /positions (and typo /posittions). */
export async function buildOpenPositionsTelegramText(port: number): Promise<string> {
  const url = `http://127.0.0.1:${port}/api/simmer/positions`;
  let r: Response;
  try {
    r = await fetch(url, { signal: AbortSignal.timeout(20000) });
  } catch (e) {
    return `Open positions\nRequest failed: ${String(e)}`;
  }
  if (!r.ok) {
    const errBody = (await r.json().catch(() => ({}))) as AnyRec;
    const detail = errBody?.error != null ? String(errBody.error) : `HTTP ${r.status}`;
    return `Open positions\n${detail}`;
  }
  const data = (await r.json().catch(() => ({}))) as AnyRec;
  const raw = data.positions ?? data;
  const list: AnyRec[] = Array.isArray(raw) ? raw : [];
  const open = list.filter((p) => String(p.status || "").toLowerCase() === "active");

  if (open.length === 0) {
    return "Open positions\nNone (active).";
  }

  const lines: string[] = [`Open positions (${open.length})`, ""];
  let i = 0;
  for (const p of open) {
    i += 1;
    const mid = String(p.market_id ?? "?");
    const q = truncate(String(p.question ?? p.title ?? mid), 56);
    const sharesY = Number(p.shares_yes ?? 0);
    const sharesN = Number(p.shares_no ?? 0);
    const side = sharesY >= 0.01 ? "YES" : sharesN >= 0.01 ? "NO" : "?";
    const pnl = Number(p.pnl ?? 0);
    const basis = Number(p.cost_basis ?? 0);
    const pnlPct = basis > 0 ? (pnl / basis) * 100 : null;
    const pnlStr = `${pnl >= 0 ? "+" : ""}${pnl.toFixed(2)}`;
    const pctStr = pnlPct !== null ? ` (${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(1)}%)` : "";
    const eta = formatResolutionCountdown(p);
    const venue = String(p.venue ?? "");
    const ven = venue ? ` · ${venue}` : "";

    lines.push(`${i}) ${q}`);
    lines.push(`   ${side}${ven} · PnL ${pnlStr}${pctStr} · resolves in ${eta}`);
    lines.push(`   id ${mid.length > 36 ? `${mid.slice(0, 18)}…${mid.slice(-10)}` : mid}`);
    lines.push("");
  }

  return lines.join("\n").trimEnd();
}

