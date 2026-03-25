import { useEffect, useState } from "react";

const API = "/api";

interface GraveyardRecord {
  agent_id?: string;
  died_at?: string;
  final_points?: number;
  lifecycle?: { trades?: number; wins?: number; losses?: number; duration_hours?: number };
  reason?: string;
  improvements?: string;
}

export function Graveyard() {
  const [records, setRecords] = useState<GraveyardRecord[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch(`${API}/graveyard`)
      .then((r) => r.json())
      .then(setRecords)
      .catch(() => setRecords([]))
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <div className="card">Loading...</div>;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
      <h2 style={{ margin: 0 }}>Graveyard</h2>
      <p style={{ color: "var(--text-muted)", margin: 0 }}>
        Agents that reached 0 points. Lifecycle info and improvement notes for the next agent.
      </p>
      {records.length === 0 ? (
        <div className="card">No dead agents yet.</div>
      ) : (
        records
          .slice()
          .reverse()
          .map((r, i) => (
            <div key={i} className="card" style={{ borderColor: "var(--red)" }}>
              <div style={{ fontWeight: 600, marginBottom: "0.5rem" }}>
                Died {r.died_at ? new Date(r.died_at).toLocaleString() : "—"} — {r.reason ?? "Unknown"}
              </div>
              {r.lifecycle && (
                <div style={{ fontSize: "0.875rem", color: "var(--text-muted)", marginBottom: "0.5rem" }}>
                  Trades: {r.lifecycle.trades ?? 0} | Wins: {r.lifecycle.wins ?? 0} | Losses: {r.lifecycle.losses ?? 0} |
                  Duration: {(r.lifecycle.duration_hours ?? 0).toFixed(1)}h
                </div>
              )}
              {r.improvements && (
                <div style={{ marginTop: "0.5rem", paddingTop: "0.5rem", borderTop: "1px solid var(--border)" }}>
                  <strong>Improvements:</strong> {r.improvements}
                </div>
              )}
            </div>
          ))
      )}
    </div>
  );
}
