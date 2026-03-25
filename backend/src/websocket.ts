import { WebSocketServer } from "ws";

const clients = new Set<WebSocket>();

export function initWebSocket(server: import("http").Server, _projectRoot: string) {
  const wss = new WebSocketServer({ server, path: "/ws" });

  wss.on("connection", (ws) => {
    clients.add(ws);
    ws.on("close", () => clients.delete(ws));
  });
}

export function getClientCount(): number {
  return clients.size;
}

export function broadcast(data: object): void {
  const msg = JSON.stringify(data);
  for (const client of clients) {
    if (client.readyState === 1) client.send(msg);
  }
}
