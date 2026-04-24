import { useEffect, useState } from "react";

const API = "/api/health";

export type HealthStatus = "green" | "yellow" | "red" | "unconfigured";

export interface HealthState {
  backend?: { status: HealthStatus; latency_ms?: number; last_check: string };
  simmer?: { status: HealthStatus; latency_ms?: number; last_check: string };
  engine?: { status: HealthStatus; latency_ms?: number; last_check: string };
}

export type HealthPhase = "loading" | "ok" | "offline";

export function useHealth(intervalMs = 30000) {
  const [health, setHealth] = useState<HealthState | null>(null);
  const [phase, setPhase] = useState<HealthPhase>("loading");

  const fetchHealth = async () => {
    try {
      const r = await fetch(API);
      if (!r.ok) throw new Error(String(r.status));
      const data = (await r.json()) as HealthState;
      setHealth(data);
      setPhase("ok");
    } catch {
      setHealth(null);
      setPhase("offline");
    }
  };

  useEffect(() => {
    fetchHealth();
    const id = setInterval(fetchHealth, intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);

  return { health, phase, refresh: fetchHealth };
}
