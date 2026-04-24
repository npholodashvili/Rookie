import { useEffect, useState, useCallback, useMemo } from "react";
import { positionHasMaterialShares } from "../lib/positions";

const API = "/api";

interface AuditRow {
  market_id: string;
  local_trade_key?: string;
  question: string;
  side: string;
  shares: number | null;
  investment: number;
  created_at: string | null;
  outcome_local: string;
  pnl_local: number | null;
  return_pct_local: number | null;
  reason_local: string;
  outcome_simmer: string;
  pnl_simmer: number | null;
  cost_basis_simmer: number | null;
  return_pct_simmer: number | null;
  status_simmer: string;
  shares_yes: number;
  shares_no: number;
  resolves_at: string;
  simmer_trades_count: number;
  /** From Simmer position or closest matching BUY trade, if API exposes fees */
  fee_venue_sim?: number | null;
}

function pnlColor(v: number | null): string {
  if (v === null) return "var(--text-muted)";
  return v >= 0 ? "var(--green)" : "var(--red)";
}

function fmtPnl(v: number | null): string {
  if (v === null) return "—";
  return `${v >= 0 ? "+" : ""}${v.toFixed(2)}`;
}

function fmtPct(v: number | null): string {
  if (v === null) return "—";
  return `${v >= 0 ? "+" : ""}${(v * 100).toFixed(1)}%`;
}

function outcomeIcon(o: string): string {
  if (!o) return "—";
  const low = o.toLowerCase();
  if (low === "win" || low === "won") return "W";
  if (low === "loss" || low === "lost") return "L";
  if (low === "open" || low === "active") return "Open";
  if (low === "closed") return "Closed";
  if (low === "resolved") return "Resolved";
  if (low === "gone") return "Gone";
  if (low === "sold") return "Sold";
  return o.slice(0, 10);
}

function outcomeColor(o: string): string {
  const low = (o || "").toLowerCase();
  if (low === "win" || low === "won") return "var(--green)";
  if (low === "loss" || low === "lost") return "var(--red)";
  if (low === "gone" || low === "sold") return "var(--text-muted)";
  return "inherit";
}

function mismatch(local: string, simmer: string): boolean {
  if (!local || !simmer) return false;
  const l = local.toLowerCase();
  const s = simmer.toLowerCase();
  const winSet = new Set(["win", "won"]);
  const lossSet = new Set(["loss", "lost"]);
  if (winSet.has(l) && lossSet.has(s)) return true;
  if (lossSet.has(l) && winSet.has(s)) return true;
  return false;
}

function fmtCountdown(resolves_at: string): string {
  if (!resolves_at) return "—";
  try {
    const ms = new Date(resolves_at).getTime() - Date.now();
    if (ms <= 0) return "Resolved";
    const d = Math.floor(ms / 86400000);
    const h = Math.floor((ms % 86400000) / 3600000);
    const m = Math.floor((ms % 3600000) / 60000);
    if (d > 0) return `${d}d ${h}h`;
    if (h > 0) return `${h}h ${m}m`;
    return `${m}m`;
  } catch {
    return "—";
  }
}

function isOpen(r: AuditRow): boolean {
  const st = (r.status_simmer || "").toLowerCase();
  if (["gone", "sold", "resolved", "closed", "empty"].includes(st)) return false;
  if (!positionHasMaterialShares(r)) return false;
  return r.outcome_local === "open" || st === "active" || st === "open";
}

const PAGE_SIZE = 25;

