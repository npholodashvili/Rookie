import { useEffect, useState } from "react";
import { useHealth } from "../hooks/useHealth";
import { useWebSocket } from "../hooks/useWebSocket";

const statusColors: Record<string, string> = {
  green: "var(--green)",
  yellow: "var(--yellow)",
  red: "var(--red)",
  unconfigured: "var(--grey)",
};

export function StatusBar() {
  const { health, phase, refresh } = useHealth(30000);
  const [paused, setPaused] = useState(false);

  useEffect(() => {
    fetch("/api/engine/paused").then(r => r.json()).then(d => setPaused(!!d.paused)).catch(() => {});
  }, []);

  useWebSocket((raw: unknown) => {
    const data = raw as { type?: string; payload?: { paused?: boolean } };
    if (data?.type === "paused") setPaused(!!data.payload?.paused);
  });

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: "1rem",
        padding: "0.5rem 1rem",
        background: "var(--surface)",
        borderBottom: "1px solid var(--border)",
        fontSize: "0.875rem",
      }}
    >
      <span style={{ color: "var(--text-muted)" }}>Status:</span>
      {phase === "loading" && <span style={{ color: "var(--text-muted)" }}>Checking…</span>}
      {phase === "offline" && (
        <span style={{ color: "var(--red)" }} title="Rookie backend must be running for /api proxy">
          API unreachable — start backend (port 3001) and use{" "}
          <code style={{ fontSize: "0.8em" }}>npm run dev</code> in <code style={{ fontSize: "0.8em" }}>frontend</code>{" "}
          (not file://)
        </span>
      )}
      {phase === "ok" && health ? (
        <>
          {paused && (
            <span style={{
              background: "rgba(220,160,40,0.15)",
              color: "#e5a040",
              border: "1px solid rgba(220,160,40,0.4)",
              borderRadius: 4,
              fontSize: "0.72rem",
              padding: "0.1rem 0.45rem",
              fontWeight: 700,
              letterSpacing: "0.02em",
            }}>
              ⏸ PAUSED
            </span>
          )}
          {(["backend", "simmer", "openclaw", "engine"] as const).map((key) => {
            const s = health[key];
            if (!s) return null;
            const color = statusColors[s.status] || "var(--grey)";
            return (
              <span
                key={key}
                title={`${key}: ${s.status}${s.latency_ms != null ? ` (${s.latency_ms}ms)` : ""}`}
                style={{ display: "flex", alignItems: "center", gap: "0.25rem" }}
              >
                <span
                  style={{
                    width: 8,
                    height: 8,
                    borderRadius: "50%",
                    background: color,
                  }}
                />
                {key}
              </span>
            );
          })}
          <button onClick={refresh} style={{ marginLeft: "auto", padding: "0.25rem 0.5rem", fontSize: "0.75rem" }}>
            Refresh
          </button>
        </>
      ) : null}
      {phase === "offline" && (
        <button onClick={refresh} style={{ marginLeft: "auto", padding: "0.25rem 0.5rem", fontSize: "0.75rem" }}>
          Retry
        </button>
      )}
    </div>
  );
}
