import { Router } from "express";
import {
  addBlacklistWord,
  loadAppConfig,
  removeBlacklistWord,
  saveAppConfig,
  updateBlacklistWord,
} from "../../lib/app-config.js";
import { parseSettings } from "../../shared/config.js";
import { log } from "../../lib/log.js";

function fail(res: import("express").Response, err: unknown, fallback = 500) {
  const message = err instanceof Error ? err.message : String(err);
  const bad =
    /empty/i.test(message) ||
    /Already blacklisted/i.test(message) ||
    /Not on the blacklist/i.test(message);
  log.error({ err: message, status: bad ? 400 : fallback }, "settings fail");
  res.status(bad ? 400 : fallback).json({ error: message });
}

export function createSettingsRouter(): Router {
  const router = Router();

  router.get("/api/settings", async (_req, res) => {
    try {
      res.json(await loadAppConfig());
    } catch (err) {
      fail(res, err);
    }
  });

  router.put("/api/settings", async (req, res) => {
    try {
      res.json(await saveAppConfig(parseSettings(req.body)));
    } catch (err) {
      fail(res, err, 400);
    }
  });

  router.post("/api/settings/blacklist", async (req, res) => {
    try {
      res.status(201).json(await addBlacklistWord(String(req.body?.word ?? "")));
    } catch (err) {
      fail(res, err, 400);
    }
  });

  router.patch("/api/settings/blacklist", async (req, res) => {
    try {
      res.json(
        await updateBlacklistWord(
          String(req.body?.from ?? ""),
          String(req.body?.to ?? "")
        )
      );
    } catch (err) {
      fail(res, err, 400);
    }
  });

  router.delete("/api/settings/blacklist", async (req, res) => {
    try {
      const word = String(req.body?.word ?? req.query.word ?? "");
      res.json(await removeBlacklistWord(word));
    } catch (err) {
      fail(res, err, 400);
    }
  });

  return router;
}
