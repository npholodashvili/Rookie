import { useEffect, useState } from "react";
import { useWebSocket } from "../hooks/useWebSocket";
import { isEffectivelyOpenPosition } from "../lib/positions";
import { LogPanel } from "./LogPanel";

const API = "/api";

interface EngineStatus {
  last_cycle_at?: string | null;
  last_action?: string | null;
  last_reason?: string | null;
  last_decision?: {
    scanned?: number;
    skips?: Record<string, number>;
    fallback_mode?: boolean;
    cycle_source?: string;
    picked?: { market_id?: string; expected_edge?: number; volume_24h?: number };
    candidates_passing?: number;
  } | null;
  last_simmer_call_at?: string | null;
  next_cycle_at?: string;
  strategy?: Record<string, any>;
}

interface LearningStats {
  score?: number;
  win_rate?: number;
  cycle_events_24h?: number;
  traded_cycles_24h?: number;
  cycle_trade_rate_24h?: number;
  daily_realized_pnl?: number;
  consecutive_losses?: number;
  last_model_eval_at?: string | null;
  last_model_apply_at?: string | null;
  strategy_mode?: string;
  model_eval?: {
    samples?: number;
    holdout_blocks_apply?: boolean;
    holdout_validation?: {
      enabled?: boolean;
      passed?: boolean;
      skipped_reason?: string | null;
      train_n?: number;
      test_n?: number;
      test_best_score?: number | null;
      test_baseline_score?: number | null;
      delta_on_holdout?: number | null;
    };
    best_policy?: {
      min_expected_edge_pct?: number;
      max_slippage_pct?: number;
      min_liquidity_24h?: number;
      win_rate?: number;
      avg_return_pct?: number;
      score?: number;
      confidence?: number;
      n?: number;
    };
    train_baseline?: { score?: number; win_rate?: number; n?: number };
    train_best_policy?: { score?: number; win_rate?: number; n?: number };
  };
  baseline_vs_adaptive?: {
    base_score?: number;
    adaptive_score?: number;
    delta_score?: number;
    adaptive_confidence?: number;
  };
}

function formatCountdown(nextAt?: string): string {
  if (!nextAt) return "—";
  try {
    const next = new Date(nextAt);
    const now = new Date();
    const ms = next.getTime() - now.getTime();
    if (ms <= 0) return "Running...";
    const m = Math.floor(ms / 60000);
    const s = Math.floor((ms % 60000) / 1000);
    return `${m}m ${s}s`;
  } catch {
    return "—";
  }
}

interface GameState {
  wins?: number;
  losses?: number;
  trades_count?: number;
}

interface AgentMe {
  balance?: number;
  sim_balance?: number;
  sim_pnl?: number;
  total_pnl?: number;
  pnl?: number;
  win_count?: number;
  loss_count?: number;
  trades_count?: number;
  win_rate?: number;
}

interface Position {
  question?: string;
  pnl?: number;
  market_id?: string;
  status?: string;
  shares_yes?: number;
  shares_no?: number;
  resolves_at?: string;
  time_to_resolution?: string;
}

interface PortfolioSummary {
  sim_pnl?: number;
  pnl_total?: number;
}

interface CalibrationBin {
  bucket?: string;
  n?: number;
  win_rate?: number;
  avg_return_pct?: number;
}

interface CalibrationReport {
  ok?: boolean;
  paired_samples?: number;
  generated_at?: string;
  by_expected_edge_bin?: CalibrationBin[];
  by_abs_divergence_bin?: CalibrationBin[];
  note?: string;
}

interface GovernancePayload {
  ok?: boolean;
  events?: Array<Record<string, unknown>>;
  message?: string;
}

interface SkipReasonSummary {
  lookback_hours?: number;
  cycles_considered?: number;
  top?: Array<{ reason: string; count: number }>;
}

