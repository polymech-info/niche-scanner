import { Router } from "express";
import {
  clearProductPlan,
  defaultProductPlanDir,
  readProductPlan,
  removeProductPlanJobs,
  renderProductPlanFromDir,
  runProductPlan,
} from "../../lib/product-plan.js";
import { parseEnricherSpecs } from "../../lib/enrichers/pipeline.js";
import type { ProductPlanInput } from "../../lib/product-plan.js";
import { log } from "../../lib/log.js";
import { createExclusive } from "../../lib/exclusive.js";
import { productPlanRunState } from "../../lib/product-plan-run.js";

function fail(res: import("express").Response, err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  const bad = /No product jobs|already running/i.test(message);
  log.error({ err: message, status: bad ? 400 : 500 }, "product-plan api fail");
  res.status(bad ? 400 : 500).json({ error: message });
}

const exclusive = createExclusive("A product plan run is already in progress");

function asJobIds(raw: unknown): string[] | undefined {
  const parts = Array.isArray(raw)
    ? raw.map((item) => String(item))
    : String(raw ?? "")
        .split(",")
        .map((item) => item.trim());
  const ids = parts.map((item) => item.trim()).filter(Boolean);
  return ids.length ? ids : undefined;
}

function parseInput(body: Record<string, unknown>): ProductPlanInput {
  const force = Boolean(body.force);
  const serp = Number(body.serpCallsPerJob ?? body.serpBudget ?? 2);
  return {
    outDir:
      typeof body.outDir === "string" && body.outDir.trim()
        ? body.outDir.trim()
        : defaultProductPlanDir(),
    jobIds: asJobIds(body.jobIds ?? body.jobs),
    maxJobs:
      typeof body.maxJobs === "number" && Number.isFinite(body.maxJobs)
        ? body.maxJobs
        : undefined,
    serpCallsPerJob: serp === 4 ? 4 : 2,
    expand: Boolean(body.expand),
    decide: Boolean(body.decide),
    qualify: Boolean(body.qualify),
    enrich: Boolean(body.enrich),
    enrichers:
      typeof body.enrichers === "string" || Array.isArray(body.enrichers)
        ? parseEnricherSpecs(body.enrichers as string | string[])
        : parseEnricherSpecs("meta"),
    useCache: body.useCache !== false && body.noCache !== true,
    forceDiscover: force || Boolean(body.forceDiscover),
    forceExpand: force || Boolean(body.forceExpand),
    forceDecide: force || Boolean(body.forceDecide),
    forceQualify: force || Boolean(body.forceQualify),
    forceEnrich: force || Boolean(body.forceEnrich),
  };
}

export function createProductPlanRouter(): Router {
  const router = Router();

  router.get("/api/product-plan", async (_req, res) => {
    try {
      const saved = await readProductPlan();
      const run = productPlanRunState();
      res.json({
        plan: saved?.plan ?? null,
        markdown: saved?.markdown ?? "",
        outDir: saved?.outDir ?? (run.outDir || defaultProductPlanDir()),
        run: {
          ...run,
          outDir: run.outDir || saved?.outDir || defaultProductPlanDir(),
        },
      });
    } catch (err) {
      fail(res, err);
    }
  });

  router.post("/api/product-plan", async (req, res) => {
    req.setTimeout(30 * 60 * 1000);
    try {
      const input = parseInput((req.body ?? {}) as Record<string, unknown>);
      const plan = await exclusive(() => runProductPlan(input));
      const markdown = await readProductPlan(input.outDir).then(
        (saved) => saved?.markdown ?? ""
      );
      res.json({
        plan,
        markdown,
        outDir: input.outDir,
        run: productPlanRunState(),
      });
    } catch (err) {
      fail(res, err);
    }
  });

  router.delete("/api/product-plan", async (req, res) => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const jobIds = asJobIds(req.query.jobs ?? body.jobIds ?? body.jobs);
      const outDir = defaultProductPlanDir();
      const saved = await exclusive(async () => {
        if (jobIds?.length) return removeProductPlanJobs(jobIds, outDir);
        await clearProductPlan(outDir);
        return null;
      });
      res.json({
        plan: saved?.plan ?? null,
        markdown: saved?.markdown ?? "",
        outDir: saved?.outDir ?? outDir,
        run: productPlanRunState(),
      });
    } catch (err) {
      fail(res, err);
    }
  });

  router.post("/api/product-plan/render", async (_req, res) => {
    try {
      const outDir = defaultProductPlanDir();
      await renderProductPlanFromDir(outDir);
      const saved = await readProductPlan(outDir);
      if (!saved) throw new Error("No product-plan.json to render");
      res.json({ ...saved, run: productPlanRunState() });
    } catch (err) {
      fail(res, err);
    }
  });

  return router;
}
