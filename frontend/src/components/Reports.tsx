import { useEffect, useState } from "react";

const API = "/api";

interface Report {
  state?: { points?: number; wins?: number; losses?: number; trades_count?: number };
  report?: { points?: number; wins?: number; losses?: number; positions_count?: number };
  alive?: boolean;
}

export function Reports() {
  const [reports, setReports] = useState<Report[]>([]);
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
        Generated every 2 hours on the hour. Contains points, wins/losses, and trade summary.
      </p>
      {reports.length === 0 ? (
        <div className="card">No reports yet.</div>
      ) : (
        reports.map((r, i) => (
          <details key={i} className="card" style={{ cursor: "pointer" }}>
            <summary style={{ fontWeight: 600 }}>
              {r.report
                ? `Points: ${r.report.points ?? "—"} | W/L: ${r.report.wins ?? 0}/${r.report.losses ?? 0} | Trades: ${r.report.trades_count ?? 0}`
                : r.state
                ? `Points: ${r.state.points ?? "—"} | W/L: ${r.state.wins ?? 0}/${r.state.losses ?? 0}`
                : "Report"}
            </summary>
            <pre style={{ margin: "0.5rem 0 0 0", fontSize: "0.75rem", overflow: "auto" }}>
              {JSON.stringify(r, null, 2)}
            </pre>
          </details>
        ))
      )}
    </div>
  );
}