function formatResolutionTimer(resolvesAt?: string, timeToResolution?: string): string {
  if (timeToResolution) return timeToResolution;
  if (!resolvesAt) return "—";
  try {
    const resolved = new Date(resolvesAt);
    const now = new Date();
    const ms = resolved.getTime() - now.getTime();
    if (ms <= 0) return "Resolved";
    const d = Math.floor(ms / 86400000);
    const h = Math.floor((ms % 86400000) / 3600000);
    const m = Math.floor((ms % 3600000) / 60000);
    if (d > 0) return `${d}d ${h}h`;
    if (h > 0) return `${h}h ${m}m`;
    return `${m}m`;
  } catch {
    return resolvesAt.slice(0, 10);
  }
}

export function Dashboard() {
  const [gameState, setGameState] = useState<GameState | null>(null);
  const [agent, setAgent] = useState<AgentMe | null>(null);
  const [positions, setPositions] = useState<Position[]>([]);
  const [trades, setTrades] = useState<unknown[]>([]);
  const [portfolio, setPortfolio] = useState<PortfolioSummary | null>(null);
  const [lastUpdated, setLastUpdated] = useState<string | null>(null);
  const [engineStatus, setEngineStatus] = useState<EngineStatus | null>(null);
  const [learning, setLearning] = useState<LearningStats | null>(null);
  const [calibration, setCalibration] = useState<CalibrationReport | null>(null);
  const [calibrateRunning, setCalibrateRunning] = useState(false);
  const [evaluateRunning, setEvaluateRunning] = useState(false);
  const [governance, setGovernance] = useState<GovernancePayload | null>(null);
  const [skipSummary, setSkipSummary] = useState<SkipReasonSummary | null>(null);
  const [countdown, setCountdown] = useState("");
  const [loading, setLoading] = useState(true);
  const [fetchError, setFetchError] = useState(false);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [cycleRunning, setCycleRunning] = useState(false);

  const fetchData = async () => {
    setLoading(true);
    setFetchError(false);
    try {
      const [gs, am, pos, tr, status, pf, learn, cal, gov, skip] = await Promise.all([
        fetch(`${API}/game-state`)
          .then(async (r) => (r.ok ? r.json() : null))
          .catch(() => null),
        fetch(`${API}/simmer/agents/me`).then((r) => r.json()).catch(() => null),
        fetch(`${API}/simmer/positions`).then((r) => r.json()).catch(() => null),
        fetch(`${API}/simmer/trades`).then((r) => r.json()).catch(() => null),
        fetch(`${API}/engine/status`).then((r) => r.json()).catch(() => null),
        fetch(`${API}/simmer/portfolio`).then((r) => r.json()).catch(() => null),
        fetch(`${API}/learning`).then((r) => r.json()).catch(() => null),
        fetch(`${API}/learning/calibration`).then(async (r) => (r.ok ? r.json() : null)).catch(() => null),
        fetch(`${API}/learning/governance`).then((r) => r.json()).catch(() => null),
        fetch(`${API}/learning/skip-reasons?lookback_hours=24&limit=600`).then((r) => r.json()).catch(() => null),
      ]);
      if (status) setEngineStatus(status);
      if (learn) setLearning(learn);
      setGovernance(gov && typeof gov === "object" ? (gov as GovernancePayload) : null);
      setSkipSummary(skip && typeof skip === "object" ? (skip as SkipReasonSummary) : null);
      setCalibration(cal && !cal.error ? cal : null);
      if (gs && typeof gs === "object") setGameState(gs as GameState);
      else if (!gs) setFetchError(true);
      if (am) setAgent(am);
      if (pf) setPortfolio(pf);
      if (pos?.positions) setPositions(pos.positions);
      else if (Array.isArray(pos)) setPositions(pos);
      if (Array.isArray(tr)) setTrades(tr);
      else if (tr?.trades) setTrades(tr.trades);
      setLastUpdated(new Date().toISOString());
    } catch {
      setGameState(null);
      setFetchError(true);
    } finally {
      setLoading(false);
    }
  };

  useWebSocket((raw: unknown) => {
    const data = (raw || {}) as { type?: string; payload?: { state?: GameState } };
    if (data.type === "state" && data.payload?.state) {
      setGameState(data.payload.state);
      fetch(`${API}/engine/status`).then((r) => r.json()).then((j) => setEngineStatus(j)).catch(() => null);
      fetch(`${API}/simmer/positions`).then((r) => r.json()).then((j) => setPositions(j?.positions || j || [])).catch(() => null);
    }
    if (data.type === "report" && data.payload) {
      fetch(`${API}/reports`).catch(() => null);
    }
  });

  useEffect(() => {
    fetchData();
  }, []);

  useEffect(() => {
    const tick = () => setCountdown(formatCountdown(engineStatus?.next_cycle_at));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [engineStatus?.next_cycle_at]);

  if (loading && !gameState) {
    return <div className="card">Loading...</div>;
  }

  const balance = agent?.balance ?? agent?.sim_balance ?? 0;
  // portfolio.sim_pnl = actual account gain (balance - starting). Matches Simmer dashboard.
  const totalPnl = Number(portfolio?.sim_pnl ?? 0);
  const activePositions = positions.filter((p) => isEffectivelyOpenPosition(p));
  const simmerWins = agent?.win_count ?? 0;
  const simmerLosses = agent?.loss_count ?? 0;
  const simmerWinRate = agent?.win_rate ?? 0;
  const wins = gameState?.wins ?? 0;
  const losses = gameState?.losses ?? 0;
  const winRate = wins + losses > 0 ? ((wins / (wins + losses)) * 100).toFixed(1) : "—";

  const strat = engineStatus?.strategy || {};

  return (
    <div style={{ display: "grid", gridTemplateColumns: "minmax(280px, 320px) 1fr", gap: "1.5rem", alignItems: "stretch" }}>
      {fetchError && !loading && gameState === null && (
        <div
          className="card"
          style={{
            gridColumn: "1 / -1",
            borderColor: "var(--red)",
            background: "rgba(220, 80, 80, 0.08)",
            fontSize: "0.9rem",
          }}
        >
          <strong>Can’t load game data.</strong> The UI is not broken — the <strong>Rookie Node backend</strong> is probably
          not running or the page isn’t using the Vite dev server (so <code>/api</code> doesn’t proxy to port 3001).
          <ul style={{ margin: "0.5rem 0 0 1rem" }}>
            <li>From repo root: start backend, then <code>cd frontend && npm run dev</code></li>
            <li>Open the URL Vite prints (e.g. <code>http://localhost:5173</code>)</li>
          </ul>
        </div>
      )}
      <div
        className="card"
        style={{
          display: "flex",
          flexDirection: "column",
          gap: "1rem",
          alignSelf: "stretch",
        }}
      >
        <h3 style={{ margin: "0 0 0.25rem 0", fontSize: "1rem" }}>Status</h3>
        <div>
          <div style={{ color: "var(--text-muted)", fontSize: "0.75rem" }}>Next cycle in</div>
          <div style={{ fontSize: "1.25rem", fontWeight: 600, fontVariantNumeric: "tabular-nums" }}>
            {countdown || "—"}
          </div>
        </div>
        <div>
          <div style={{ color: "var(--text-muted)", fontSize: "0.75rem" }}>Last API call</div>
          <div style={{ fontSize: "0.875rem" }}>
            {engineStatus?.last_simmer_call_at
              ? new Date(engineStatus.last_simmer_call_at).toLocaleTimeString()
              : "—"}
          </div>
        </div>
        <div>
          <div style={{ color: "var(--text-muted)", fontSize: "0.75rem" }}>Last action</div>
          <div style={{ fontSize: "0.875rem" }}>
            {engineStatus?.last_action || "—"}
            {engineStatus?.last_cycle_at && (
              <span style={{ color: "var(--text-muted)", fontSize: "0.75rem", marginLeft: "0.25rem" }}>
                @ {new Date(engineStatus.last_cycle_at).toLocaleTimeString()}
              </span>
            )}
          </div>
          {engineStatus?.last_reason && (
            <div style={{ color: "var(--text-muted)", fontSize: "0.75rem", marginTop: "0.2rem" }}>
              Reason: {engineStatus.last_reason}
            </div>
          )}
          {engineStatus?.last_decision?.scanned !== undefined && (
            <div style={{ color: "var(--text-muted)", fontSize: "0.75rem", marginTop: "0.2rem" }}>
              Scanned: {engineStatus.last_decision.scanned}
              {engineStatus.last_decision.fallback_mode ? " · fallback" : ""}
              {engineStatus.last_decision.cycle_source && (
                <> · {engineStatus.last_decision.cycle_source}</>
              )}
            </div>
          )}
          {engineStatus?.last_decision?.picked && (
            <div style={{ color: "var(--text-muted)", fontSize: "0.7rem", marginTop: "0.15rem" }}>
              Picked edge: {Number(engineStatus.last_decision.picked.expected_edge ?? 0).toFixed(3)} · passing:{" "}
              {engineStatus.last_decision.candidates_passing ?? "—"}
            </div>
          )}
        </div>
        {engineStatus?.last_decision?.skips && (
          <div>
            <div style={{ color: "var(--text-muted)", fontSize: "0.75rem", marginBottom: "0.25rem" }}>
              Skip reasons
            </div>
            <div style={{ fontSize: "0.75rem", lineHeight: 1.4 }}>
              {Object.entries(engineStatus.last_decision.skips)
                .slice(0, 4)
                .map(([k, v]) => (
                  <div key={k}>{k}: {v}</div>
                ))}
            </div>
          </div>
        )}
        <div>
          <div style={{ color: "var(--text-muted)", fontSize: "0.75rem", marginBottom: "0.25rem" }}>
            Learning
          </div>
          <div style={{ fontSize: "0.75rem", lineHeight: 1.4, marginBottom: "0.6rem" }}>
            <div>Score: {learning?.score ?? "—"}/100</div>
            <div>24h cycle trade rate: {learning?.cycle_trade_rate_24h !== undefined ? `${(learning.cycle_trade_rate_24h * 100).toFixed(0)}%` : "—"}</div>
            <div>Daily PnL: {learning?.daily_realized_pnl !== undefined ? `${learning.daily_realized_pnl >= 0 ? "+" : ""}${learning.daily_realized_pnl.toFixed(2)}` : "—"}</div>
            <div>Regime: {learning?.strategy_mode ?? "—"}</div>
            <div>Model eval: {learning?.last_model_eval_at ? new Date(learning.last_model_eval_at).toLocaleTimeString() : "—"}</div>
            <div>Model applied: {learning?.last_model_apply_at ? new Date(learning.last_model_apply_at).toLocaleTimeString() : "—"}</div>
            <div>Eval samples: {learning?.model_eval?.samples ?? 0}</div>
            {learning?.model_eval?.train_baseline && (
              <div style={{ color: "var(--text-muted)" }}>
                Train baseline score: {Number(learning.model_eval.train_baseline.score ?? 0).toFixed(3)} · n=
                {learning.model_eval.train_baseline.n ?? "—"}
              </div>
            )}
            {learning?.model_eval?.train_best_policy && (
              <div style={{ color: "var(--text-muted)" }}>
                Train best policy score: {Number(learning.model_eval.train_best_policy.score ?? 0).toFixed(3)} · n=
                {learning.model_eval.train_best_policy.n ?? "—"}
              </div>
            )}
            {learning?.baseline_vs_adaptive && (
              <div>
                Eval delta: {Number(learning.baseline_vs_adaptive.delta_score ?? 0).toFixed(3)}
                {" · "}
                conf {Math.round(Number(learning.baseline_vs_adaptive.adaptive_confidence ?? 0) * 100)}%
              </div>
            )}
            {learning?.model_eval?.best_policy && (
              <div style={{ color: "var(--text-muted)" }}>
                Best policy: edge {(Number(learning.model_eval.best_policy.min_expected_edge_pct) * 100).toFixed(1)}% · slip {(Number(learning.model_eval.best_policy.max_slippage_pct) * 100).toFixed(1)}%
              </div>
            )}
            {learning?.model_eval?.holdout_validation && (
              <div
                style={{
                  marginTop: "0.35rem",
                  padding: "0.35rem 0.45rem",
                  borderRadius: 4,
                  background: learning.model_eval.holdout_blocks_apply
                    ? "rgba(220, 80, 80, 0.12)"
                    : "rgba(80, 180, 120, 0.1)",
                  fontSize: "0.7rem",
                  lineHeight: 1.35,
                }}
              >
                <strong>Holdout</strong>:{" "}
                {learning.model_eval.holdout_blocks_apply
                  ? "blocked auto-apply"
                  : learning.model_eval.holdout_validation.skipped_reason
                    ? `skipped (${learning.model_eval.holdout_validation.skipped_reason})`
                    : "ok"}
                {learning.model_eval.holdout_validation.test_n ? (
                  <>
                    {" "}
                    · test n={learning.model_eval.holdout_validation.test_n}
                    {learning.model_eval.holdout_validation.delta_on_holdout != null && (
                      <> · Δ {Number(learning.model_eval.holdout_validation.delta_on_holdout).toFixed(3)}</>
                    )}
                  </>
                ) : null}
              </div>
            )}
          </div>
        </div>
        <div>
          <div style={{ color: "var(--text-muted)", fontSize: "0.75rem", marginBottom: "0.25rem" }}>
            Top skip reasons (24h)
          </div>
          <div style={{ fontSize: "0.7rem", lineHeight: 1.35 }}>
            {(skipSummary?.top || []).length === 0 ? (
              <span style={{ color: "var(--text-muted)" }}>No skip data yet.</span>
            ) : (
              (skipSummary?.top || []).slice(0, 5).map((row) => (
                <div key={row.reason}>
                  {row.reason}: {row.count}
                </div>
              ))
            )}
            {skipSummary?.cycles_considered != null && (
              <div style={{ color: "var(--text-muted)", marginTop: "0.2rem" }}>
                cycles: {skipSummary.cycles_considered}
              </div>
            )}
          </div>
        </div>
        <div>
          <div style={{ color: "var(--text-muted)", fontSize: "0.75rem", marginBottom: "0.25rem" }}>
            Config audit (auto-apply / saves)
          </div>
          <div style={{ fontSize: "0.68rem", lineHeight: 1.35, maxHeight: 140, overflow: "auto" }}>
            {(governance?.events || []).length === 0 ? (
              <span style={{ color: "var(--text-muted)" }}>{governance?.message || "No events yet."}</span>
            ) : (
              [...(governance?.events || [])]
                .slice(-8)
                .reverse()
                .map((ev, i) => (
                  <div
                    key={i}
                    style={{
                      marginBottom: 6,
                      paddingBottom: 6,
                      borderBottom: "1px solid var(--border)",
                    }}
                  >
                    <div>{String(ev.timestamp ?? "").slice(0, 19) || "—"}</div>
                    <div style={{ color: "var(--text-muted)" }}>{String(ev.type ?? "event")}</div>
                    {Array.isArray(ev.keys) && (ev.keys as string[]).length > 0 && (
                      <div style={{ color: "var(--text-muted)", fontSize: "0.62rem" }}>
                        keys: {(ev.keys as string[]).slice(0, 6).join(", ")}
                        {(ev.keys as string[]).length > 6 ? "…" : ""}
                      </div>
                    )}
                  </div>
                ))
            )}
          </div>
        </div>
        <div>
          <div style={{ color: "var(--text-muted)", fontSize: "0.75rem", marginBottom: "0.25rem" }}>
            Strategy
          </div>
          <div style={{ fontSize: "0.8rem", lineHeight: 1.5 }}>
            <div>Skill: {String(strat.skill ?? "built-in")}</div>
            <div>Min edge: {(Number(strat.min_edge_divergence) * 100 || 3).toFixed(1)}%</div>
            <div>Max pos: ${strat.max_position_usd ?? 20}</div>
            <div>Stop-loss: {(Number(strat.stop_loss_pct) * 100 || 20).toFixed(0)}%</div>
            <div>
              Take-profit:{" "}
              {strat.trailing_peak_return_enabled
                ? "off (trailing)"
                : `${(Number(strat.take_profit_pct) * 100 || 50).toFixed(0)}%`}
            </div>
            <div>Cooldown: {strat.cooldown_minutes ?? 30} min</div>
            <div>Kelly: {strat.use_kelly_sizing ? "on" : "off"}</div>
          </div>
        </div>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: "1rem", minWidth: 0 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <h2 style={{ margin: 0 }}>Dashboard</h2>
        <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
          <span style={{ fontSize: "0.875rem", color: "var(--text-muted)" }}>
            Last updated: {lastUpdated ? new Date(lastUpdated).toLocaleTimeString() : "—"}
          </span>
          <button onClick={fetchData}>Refresh</button>
          <button
            className="primary"
            disabled={cycleRunning}
            onClick={async () => {
              setCycleRunning(true);
              setActionMessage(null);
              try {
                const r = await fetch("/api/engine/cycle", { method: "POST" });
                const j = await r.json().catch(() => ({}));
                setActionMessage(
                  r.ok ? `Cycle ok (${j?.action || "none"})` : `Cycle failed (${j?.error || r.status})`
                );
                await fetchData();
              } finally {
                setCycleRunning(false);
              }
            }}
          >
            {cycleRunning ? "Running..." : "Run Cycle"}
          </button>
        </div>
      </div>
      {actionMessage && (
        <div className="card" style={{ padding: "0.5rem 0.75rem", fontSize: "0.85rem" }}>
          {actionMessage}
        </div>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: "1rem" }}>
        <div className="card">
          <div style={{ color: "var(--text-muted)", fontSize: "0.875rem" }}>Balance ($SIM)</div>
          <div style={{ fontSize: "1.5rem", fontWeight: 600 }}>{balance.toFixed(2)}</div>
        </div>
        <div className="card">
          <div style={{ color: "var(--text-muted)", fontSize: "0.875rem" }}>P&L (Simmer)</div>
          <div style={{ fontSize: "1.5rem", fontWeight: 600, color: totalPnl >= 0 ? "var(--green)" : "var(--red)" }}>
            {totalPnl >= 0 ? "+" : ""}{totalPnl.toFixed(2)}
          </div>
          <div style={{ fontSize: "0.75rem", color: "var(--text-muted)" }}>Source: portfolio (incl. open-position marks)</div>
        </div>
        <div className="card">
          <div style={{ color: "var(--text-muted)", fontSize: "0.875rem" }}>Win / Loss (Simmer)</div>
          <div style={{ fontSize: "1.5rem", fontWeight: 600 }}>{simmerWins} / {simmerLosses}</div>
          <div style={{ fontSize: "0.875rem", color: "var(--text-muted)" }}>{simmerWinRate}% win rate</div>
          <div style={{ fontSize: "0.7rem", color: "var(--text-muted)", marginTop: "0.25rem" }}>
            Rookie: {wins}W / {losses}L ({winRate}%)
          </div>
        </div>
        <div className="card">
          <div style={{ color: "var(--text-muted)", fontSize: "0.875rem" }}>Trades</div>
          <div style={{ fontSize: "1.5rem", fontWeight: 600 }}>{agent?.trades_count ?? gameState?.trades_count ?? 0}</div>
          <div style={{ fontSize: "0.7rem", color: "var(--text-muted)" }}>
            Rookie buys: {gameState?.trades_count ?? 0}
          </div>
        </div>
      </div>

      <div className="card" style={{ fontSize: "0.8rem", lineHeight: 1.45, color: "var(--text-muted)" }}>
        <strong style={{ color: "var(--text)" }}>Reading these numbers</strong>
        <ul style={{ margin: "0.35rem 0 0 1rem", padding: 0 }}>
          <li>
            <strong>P&amp;L (Simmer)</strong> uses the portfolio endpoint (balance vs start). It moves with <strong>unrealized</strong>{" "}
            marks on open positions, so a sharp dip after a peak is often inventory/prices, not a missing trade.
          </li>
          <li>
            <strong>Win / Loss (Simmer)</strong> comes from <code style={{ fontSize: "0.72rem" }}>agents/me</code>.{" "}
            <strong>Rookie W/L</strong> is the local ledger in <code style={{ fontSize: "0.72rem" }}>game_state.json</code> (resolved / monitor closes); counts differ from Simmer.
          </li>
          <li>
            If portfolio PnL and agent PnL diverge a lot, you may have multiple agents or manual trades on the account (see Telegram advisor &quot;PnL gap&quot; heuristic).
          </li>
          <li>
            Offline <strong>evaluate</strong>/<strong>calibrate</strong> do not place trades. Only <strong>auto-apply</strong> edits{" "}
            <code style={{ fontSize: "0.72rem" }}>strategy_config.json</code> — audit trail below.
          </li>
        </ul>
      </div>

      <div className="card">
        <h3 style={{ margin: "0 0 0.5rem 0" }}>Open Positions</h3>
        {activePositions.length === 0 ? (
          <p style={{ color: "var(--text-muted)", margin: 0 }}>No open positions</p>
        ) : (
          <ul style={{ margin: 0, paddingLeft: "1.25rem" }}>
            {activePositions.slice(0, 10).map((p, i) => (
              <li key={i}>
                {(p.question || "").slice(0, 60)}{(p.question || "").length > 60 ? "..." : ""} — P&L: {(p.pnl ?? 0).toFixed(2)}
                {" · "}
                <span style={{ color: "var(--text-muted)", fontSize: "0.875rem" }}>
                  Resolves: {formatResolutionTimer(p.resolves_at, p.time_to_resolution)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="card">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: "0.75rem" }}>
          <h3 style={{ margin: 0 }}>Calibration &amp; evaluator holdout</h3>
          <div style={{ display: "flex", gap: "0.35rem", flexWrap: "wrap" }}>
            <button
              type="button"
              disabled={calibrateRunning}
              onClick={async () => {
                setCalibrateRunning(true);
                try {
                  const r = await fetch(`${API}/learning/calibrate`, { method: "POST" });
                  const j = await r.json().catch(() => ({}));
                  if (j && !j.error) setCalibration(j);
                  await fetchData();
                } finally {
                  setCalibrateRunning(false);
                }
              }}
            >
              {calibrateRunning ? "Running…" : "Regenerate calibration"}
            </button>
            <button
              type="button"
              disabled={evaluateRunning}
              onClick={async () => {
                setEvaluateRunning(true);
                try {
                  await fetch(`${API}/learning/evaluate`, { method: "POST" });
                  await fetchData();
                } finally {
                  setEvaluateRunning(false);
                }
              }}
            >
              {evaluateRunning ? "Evaluating…" : "Run offline evaluator"}
            </button>
          </div>
        </div>
        <p style={{ fontSize: "0.75rem", color: "var(--text-muted)", margin: "0.35rem 0 0.75rem 0" }}>
          Read-only bins (expected edge &amp; |divergence| vs outcomes). Holdout status mirrors{" "}
          <code style={{ fontSize: "0.7rem" }}>model_eval_latest.json</code> after each evaluator run.
        </p>
        {!calibration?.paired_samples && (
          <p style={{ color: "var(--text-muted)", margin: "0 0 0.5rem 0", fontSize: "0.875rem" }}>
            No calibration file yet — click &quot;Regenerate calibration&quot; or run{" "}
            <code style={{ fontSize: "0.75rem" }}>python -m engine.src.main calibrate</code>.
          </p>
        )}
        {calibration?.generated_at && (
          <div style={{ fontSize: "0.7rem", color: "var(--text-muted)", marginBottom: "0.5rem" }}>
            Generated: {new Date(calibration.generated_at).toLocaleString()} · paired: {calibration.paired_samples}
          </div>
        )}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: "1rem" }}>
          <div>
            <div style={{ fontWeight: 600, fontSize: "0.8rem", marginBottom: "0.35rem" }}>By expected edge bin</div>
            <table style={{ width: "100%", fontSize: "0.75rem", borderCollapse: "collapse" }}>
              <thead>
                <tr style={{ textAlign: "left", color: "var(--text-muted)" }}>
                  <th style={{ padding: "0.2rem 0.35rem 0.2rem 0" }}>Bin</th>
                  <th>n</th>
                  <th>Win%</th>
                  <th>Avg ret</th>
                </tr>
              </thead>
              <tbody>
                {(calibration?.by_expected_edge_bin ?? []).map((b, i) => (
                  <tr key={i}>
                    <td style={{ padding: "0.15rem 0.35rem 0.15rem 0" }}>{b.bucket}</td>
                    <td>{b.n}</td>
                    <td>{b.n && b.n >= 5 ? `${((b.win_rate ?? 0) * 100).toFixed(0)}%` : "—"}</td>
                    <td>{b.n && b.n >= 3 ? `${((b.avg_return_pct ?? 0) * 100).toFixed(1)}%` : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div>
            <div style={{ fontWeight: 600, fontSize: "0.8rem", marginBottom: "0.35rem" }}>By |divergence| bin</div>
            <table style={{ width: "100%", fontSize: "0.75rem", borderCollapse: "collapse" }}>
              <thead>
                <tr style={{ textAlign: "left", color: "var(--text-muted)" }}>
                  <th style={{ padding: "0.2rem 0.35rem 0.2rem 0" }}>Bin</th>
                  <th>n</th>
                  <th>Win%</th>
                  <th>Avg ret</th>
                </tr>
              </thead>
              <tbody>
                {(calibration?.by_abs_divergence_bin ?? []).map((b, i) => (
                  <tr key={i}>
                    <td style={{ padding: "0.15rem 0.35rem 0.15rem 0" }}>{b.bucket}</td>
                    <td>{b.n}</td>
                    <td>{b.n && b.n >= 5 ? `${((b.win_rate ?? 0) * 100).toFixed(0)}%` : "—"}</td>
                    <td>{b.n && b.n >= 3 ? `${((b.avg_return_pct ?? 0) * 100).toFixed(1)}%` : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
        {learning?.model_eval?.holdout_validation && (
          <div style={{ marginTop: "0.75rem", fontSize: "0.8rem", lineHeight: 1.45 }}>
            <strong>Latest evaluator holdout</strong>
            <ul style={{ margin: "0.25rem 0 0 0", paddingLeft: "1.1rem" }}>
              <li>
                Train rows: {learning.model_eval.holdout_validation.train_n ?? "—"} · Test rows:{" "}
                {learning.model_eval.holdout_validation.test_n ?? "—"}
              </li>
              <li>
                Test policy score:{" "}
                {learning.model_eval.holdout_validation.test_best_score != null
                  ? Number(learning.model_eval.holdout_validation.test_best_score).toFixed(4)
                  : "—"}{" "}
                vs baseline:{" "}
                {learning.model_eval.holdout_validation.test_baseline_score != null
                  ? Number(learning.model_eval.holdout_validation.test_baseline_score).toFixed(4)
                  : "—"}
              </li>
              <li>
                Auto-apply blocked: {learning.model_eval.holdout_blocks_apply ? "yes (safer)" : "no"}
              </li>
            </ul>
          </div>
        )}
      </div>

      <div className="card">
        <h3 style={{ margin: "0 0 0.25rem 0" }}>Recent venue trades (Simmer API)</h3>
        <p style={{ fontSize: "0.75rem", color: "var(--text-muted)", margin: "0 0 0.5rem 0", lineHeight: 1.4 }}>
          Raw Simmer feed (all skills / BUY+SELL). Fees show only if the API includes them on each row.
        </p>
        {trades.length === 0 ? (
          <p style={{ color: "var(--text-muted)", margin: 0 }}>No trades yet</p>
        ) : (
          <ul style={{ margin: 0, paddingLeft: "1.25rem" }}>
            {(trades as {
              market_id?: string;
              side?: string;
              cost?: number;
              fee?: number;
              fee_amount?: number;
              action?: string;
              created_at?: string;
            }[])
              .slice(-10)
              .reverse()
              .map((t, i) => {
                const fee = t.fee ?? t.fee_amount;
                return (
                  <li key={i} style={{ fontSize: "0.85rem", marginBottom: 4 }}>
                    {t.action ? `${String(t.action)} ` : ""}
                    {t.side} — ${(t.cost ?? 0).toFixed(2)}
                    {fee != null && Number.isFinite(Number(fee)) ? ` · fee ${Number(fee).toFixed(4)}` : ""} —{" "}
                    {t.created_at ? new Date(t.created_at).toLocaleString() : ""}
                  </li>
                );
              })}
          </ul>
        )}
      </div>

      <LogPanel />
      </div>
    </div>
  );
}
