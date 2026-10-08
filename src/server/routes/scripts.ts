import { Router } from "express";
import { processManager } from "../services/process-manager.js";
import {
  removeScript,
  updateScript,
} from "../services/package-scripts.js";
import type { PackageStore } from "../services/package-store.js";
import type { AppConfig } from "../types.js";

export function createScriptsRouter(
  store: PackageStore,
  config: AppConfig
): Router {
  const router = Router();

  router.post("/api/scripts/run", (req, res) => {
    const { packageName, scriptName } = req.body as {
      packageName: string;
      scriptName: string;
    };

    const pkg = store.find(packageName);
    if (!pkg) {
      res.status(404).json({ error: `Package "${packageName}" not found` });
      return;
    }

    if (!pkg.scripts[scriptName]) {
      res.status(404).json({
        error: `Script "${scriptName}" not found in ${packageName}`,
      });
      return;
    }

    const managed = processManager.run(packageName, pkg.path, scriptName);
    res.json(managed);
  });

  router.post("/api/scripts/stop", (req, res) => {
    const { id } = req.body as { id: string };

    const stopped = processManager.stop(id);
    if (!stopped) {
      res.status(404).json({ error: `Process "${id}" not found or not running` });
      return;
    }

    res.json({ ok: true });
  });

  router.get("/api/scripts/status", (_req, res) => {
    res.json(processManager.getAllStatuses());
  });

  router.post("/api/scripts/remove", async (req, res) => {
    const { packageName, scriptName } = req.body as {
      packageName: string;
      scriptName: string;
    };

    const pkg = store.find(packageName);
    if (!pkg) {
      res.status(404).json({ error: `Package "${packageName}" not found` });
      return;
    }

    try {
      removeScript(pkg.path, scriptName);
      const packages = await store.refresh();
      res.json({ ok: true, packages });
    } catch (err) {
      res.status(400).json({
        error: err instanceof Error ? err.message : "Failed to remove script",
      });
    }
  });

  router.post("/api/scripts/update", async (req, res) => {
    const { packageName, scriptName, name, command } = req.body as {
      packageName: string;
      scriptName: string;
      name?: string;
      command?: string;
    };

    const pkg = store.find(packageName);
    if (!pkg) {
      res.status(404).json({ error: `Package "${packageName}" not found` });
      return;
    }

    try {
      updateScript(pkg.path, scriptName, { name, command });
      const packages = await store.refresh();
      res.json({ ok: true, packages });
    } catch (err) {
      res.status(400).json({
        error: err instanceof Error ? err.message : "Failed to update script",
      });
    }
  });

  router.post("/api/install", (_req, res) => {
    const command = `${config.packageManager} install`;
    const managed = processManager.runRaw(
      "__runny:install",
      config.rootPath,
      command
    );
    res.json(managed);
  });

  return router;
}
