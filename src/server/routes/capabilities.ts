import { Router } from "express";
import {
  capabilitySnapshotPath,
  loadCapabilityOverlay,
  loadRawCapabilitySnapshot,
} from "../../lib/capabilities.js";
import { refreshCapabilities } from "../../lib/capability-refresh.js";
import {
  removeCapabilityOverride,
  removeCustomCapability,
  setCapabilityAvailability,
  setCapabilityEnabled,
  setWorkflowEnabled,
  upsertCapabilityOverride,
  upsertCustomCapability,
} from "../../lib/app-config.js";
import {
  applyCapabilityOverlay,
  type CapabilityOverlay,
} from "../../shared/capability-overlay.js";
import { harvestProductJobs } from "../../shared/product-plan.js";
import type { ProductCapabilitySnapshot } from "../../shared/capabilities.js";
import type { ProductJob } from "../../shared/product-plan.js";
import { log } from "../../lib/log.js";
import { createExclusive } from "../../lib/exclusive.js";

export interface CapabilityGrounding {
  path: string;
  generatedAt: string;
  product: string;
  overlay: CapabilityOverlay;
  counts: {
    capabilities: number;
    workflows: number;
    commands: number;
    blocks: number;
    surfaces: number;
    documentation: number;
    jobs: number;
    enabled: number;
    disabled: number;
    custom: number;
    customCommands: number;
  };
  capabilities: ProductCapabilitySnapshot["capabilities"];
  workflows: ProductCapabilitySnapshot["workflows"];
  jobs: ProductJob[];
}

async function managedGrounding(): Promise<CapabilityGrounding> {
  const [raw, overlay] = await Promise.all([
    loadRawCapabilitySnapshot(),
    loadCapabilityOverlay(),
  ]);
  const applied = applyCapabilityOverlay(raw, overlay);
  const byKind = (
    kind: ProductCapabilitySnapshot["capabilities"][number]["kind"]
  ) => applied.capabilities.filter((row) => row.kind === kind).length;
  const enabledCaps = applied.capabilities.filter((row) => row.available !== false);
  const disabledWorkflows = new Set(overlay.disabledWorkflows);
  const jobs = harvestProductJobs({
    ...applied,
    capabilities: enabledCaps,
    workflows: applied.workflows.filter((flow) => !disabledWorkflows.has(flow.id)),
  });
  return {
    path: capabilitySnapshotPath(),
    generatedAt: applied.generatedAt,
    product: applied.product,
    overlay,
    counts: {
      capabilities: applied.capabilities.length,
      workflows: applied.workflows.length,
      commands: byKind("command"),
      blocks: byKind("block"),
      surfaces: byKind("surface"),
      documentation: byKind("documentation"),
      jobs: jobs.length,
      enabled: enabledCaps.length,
      disabled:
        applied.capabilities.filter((row) => row.available === false).length +
        overlay.disabledWorkflows.length,
      custom: overlay.custom.length,
      customCommands: applied.capabilities.filter((row) =>
        row.id.startsWith("command:custom.")
      ).length,
    },
    capabilities: applied.capabilities,
    workflows: applied.workflows,
    jobs,
  };
}

function fail(res: import("express").Response, err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  const missing = /snapshot missing|ENOENT/i.test(message);
  const bad =
    /empty|needs a label|Not a custom|No custom capability|Override needs/i.test(
      message
    );
  const status = missing ? 404 : bad ? 400 : 500;
  log.error({ err: message, status }, "capabilities api fail");
  res.status(status).json({ error: message });
}

const exclusive = createExclusive(
  "A capability capture or compile is already running"
);

export function createCapabilitiesRouter(): Router {
  const router = Router();

  router.get("/api/capabilities", async (_req, res) => {
    try {
      res.json(await managedGrounding());
    } catch (err) {
      fail(res, err);
    }
  });

  router.post("/api/capabilities/refresh", async (req, res) => {
    req.setTimeout(10 * 60 * 1000);
    try {
      const stageRaw = String(req.body?.stage ?? "refresh");
      const stage =
        stageRaw === "capture" || stageRaw === "compile" ? stageRaw : "refresh";
      const result = await exclusive(() => refreshCapabilities(stage));
      res.json({
        stage,
        captured: result.captured
          ? { outDir: result.captured.outDir, files: result.captured.files }
          : null,
        compiled: result.compiled
          ? { outputPath: result.compiled.outputPath }
          : null,
        grounding: await managedGrounding(),
      });
    } catch (err) {
      fail(res, err);
    }
  });

  router.post("/api/capabilities/custom", async (req, res) => {
    try {
      await upsertCustomCapability(req.body);
      res.status(201).json(await managedGrounding());
    } catch (err) {
      fail(res, err);
    }
  });

  router.patch("/api/capabilities/custom/:id", async (req, res) => {
    try {
      await upsertCustomCapability({ ...req.body, id: req.params.id });
      res.json(await managedGrounding());
    } catch (err) {
      fail(res, err);
    }
  });

  router.delete("/api/capabilities/custom/:id", async (req, res) => {
    try {
      await removeCustomCapability(req.params.id);
      res.json(await managedGrounding());
    } catch (err) {
      fail(res, err);
    }
  });

  router.patch("/api/capabilities", async (req, res) => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const ids = Array.isArray(body.ids)
        ? body.ids.map((item) => String(item))
        : typeof body.id === "string"
          ? [body.id]
          : [];
      const workflows = Array.isArray(body.workflows)
        ? body.workflows.map((item) => String(item))
        : typeof body.workflowId === "string"
          ? [body.workflowId]
          : [];
      await setCapabilityAvailability({
        enabled: body.enabled !== false,
        capabilityIds: ids,
        workflowIds: workflows,
      });
      res.json(await managedGrounding());
    } catch (err) {
      fail(res, err);
    }
  });

  router.patch("/api/capabilities/workflows/:id", async (req, res) => {
    try {
      await setWorkflowEnabled(req.params.id, req.body?.enabled !== false);
      res.json(await managedGrounding());
    } catch (err) {
      fail(res, err);
    }
  });

  router.patch("/api/capabilities/:id/override", async (req, res) => {
    try {
      await upsertCapabilityOverride(req.params.id, req.body);
      res.json(await managedGrounding());
    } catch (err) {
      fail(res, err);
    }
  });

  router.delete("/api/capabilities/:id/override", async (req, res) => {
    try {
      await removeCapabilityOverride(req.params.id);
      res.json(await managedGrounding());
    } catch (err) {
      fail(res, err);
    }
  });

  router.patch("/api/capabilities/:id", async (req, res) => {
    try {
      await setCapabilityEnabled(req.params.id, req.body?.enabled !== false);
      res.json(await managedGrounding());
    } catch (err) {
      fail(res, err);
    }
  });

  return router;
}
