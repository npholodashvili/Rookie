import { useState } from "react";
import { StatusBar } from "./components/StatusBar";
import { Dashboard } from "./components/Dashboard";
import { Settings } from "./components/Settings";
import { Reports } from "./components/Reports";
import { TradeHistory } from "./components/TradeHistory";
import { HourlyAnalysis } from "./components/HourlyAnalysis";
import { WebSocketBusProvider } from "./hooks/useWebSocketBus";

type Tab = "dashboard" | "trades" | "hourly" | "settings" | "reports";

export default function App() {
  const [tab, setTab] = useState<Tab>("dashboard");

  return (
    <WebSocketBusProvider>
      <div style={{ minHeight: "100vh", display: "flex", flexDirection: "column" }}>
        <StatusBar />
        <nav
        style={{
          display: "flex",
          gap: "0.5rem",
          padding: "0.75rem 1rem",
          borderBottom: "1px solid var(--border)",
          background: "var(--surface)",
        }}
      >
        {(["dashboard", "trades", "hourly", "settings", "reports"] as Tab[]).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={tab === t ? "primary" : ""}
            style={{ textTransform: "capitalize" }}
          >
            {t === "trades" ? "Trade History" : t === "hourly" ? "Hourly Analysis" : t}
          </button>
        ))}
        </nav>
        <main style={{ flex: 1, padding: "1rem", maxWidth: tab === "trades" || tab === "hourly" ? "100%" : 1200, margin: "0 auto", width: "100%" }}>
          {tab === "dashboard" && <Dashboard />}
          {tab === "trades" && <TradeHistory />}
          {tab === "hourly" && <HourlyAnalysis />}
          {tab === "settings" && <Settings />}
          {tab === "reports" && <Reports />}
        </main>
      </div>
    </WebSocketBusProvider>
  );
}
