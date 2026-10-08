import { Router } from "express";
import {
  discoverOpportunity,
  promoteOpportunity,
} from "../../lib/opportunity-discovery.js";
import type {
  CreateOpportunityInput,
  PromoteOpportunityInput,
} from "../../shared/opportunities.js";
import { log } from "../../lib/log.js";
import {
  OpportunityStore,
  opportunityStore,
} from "../services/opportunity-store.js";

function fail(res: import("express").Response, err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  const status = /expired or not found/i.test(message)
    ? 404
    : /required|select at least|not part of this run/i.test(message)
      ? 400
      : 500;
  log.error({ err: message, status }, "opportunity api fail");
  res.status(status).json({ error: message });
}

export function createOpportunitiesRouter(
  store: OpportunityStore = opportunityStore
): Router {
  const router = Router();

  router.post("/api/opportunities", async (req, res) => {
    req.setTimeout(2 * 60 * 1000);
    try {
      const body = (req.body ?? {}) as Partial<CreateOpportunityInput>;
      const run = await discoverOpportunity({
        query: String(body.query ?? ""),
        locale: body.locale,
        serpBudget:
          typeof body.serpBudget === "number" ? body.serpBudget : undefined,
      });
      store.put(run);
      res.status(201).json(run);
    } catch (err) {
      fail(res, err);
    }
  });

  router.get("/api/opportunities/:id", (req, res) => {
    try {
      res.json(store.get(req.params.id));
    } catch (err) {
      fail(res, err);
    }
  });

  router.delete("/api/opportunities/:id", (req, res) => {
    store.delete(req.params.id);
    res.status(204).end();
  });

  router.post("/api/opportunities/:id/promote", async (req, res) => {
    try {
      const run = store.get(req.params.id);
      const body = (req.body ?? {}) as Partial<PromoteOpportunityInput>;
      const doc = await promoteOpportunity(run, {
        phrases: Array.isArray(body.phrases)
          ? body.phrases.map((phrase) => String(phrase))
          : [],
        name: typeof body.name === "string" ? body.name : undefined,
        targetSearchId:
          typeof body.targetSearchId === "string"
            ? body.targetSearchId
            : undefined,
      });
      run.status = "promoted";
      store.delete(run.id);
      res.status(201).json(doc);
    } catch (err) {
      fail(res, err);
    }
  });

  return router;
}
