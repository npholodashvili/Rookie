import { broadcast } from "./websocket.js";

export type LogLevel = "info" | "warn" | "error" | "success";

export interface LogEntry {
  id: string;
  timestamp: string;
  level: LogLevel;
  message: string;
  meta?: Record<string, unknown>;
}

const MAX_LOGS = 500;
const buffer: LogEntry[] = [];
let idCounter = 0;

function nextId(): string {
  return `log-${Date.now()}-${++idCounter}`;
}

export function addLog(level: LogLevel, message: string, meta?: Record<string, unknown>) {
  const entry: LogEntry = {
    id: nextId(),
    timestamp: new Date().toISOString(),
    level,
    message,
    meta,
  };
  buffer.push(entry);
  if (buffer.length > MAX_LOGS) buffer.shift();
  broadcast({ type: "log", payload: entry });
}

export function getLogs(limit = 100): LogEntry[] {
  return buffer.slice(-limit).reverse();
}