function csvEscape(s: string): string {
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function auditToCsv(rows: AuditRow[]): string {
  const headers = [
    "market_id",
    "question",
    "side",
    "investment",
    "created_at",
    "outcome_local",
    "pnl_local",
    "outcome_simmer",
    "pnl_simmer",
    "status_simmer",
    "fee_venue_sim",
  ];
  const lines = [headers.join(",")];
  for (const r of rows) {
    lines.push(
      [
        csvEscape(r.market_id),
        csvEscape(r.question || ""),
        csvEscape(r.side),
        r.investment,
        csvEscape(r.created_at || ""),
        csvEscape(r.outcome_local),
        r.pnl_local ?? "",
        csvEscape(r.outcome_simmer),
        r.pnl_simmer ?? "",
        csvEscape(r.status_simmer || ""),
        r.fee_venue_sim ?? "",
      ].join(",")
    );
  }
  return lines.join("\n");
}

export function TradeHistory() {
  const [rows, setRows] = useState<AuditRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<"all" | "mismatch" | "open" | "gone">("all");
  const [search, setSearch] = useState("");
  const [sortBy, setSortBy] = useState<"date" | "pnl" | "status">("date");
  const [page, setPage] = useState(0);
  const [closing, setClosing] = useState<string | null>(null);
  const [, setTick] = useState(0);

  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 60000);
    return () => clearInterval(id);
  }, []);

  const fetchRows = useCallback(() => {
    setLoading(true);
    fetch(`${API}/trade-audit`)
      .then((r) => r.json())
      .then((d) => setRows(d.rows || []))
      .catch(() => setRows([]))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    fetchRows();
  }, []);

  useEffect(() => {
    setPage(0);
  }, [filter, rows.length]);

  const handleClose = async (r: AuditRow) => {
    const name = (r.question || "").slice(0, 50) || r.market_id.slice(0, 12);
    const shares = r.side === "yes" ? r.shares_yes : r.shares_no;
    if (!shares || shares < 0.01) {
      alert("No shares to sell for this position.");
      return;
    }
    const confirmed = window.confirm(
      `Close position?\n\nMarket: ${name}\nSide: ${r.side}\nShares: ${shares.toFixed(2)}\nCurrent PnL: ${fmtPnl(r.pnl_simmer)}\n\nThis will sell all shares at market price. Are you sure?`
    );
    if (!confirmed) return;

    setClosing(r.local_trade_key ?? r.market_id);
    try {
      const resp = await fetch(`${API}/simmer/close-position`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          market_id: r.market_id,
          side: r.side,
          shares,
          venue: "sim",
        }),
      });
      const data = await resp.json();
      if (resp.ok && data.success !== false) {
        alert(`Position closed successfully.`);
        fetchRows();
      } else {
        alert(`Failed to close: ${data.error || data.message || JSON.stringify(data)}`);
      }
    } catch (e) {
      alert(`Error: ${e}`);
    } finally {
      setClosing(null);
    }
  };

  const filtered = rows.filter((r) => {
    if (search.trim()) {
      const q = search.toLowerCase();
      const hay = `${r.question} ${r.market_id}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    if (filter === "mismatch") return mismatch(r.outcome_local, r.outcome_simmer);
    if (filter === "open") return isOpen(r);
    if (filter === "gone") return r.outcome_local === "gone" || r.status_simmer === "gone" || r.status_simmer === "sold";
    return true;
  });
  filtered.sort((a, b) => {
    if (sortBy === "pnl") return (b.pnl_simmer ?? -999999) - (a.pnl_simmer ?? -999999);
    if (sortBy === "status") return String(a.status_simmer).localeCompare(String(b.status_simmer));
    return (new Date(b.created_at || 0).getTime()) - (new Date(a.created_at || 0).getTime());
  });

  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const pageSafe = Math.min(page, pageCount - 1);
  const pageRows = useMemo(() => {
    const start = pageSafe * PAGE_SIZE;
    return filtered.slice(start, start + PAGE_SIZE);
  }, [filtered, pageSafe]);

  const downloadCsv = () => {
    const blob = new Blob([auditToCsv(filtered)], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `trade-audit-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const thStyle: React.CSSProperties = {
    textAlign: "left",
    padding: "0.5rem 0.4rem",
    fontSize: "0.7rem",
    fontWeight: 600,
    color: "var(--text-muted)",
    borderBottom: "2px solid var(--border)",
    whiteSpace: "nowrap",
    position: "sticky",
    top: 0,
    background: "var(--surface)",
    zIndex: 1,
  };
  const tdStyle: React.CSSProperties = {
    padding: "0.4rem",
    fontSize: "0.75rem",
    borderBottom: "1px solid var(--border)",
    whiteSpace: "nowrap",
    verticalAlign: "top",
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "0.5rem" }}>
        <h2 style={{ margin: 0 }}>Trade History</h2>
        <div style={{ display: "flex", gap: "0.5rem", alignItems: "center", flexWrap: "wrap" }}>
          <span style={{ fontSize: "0.8rem", color: "var(--text-muted)" }}>
            {filtered.length} / {rows.length} trades
          </span>
          <select
            value={filter}
            onChange={(e) => setFilter(e.target.value as typeof filter)}
            style={{ fontSize: "0.8rem" }}
          >
            <option value="all">All</option>
            <option value="open">Open positions</option>
            <option value="mismatch">Mismatches only</option>
            <option value="gone">Gone / untracked</option>
          </select>
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search market/question"
            style={{ fontSize: "0.8rem" }}
          />
          <select value={sortBy} onChange={(e) => setSortBy(e.target.value as typeof sortBy)} style={{ fontSize: "0.8rem" }}>
            <option value="date">Newest</option>
            <option value="pnl">PnL</option>
            <option value="status">Status</option>
          </select>
          <button type="button" onClick={downloadCsv} disabled={filtered.length === 0}>
            Export CSV
          </button>
          <button onClick={fetchRows}>Refresh</button>
        </div>
      </div>

      <div
        className="card"
        style={{ fontSize: "0.78rem", lineHeight: 1.45, color: "var(--text-muted)", marginTop: "-0.5rem" }}
      >
        <strong style={{ color: "var(--text)" }}>Why this differs from Simmer Observability</strong>
        <ul style={{ margin: "0.35rem 0 0 1rem", padding: 0 }}>
          <li>
            One row per <strong>local buy</strong> in Rookie&apos;s <code style={{ fontSize: "0.7rem" }}>trade_history.json</code>, joined to Simmer positions/trades. Simmer&apos;s log lists every BUY/SELL (e.g. risk-monitor), so row counts won&apos;t match.
          </li>
          <li>
            <strong>P&amp;L (Simmer)</strong> is portfolio-style; large swings are often mark-to-market on open positions, not a missing trade.
          </li>
          <li>
            <strong>Fee (venue)</strong> shows only if Simmer returns a fee field on the position or the closest matching venue BUY; otherwise &quot;—&quot;. Game-layer −1 pt / 2h is on the Reports tab, not $SIM.
          </li>
        </ul>
      </div>

      {loading ? (
        <div className="card">Loading...</div>
      ) : filtered.length === 0 ? (
        <div className="card" style={{ color: "var(--text-muted)" }}>No trades to display.</div>
      ) : (
        <div className="card" style={{ overflow: "auto", maxHeight: "calc(100vh - 180px)", padding: 0 }}>
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              padding: "0.5rem 0.75rem",
              borderBottom: "1px solid var(--border)",
              fontSize: "0.8rem",
              gap: "0.5rem",
              flexWrap: "wrap",
            }}
          >
            <span style={{ color: "var(--text-muted)" }}>
              Page {pageSafe + 1} of {pageCount} ({PAGE_SIZE} per page)
            </span>
            <div style={{ display: "flex", gap: "0.35rem" }}>
              <button type="button" disabled={pageSafe <= 0} onClick={() => setPage((p) => Math.max(0, p - 1))}>
                Prev
              </button>
              <button
                type="button"
                disabled={pageSafe >= pageCount - 1}
                onClick={() => setPage((p) => Math.min(pageCount - 1, p + 1))}
              >
                Next
              </button>
            </div>
          </div>
          <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 1380 }}>
            <thead>
              <tr>
                <th style={thStyle}>Market</th>
                <th style={thStyle}>Side</th>
                <th style={thStyle}>Invested</th>
                <th
                  style={thStyle}
                  title="If Simmer exposes fee on position or matching venue BUY"
                >
                  Fee (venue)
                </th>
                <th style={{ ...thStyle, borderLeft: "2px solid var(--border)" }}>Outcome (Local)</th>
                <th style={thStyle}>PnL (Local)</th>
                <th style={thStyle}>Return (Local)</th>
                <th style={thStyle}>Reason (Local)</th>
                <th style={{ ...thStyle, borderLeft: "2px solid var(--border)" }}>Outcome (Simmer)</th>
                <th style={thStyle}>PnL (Simmer)</th>
                <th style={thStyle}>Return (Simmer)</th>
                <th style={thStyle}>Status (Simmer)</th>
                <th style={thStyle}>Resolves</th>
                <th style={thStyle}>Date</th>
                <th style={thStyle}></th>
              </tr>
            </thead>
            <tbody>
              {pageRows.map((r) => {
                const hasMismatch = mismatch(r.outcome_local, r.outcome_simmer);
                const rowBg = hasMismatch ? "rgba(255,60,60,0.08)" : "transparent";
                const open = isOpen(r);
                const rowKey = r.local_trade_key ?? `${r.market_id}:${r.side}:${r.created_at ?? ""}`;
                const isClosing = closing === (r.local_trade_key ?? r.market_id);
                return (
                  <tr key={rowKey} style={{ background: rowBg }}>
                    <td style={{ ...tdStyle, maxWidth: 220, overflow: "hidden", textOverflow: "ellipsis" }} title={r.question || r.market_id}>
                      {(r.question || "").slice(0, 40) || r.market_id.slice(0, 12)}
                      {(r.question || "").length > 40 ? "..." : ""}
                    </td>
                    <td style={tdStyle}>{r.side}</td>
                    <td style={tdStyle}>${r.investment.toFixed(2)}</td>
                    <td style={{ ...tdStyle, fontSize: "0.7rem", color: "var(--text-muted)" }} title="Passthrough from Simmer API when present">
                      {r.fee_venue_sim != null && Number.isFinite(Number(r.fee_venue_sim))
                        ? Number(r.fee_venue_sim).toFixed(4)
                        : "—"}
                    </td>

                    <td style={{ ...tdStyle, borderLeft: "2px solid var(--border)", fontWeight: 600, color: outcomeColor(r.outcome_local) }}>
                      {outcomeIcon(r.outcome_local)}
                    </td>
                    <td style={{ ...tdStyle, color: pnlColor(r.pnl_local) }}>{fmtPnl(r.pnl_local)}</td>
                    <td style={{ ...tdStyle, color: pnlColor(r.return_pct_local) }}>{fmtPct(r.return_pct_local)}</td>
                    <td style={{ ...tdStyle, fontSize: "0.7rem", maxWidth: 140, overflow: "hidden", textOverflow: "ellipsis" }} title={r.reason_local}>
                      {r.reason_local || "—"}
                    </td>

                    <td style={{ ...tdStyle, borderLeft: "2px solid var(--border)", fontWeight: 600, color: outcomeColor(r.outcome_simmer) }}>
                      {outcomeIcon(r.outcome_simmer)}
                    </td>
                    <td style={{ ...tdStyle, color: pnlColor(r.pnl_simmer) }}>{fmtPnl(r.pnl_simmer)}</td>
                    <td style={{ ...tdStyle, color: pnlColor(r.return_pct_simmer) }}>{fmtPct(r.return_pct_simmer)}</td>
                    <td style={{ ...tdStyle, fontSize: "0.7rem" }}>{r.status_simmer || "—"}</td>
                    <td style={{ ...tdStyle, fontSize: "0.7rem", color: r.resolves_at && (new Date(r.resolves_at).getTime() - Date.now()) < 4 * 3600000 && (new Date(r.resolves_at).getTime() - Date.now()) > 0 ? "var(--red)" : "var(--text-muted)" }}>
                      {fmtCountdown(r.resolves_at)}
                    </td>

                    <td style={{ ...tdStyle, fontSize: "0.7rem", color: "var(--text-muted)" }}>
                      {r.created_at ? new Date(r.created_at).toLocaleString() : "—"}
                    </td>
                    <td style={tdStyle}>
                      {open && (
                        <button
                          onClick={() => handleClose(r)}
                          disabled={isClosing}
                          style={{
                            fontSize: "0.7rem",
                            padding: "0.2rem 0.5rem",
                            background: "var(--red)",
                            color: "#fff",
                            border: "none",
                            borderRadius: 4,
                            cursor: isClosing ? "wait" : "pointer",
                            opacity: isClosing ? 0.6 : 1,
                          }}
                        >
                          {isClosing ? "Closing..." : "Close"}
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <div style={{ fontSize: "0.75rem", color: "var(--text-muted)" }}>
        Red highlight = outcome mismatch between local and Simmer. &quot;Open&quot; = Simmer status active/open{" "}
        <strong>and</strong> at least 0.01 shares on yes or no (zero-share &quot;active&quot; rows are hidden).
        Close sells at market after confirmation.
      </div>
    </div>
  );
}
