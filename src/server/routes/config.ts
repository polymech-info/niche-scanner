import { Router } from "express";
import type { AppConfig } from "../types.js";

export function createConfigRouter(config: AppConfig): Router {
  const router = Router();

  router.get("/api/config", (_req, res) => {
    res.json(config);
  });

  return router;
}
