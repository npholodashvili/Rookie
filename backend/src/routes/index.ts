import type { Express } from "express";
import path from "path";

import { agentRoutes } from "./agents.js";
import { auditRoutes } from "./audit.js";
import { dataRoutes } from "./data.js";
import { engineRoutes } from "./engine.js";
import { healthRoutes } from "./health.js";
import { logRoutes } from "./logs.js";
import { simmerRoutes } from "./simmer.js";

export function registerRoutes(app: Express, projectRoot: string) {
  const dataDir = path.join(projectRoot, "data");

  app.use("/api/health", healthRoutes(projectRoot));
  app.use("/api/agents", agentRoutes());
  app.use("/api/simmer", simmerRoutes());
  app.use("/api/engine", engineRoutes(projectRoot));
  app.use("/api/audit", auditRoutes(dataDir));
  app.use("/api/logs", logRoutes());
  app.use("/api", dataRoutes(dataDir));
}
