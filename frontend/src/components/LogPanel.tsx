import { useEffect, useRef, useState } from "react";
import { useWebSocket } from "../hooks/useWebSocket";

const API = "/api";

interface LogEntry {
  id: string;
  timestamp: string;
  level: "info" | "warn" | "error" | "success";
  message: string;
  meta?: Record<string, unknown>;
}

const levelColors: Record<string, string> = {
  info: "var(--text-muted)",
  warn: "var(--yellow)",
  error: "var(--red)",
  success: "var(--green)",
};

export function LogPanel() {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [expanded, setExpanded] = useState(true);
  const containerRef = useRef<HTMLDivElement>(null);

  const fetchLogs = async () => {
    try {
      const r = await fetch(`${API}/logs?limit=50`);
      const data = await r.json();
      setLogs(Array.isArray(data) ? data : []);
    } catch {
      setLogs([]);
    }
  };

  useWebSocket((raw: unknown) => {
    const data = (raw || {}) as { type?: string; payload?: LogEntry };
    if (data.type === "log" && data.payload) {
      setLogs((prev) => [data.payload!, ...prev].slice(0, 100));
      containerRef.current?.scrollTo({ top: 0, behavior: "smooth" });
    }
  });

  useEffect(() => {
    fetchLogs();
    const interval = setInterval(fetchLogs, 10000);
    return () => clearInterval(interval);
  }, []);


  return (
    <div className="card" style={{ marginTop: "1rem" }}>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          cursor: "pointer",
          userSelect: "none",
        }}
        onClick={() => setExpanded(!expanded)}
      >
        <h3 style={{ margin: 0 }}>Activity Log</h3>
        <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
          <button
            onClick={(e) => {
              e.stopPropagation();
              fetchLogs();
            }}
            style={{ padding: "0.25rem 0.5rem", fontSize: "0.75rem" }}
          >
            Refresh
          </button>
          <span style={{ fontSize: "0.875rem", color: "var(--text-muted)" }}>
            {expanded ? "▼" : "▶"} {logs.length} entries
          </span>
        </div>
      </div>
      {expanded && (
        <div
          ref={containerRef}
          style={{
            marginTop: "0.5rem",
            height: 220,
            overflowY: "auto",
            overflowX: "hidden",
            fontFamily: "ui-monospace, monospace",
            fontSize: "0.8rem",
            background: "var(--bg)",
            borderRadius: 6,
            padding: "0.5rem",
            border: "1px solid var(--border)",
          }}
        >
          {logs.length === 0 ? (
            <div style={{ color: "var(--text-muted)" }}>No logs yet. Run a cycle or wait for report.</div>
          ) : (
            logs.map((log) => (
              <div
                key={log.id}
                style={{
                  padding: "0.2rem 0",
                  borderBottom: "1px solid var(--border)",
                  color: levelColors[log.level] ?? "var(--text)",
                }}
              >
                <span style={{ color: "var(--text-muted)", marginRight: "0.5rem" }}>
                  {new Date(log.timestamp).toLocaleTimeString()}
                </span>
                <span style={{ fontWeight: log.level === "error" ? 600 : 400 }}>{log.message}</span>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}
