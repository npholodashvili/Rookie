import cors from "cors";
import dotenv from "dotenv";
import express from "express";
import fs from "fs/promises";
import { createServer } from "http";
import path from "path";
import { fileURLToPath } from "url";

import { registerRoutes } from "./routes/index.js";
import { initScheduler } from "./scheduler.js";
import { initWebSocket } from "./websocket.js";
import { addLog } from "./logs.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "../..");
// Repo root .env (user often keeps secrets there); backend/.env can override when present
dotenv.config({ path: path.join(PROJECT_ROOT, ".env") });
dotenv.config({ path: path.join(PROJECT_ROOT, "backend", ".env") });

try {
  const content = await fs.readFile(path.join(PROJECT_ROOT, "data", ".env.local"), "utf-8");
  for (const line of content.split("\n")) {
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (m) {
      const val = m[2].replace(/^["']|["']$/g, "").trim();
      if (val) process.env[m[1]] = val;
    }
  }
} catch {
  /* data/.env.local optional */
}

const app = express();
const server = createServer(app);

app.use(cors());
app.use(express.json());

// Health (simple)
app.get("/health", (_req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

registerRoutes(app, PROJECT_ROOT);
initWebSocket(server, PROJECT_ROOT);
initScheduler(PROJECT_ROOT);

const PORT = parseInt(process.env.PORT || "3001", 10);
server.listen(PORT, () => {
  console.log(`Rookie backend listening on http://localhost:${PORT}`);
  addLog("info", `Backend started on port ${PORT}`);
});
