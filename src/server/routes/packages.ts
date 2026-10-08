import { Router } from "express";
import type { PackageStore } from "../services/package-store.js";

export function createPackagesRouter(store: PackageStore): Router {
  const router = Router();

  router.get("/api/packages", (_req, res) => {
    res.json(store.packages);
  });

  return router;
}
