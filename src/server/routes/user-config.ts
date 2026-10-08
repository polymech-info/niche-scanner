import { Router } from "express";
import {
  readUserConfig,
  writeUserConfig,
  type UserConfig,
} from "../services/user-config.js";

export function createUserConfigRouter(targetDir: string): Router {
  const router = Router();

  router.get("/api/user-config", (_req, res) => {
    res.json(readUserConfig(targetDir));
  });

  router.put("/api/user-config", (req, res) => {
    try {
      const body = (req.body ?? {}) as Partial<UserConfig>;
      const saved = writeUserConfig(targetDir, {
        version: 1,
        ...body,
      });
      res.json(saved);
    } catch (err) {
      res.status(500).json({
        error: err instanceof Error ? err.message : "Failed to write config",
      });
    }
  });

  return router;
}
