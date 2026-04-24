import { useEffect, useState } from "react";

const API = "/api";

interface ReportPayload {
  _report_filename?: string;
  alive?: boolean;
  state?: {
    wins?: number;
    losses?: number;
    trades_count?: number;
    last_report_at?: string | null;
  };
  report?: {
    wins?: number;
    losses?: number;
    trades_count?: number;
    positions_count?: number;
    fees_recent_sum?: number;
    fees_recent_trade_count?: number;
    briefing?: unknown;
    trades_sample?: Array<Record<string, unknown>>;
    simmer_agent?: Record<string, unknown>;
  };
}

function fmtBriefing(b: unknown): string {
  if (b == null) return "";
  if (typeof b === "string") return b;
  try {
    return JSON.stringify(b, null, 2);
  } catch {
    return String(b);
  }
}

export function Reports() {
  const [reports, setReports] = useState<ReportPayload[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch(`${API}/reports`)
      .then((r) => r.json())
      .then(setReports)
      .catch(() => setReports([]))
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <div className="card">Loading...</div>;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
      <h2 style={{ margin: 0 }}>Reports</h2>
      <p style={{ color: "var(--text-muted)", margin: 0 }}>
        Periodic Simmer snapshot: positions, trade sample, aggregated fees from recent trades (when Simmer exposes fee
        fields), and Rookie ledger counters.
      </p>
      {reports.length === 0 ? (
        <div className="card">No reports yet.</div>
      ) : (
        reports.map((r, i) => {
          const key = r._report_filename ?? `report-${i}`;
          const rep = r.report;
          const st = r.state;
          const w = rep?.wins ?? st?.wins ?? 0;
          const l = rep?.losses ?? st?.losses ?? 0;
          const tc = rep?.trades_count ?? st?.trades_count;
          const pos = rep?.positions_count;
          const fees = rep?.fees_recent_sum;
          const feeN = rep?.fees_recent_trade_count;
          const briefingText = fmtBriefing(rep?.briefing);
          const samples = rep?.trades_sample ?? [];

          return (
            <details key={key} className="card" style={{ cursor: "pointer" }}>
              <summary style={{ fontWeight: 600 }}>
                {r._report_filename ? `${r._report_filename.replace(/^report-/, "").replace(/\.json$/, "")} · ` : ""}
                W/L: {w}/{l}
                {tc != null ? ` · Rookie trades: ${tc}` : ""}
                {pos != null ? ` · Open pos: ${pos}` : ""}
                {fees != null ? ` · Fees Σ (recent): ${fees.toFixed(4)}` : ""}
              </summary>
              <div style={{ marginTop: "0.75rem", display: "flex", flexDirection: "column", gap: "0.75rem" }}>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: "0.5rem" }}>
                  <div style={{ padding: "0.5rem", background: "var(--surface-alt)", borderRadius: 6 }}>
                    <div style={{ fontSize: "0.7rem", color: "var(--text-muted)" }}>W / L (ledger)</div>
                    <div style={{ fontWeight: 600 }}>
                      {w} / {l}
                    </div>
                  </div>
                  <div style={{ padding: "0.5rem", background: "var(--surface-alt)", borderRadius: 6 }}>
                    <div style={{ fontSize: "0.7rem", color: "var(--text-muted)" }}>Rookie trade count</div>
                    <div style={{ fontWeight: 600 }}>{tc ?? "—"}</div>
                  </div>
                  <div style={{ padding: "0.5rem", background: "var(--surface-alt)", borderRadius: 6 }}>
                    <div style={{ fontSize: "0.7rem", color: "var(--text-muted)" }}>Open positions</div>
                    <div style={{ fontWeight: 600 }}>{pos ?? "—"}</div>
                  </div>
                  <div style={{ padding: "0.5rem", background: "var(--surface-alt)", borderRadius: 6 }}>
                    <div style={{ fontSize: "0.7rem", color: "var(--text-muted)" }}>Fees (recent window)</div>
                    <div style={{ fontWeight: 600 }}>{fees != null ? fees.toFixed(6) : "—"}</div>
                    <div style={{ fontSize: "0.65rem", color: "var(--text-muted)" }}>
                      trades scanned: {feeN ?? "—"}
                    </div>
                  </div>
                </div>

                {briefingText ? (
                  <div>
                    <div style={{ fontWeight: 600, fontSize: "0.8rem", marginBottom: 6 }}>Briefing</div>
                    <pre
                      style={{
                        margin: 0,
                        fontSize: "0.72rem",
                        overflow: "auto",
                        maxHeight: 200,
                        padding: "0.5rem",
                        background: "var(--surface-alt)",
                        borderRadius: 6,
                        whiteSpace: "pre-wrap",
                      }}
                    >
                      {briefingText}
                    </pre>
                  </div>
                ) : null}

                {samples.length > 0 ? (
                  <div>
                    <div style={{ fontWeight: 600, fontSize: "0.8rem", marginBottom: 6 }}>
                      Recent Simmer trades (sample, up to 10)
                    </div>
                    <div style={{ overflow: "auto", maxHeight: 220 }}>
                      <table style={{ width: "100%", fontSize: "0.7rem", borderCollapse: "collapse" }}>
                        <thead>
                          <tr style={{ textAlign: "left", color: "var(--text-muted)" }}>
                            <th style={{ padding: "0.25rem" }}>Action</th>
                            <th style={{ padding: "0.25rem" }}>Side</th>
                            <th style={{ padding: "0.25rem" }}>Cost</th>
                            <th style={{ padding: "0.25rem" }}>Fee</th>
                            <th style={{ padding: "0.25rem" }}>When</th>
                          </tr>
                        </thead>
                        <tbody>
                          {samples.map((t, j) => (
                            <tr key={j} style={{ borderTop: "1px solid var(--border)" }}>
                              <td style={{ padding: "0.25rem" }}>{String(t.action ?? "—")}</td>
                              <td style={{ padding: "0.25rem" }}>{String(t.side ?? "—")}</td>
                              <td style={{ padding: "0.25rem" }}>{t.cost != null ? String(t.cost) : "—"}</td>
                              <td style={{ padding: "0.25rem" }}>
                                {t.fee != null
                                  ? String(t.fee)
                                  : t.fee_amount != null
                                    ? String(t.fee_amount)
                                    : "—"}
                              </td>
                              <td style={{ padding: "0.25rem", color: "var(--text-muted)" }}>
                                {t.created_at ? String(t.created_at).slice(0, 19) : "—"}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                ) : null}

                <details>
                  <summary style={{ fontSize: "0.75rem", color: "var(--text-muted)", cursor: "pointer" }}>
                    Raw JSON
                  </summary>
                  <pre style={{ margin: "0.5rem 0 0 0", fontSize: "0.7rem", overflow: "auto" }}>
                    {JSON.stringify(r, null, 2)}
                  </pre>
                </details>
              </div>
            </details>
          );
        })
      )}
    </div>
  );
}
