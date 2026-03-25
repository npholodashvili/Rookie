import { useEffect, useRef, useState } from "react";

const WS_URL = (() => {
  const base = import.meta.env.DEV ? "ws://127.0.0.1:3001" : `${window.location.protocol === "https:" ? "wss:" : "ws:"}//${window.location.host}`;
  return `${base}/ws`;
})();

export function useWebSocket(onMessage?: (data: unknown) => void) {
  const [connected, setConnected] = useState(false);
  const onMessageRef = useRef(onMessage);
  onMessageRef.current = onMessage;

  useEffect(() => {
    const ws = new WebSocket(WS_URL);
    ws.onopen = () => setConnected(true);
    ws.onclose = () => setConnected(false);
    ws.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data);
        onMessageRef.current?.(data);
      } catch {}
    };
    return () => ws.close();
  }, []);

  return connected;
}
