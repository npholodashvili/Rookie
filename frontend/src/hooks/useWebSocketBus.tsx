import { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";

const WS_URL = (() => {
  const base = import.meta.env.DEV
    ? "ws://127.0.0.1:3001"
    : `${window.location.protocol === "https:" ? "wss:" : "ws:"}//${window.location.host}`;
  return `${base}/ws`;
})();

type Handler = (data: unknown) => void;
type WsBusApi = { connected: boolean; subscribe: (handler: Handler) => () => void };
const WsBusContext = createContext<WsBusApi | null>(null);

export function WebSocketBusProvider({ children }: { children: React.ReactNode }) {
  const [connected, setConnected] = useState(false);
  const handlers = useRef(new Set<Handler>());
  useEffect(() => {
    const ws = new WebSocket(WS_URL);
    ws.onopen = () => setConnected(true);
    ws.onclose = () => setConnected(false);
    ws.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data);
        for (const h of handlers.current) h(data);
      } catch {}
    };
    return () => ws.close();
  }, []);
  const value = useMemo<WsBusApi>(
    () => ({
      connected,
      subscribe: (handler: Handler) => {
        handlers.current.add(handler);
        return () => handlers.current.delete(handler);
      },
    }),
    [connected]
  );
  return <WsBusContext.Provider value={value}>{children}</WsBusContext.Provider>;
}

export function useWebSocket(onMessage?: (data: unknown) => void) {
  const bus = useContext(WsBusContext);
  useEffect(() => {
    if (!bus || !onMessage) return;
    return bus.subscribe(onMessage);
  }, [bus, onMessage]);
  return bus?.connected ?? false;
}

