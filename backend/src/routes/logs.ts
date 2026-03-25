import type { Request, Response } from "express";
import express from "express";
import { getLogs } from "../logs.js";

export function logRoutes() {
  const router = express.Router();

  router.get("/", (req: Request, res: Response) => {
    const limit = Math.min(parseInt(String(req.query.limit || "100"), 10) || 100, 500);
    res.json(getLogs(limit));
  });

  return router;
}
