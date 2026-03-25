import { useEffect, useMemo, useState } from "react";

const API = "/api";

type Bucket = {
  hour: number;
  wins: number;
  losses: number;
  n: number;
  avg_return_pct: number;
};

type Payload = {
  timezone?: string;
  paired_samples?: number;
  features?: number;
  labels?: number;
  summary?: {
    total?: number;
    wins?: number;
    losses?: number;
    win_rate?: number;
    top_hours?: Array<{ hour: number; n: number; win_rate: number }>;
  };
  overall?: Bucket[];
  by_market_type?: Record<string, Bucket[]>;
};

function hourLabel(hour: number): string {
  const next = (hour + 1) % 24;
  return `${String(hour).padStart(2, "0")}:00-${String(next).padStart(2, "0")}:00`;
}

function Chart({ title, buckets, minSamples }: { title: string; buckets: Bucket[]; minSamples: number }) {
  const maxN = Math.max(1, ...buckets.map((b) => b.n));
  return (
    <div className="card" style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
      <h3 style={{ margin: 0 }}>{title}</h3>
      <div style={{ fontSize: "0.75rem", color: "var(--text-muted)" }}>
        Decision-time buckets. Outcome is attached to entry hour.
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: "0.25rem" }}>
        {buckets.map((b) => {
          const winRate = b.n > 0 ? b.wins / b.n : 0;
          const reliable = b.n >= minSamples;
          return (
            <div key={b.hour} style={{ display: "grid", gridTemplateColumns: "110px 1fr 140px", gap: "0.5rem", alignItems: "center" }}>
              <div style={{ fontSize: "0.75rem", color: "var(--text-muted)" }}>{hourLabel(b.hour)}</div>
              <div style={{ height: 14, background: "var(--surface-alt)", borderRadius: 8, overflow: "hidden", position: "relative" }}>
                <div
                  style={{
                    height: "100%",
                    width: `${winRate * 100}%`,
                    background: reliable ? "var(--green)" : "var(--text-muted)",
                    opacity: reliable ? 0.9 : 0.45,
                  }}
                />
                <div
                  style={{
                    position: "absolute",
                    right: 0,
                    top: 0,
                    width: `${Math.max(4, (b.n / maxN) * 20)}%`,
                    height: "100%",
                    background: "rgba(255,255,255,0.08)",
                  }}
                  title={`sample weight: ${b.n}/${maxN}`}
                />
              </div>
              <div style={{ fontSize: "0.75rem", textAlign: "right" }}>
                <span style={{ color: reliable ? "inherit" : "var(--text-muted)" }}>
                  {(winRate * 100).toFixed(0)}%
                </span>
                <span style={{ color: "var(--text-muted)" }}> · n={b.n}</span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function HourlyAnalysis() {
  const [data, setData] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(true);
  const [minSamples, setMinSamples] = useState(3);

  const load = () => {
    setLoading(true);
    fetch(`${API}/hourly-outcomes`)
      .then((r) => r.json())
      .then((d) => setData(d))
      .catch(() => setData(null))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    load();
  }, []);

  const categories = useMemo(
    () => Object.entries(data?.by_market_type || {}).sort((a, b) => b[1].reduce((s, x) => s + x.n, 0) - a[1].reduce((s, x) => s + x.n, 0)),
    [data]
  );

  if (loading) return <div className="card">Loading...</div>;
  if (!data) return <div className="card">No analysis data yet.</div>;

  const summary = data.summary || {};
  const overall = data.overall || [];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <h2 style={{ margin: 0 }}>Hourly Outcome Analysis</h2>
        <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
          <label style={{ fontSize: "0.8rem", color: "var(--text-muted)" }}>
            Min samples:
            <input
              type="number"
              min={1}
              value={minSamples}
              onChange={(e) => setMinSamples(Math.max(1, parseInt(e.target.value || "1", 10)))}
              style={{ width: 60, marginLeft: 6 }}
            />
          </label>
          <button onClick={load}>Refresh</button>
        </div>
      </div>

      <div className="card" style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(150px, 1fr))", gap: "0.75rem" }}>
        <div>
          <div style={{ color: "var(--text-muted)", fontSize: "0.75rem" }}>Paired outcomes</div>
          <div style={{ fontSize: "1.2rem", fontWeight: 600 }}>{data.paired_samples ?? 0}</div>
        </div>
        <div>
          <div style={{ color: "var(--text-muted)", fontSize: "0.75rem" }}>Overall win rate</div>
          <div style={{ fontSize: "1.2rem", fontWeight: 600 }}>{((summary.win_rate || 0) * 100).toFixed(1)}%</div>
        </div>
        <div>
          <div style={{ color: "var(--text-muted)", fontSize: "0.75rem" }}>Features / Labels</div>
          <div style={{ fontSize: "1.2rem", fontWeight: 600 }}>{data.features ?? 0} / {data.labels ?? 0}</div>
        </div>
        <div>
          <div style={{ color: "var(--text-muted)", fontSize: "0.75rem" }}>Timezone</div>
          <div style={{ fontSize: "1.0rem", fontWeight: 600 }}>{data.timezone || "local"}</div>
        </div>
      </div>

      <div className="card" style={{ fontSize: "0.8rem", color: "var(--text-muted)" }}>
        Top entry windows: {(summary.top_hours || []).map((h) => `${hourLabel(h.hour)} ${(h.win_rate * 100).toFixed(0)}% (n=${h.n})`).join(" · ") || "—"}
      </div>

      <Chart title="Overall By Entry Hour" buckets={overall} minSamples={minSamples} />

      {categories.length === 0 ? (
        <div className="card" style={{ color: "var(--text-muted)" }}>
          No market-type classification data yet.
        </div>
      ) : (
        categories.map(([name, buckets]) => (
          <Chart key={name} title={`By Market Type: ${name}`} buckets={buckets} minSamples={minSamples} />
        ))
      )}
    </div>
  );
}

