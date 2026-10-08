import { Router } from "express";
import fs from "node:fs/promises";
import path from "node:path";
import type { DiscoverOptions, Locale } from "../../shared/phrases.js";
import { parseEngines } from "../../shared/phrases.js";
import {
  addManualPhrase,
  removePhrase,
  createSearch,
  deleteSearch,
  expandSearch,
  getSearch,
  listSearches,
  qualifySearch,
  openNeighbor,
} from "../../lib/run.js";
import { enrichSearch } from "../../lib/enrich.js";
import { discoverMore } from "../../lib/discover-more.js";
import { parseEnricherSpecs } from "../../lib/enrichers/pipeline.js";
import { generateResults } from "../../lib/generate.js";
import { parseGenerateOptions } from "../../shared/brief.js";
import { loadEnv, resolvedResultsDir, resolvedSearchesDir } from "../../lib/env.js";
import { log, resolvedLogDir } from "../../lib/log.js";

loadEnv();

function asLocale(body: Partial<Locale> | undefined): Partial<Locale> {
  if (!body) return {};
  return {
    gl: body.gl,
    hl: body.hl,
    googleDomain: body.googleDomain,
  };
}

function asSeeds(raw: unknown): string[] {
  const parts = Array.isArray(raw)
    ? raw.map((item) => String(item))
    : String(raw ?? "").split(/\r?\n/);
  return parts.map((s) => s.trim()).filter(Boolean);
}

function asOptions(body: Partial<DiscoverOptions> & { engines?: unknown }): Partial<DiscoverOptions> {
  const options: Partial<DiscoverOptions> = {};
  if (body.engines != null) {
    options.engines = parseEngines(
      Array.isArray(body.engines) ? (body.engines as string[]) : String(body.engines)
    );
  }
  if (typeof body.paaDepth === "number") options.paaDepth = body.paaDepth;
  if (typeof body.alphabet === "boolean") options.alphabet = body.alphabet;
  if (typeof body.questionPrefixes === "boolean") {
    options.questionPrefixes = body.questionPrefixes;
  }
  return options;
}

function fail(res: import("express").Response, err: unknown, fallback = 500) {
  const message = err instanceof Error ? err.message : String(err);
  const notFound =
    /Invalid search id/i.test(message) ||
    (/ENOENT/i.test(message) && /data[\\/]+searches/i.test(message));
  log.error({ err: message, status: notFound ? 404 : fallback }, "api fail");
  res.status(notFound ? 404 : fallback).json({ error: message });
}

export function createSearchesRouter(): Router {
  const router = Router();

  router.get("/api/config", async (_req, res) => {
    try {
      const searches = await listSearches();
      res.json({
        name: "phrases",
        dataDir: resolvedSearchesDir(),
        resultsDir: resolvedResultsDir(),
        logDir: resolvedLogDir(),
        locale: {
          gl: process.env.PHRASES_GL || "us",
          hl: process.env.PHRASES_HL || "en",
          googleDomain: process.env.PHRASES_DOMAIN || "google.com",
        },
        hasSerpapiKey: Boolean(process.env.SERPAPI_KEY?.trim()),
        serpapiKey: process.env.SERPAPI_KEY?.trim() || undefined,
        searchCount: searches.length,
      });
    } catch (err) {
      fail(res, err);
    }
  });

  router.get("/api/searches", async (_req, res) => {
    try {
      res.json(await listSearches());
    } catch (err) {
      fail(res, err);
    }
  });

  router.get("/api/searches/:id", async (req, res) => {
    try {
      res.json(await getSearch(req.params.id));
    } catch (err) {
      fail(res, err);
    }
  });

  router.get("/api/searches/:id/report", async (req, res) => {
    try {
      await getSearch(req.params.id);
      const report = path.join(resolvedResultsDir(), req.params.id, "report.md");
      try {
        const markdown = await fs.readFile(report, "utf8");
        res.json({ exists: true, report, markdown });
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
          res.json({ exists: false, report });
          return;
        }
        throw err;
      }
    } catch (err) {
      fail(res, err);
    }
  });

  router.post("/api/searches", async (req, res) => {
    req.setTimeout(10 * 60 * 1000);
    try {
      const body = req.body ?? {};
      const seeds = asSeeds(body.seeds ?? body.query);
      const doc = await createSearch({
        seeds,
        name: body.name,
        locale: asLocale(body.locale),
        options: asOptions(body.options ?? body),
        parentId: typeof body.parentId === "string" ? body.parentId : undefined,
      });
      res.status(201).json(doc);
    } catch (err) {
      fail(res, err, 400);
    }
  });

  router.post("/api/searches/:id/expand", async (req, res) => {
    req.setTimeout(10 * 60 * 1000);
    try {
      const body = req.body ?? {};
      const seeds = asSeeds(body.seeds ?? body.query);
      const doc = await expandSearch({
        id: req.params.id,
        seeds,
        options: asOptions(body.options ?? body),
      });
      res.json(doc);
    } catch (err) {
      fail(res, err);
    }
  });

  router.post("/api/searches/:id/qualify", async (req, res) => {
    req.setTimeout(10 * 60 * 1000);
    try {
      const body = req.body ?? {};
      const doc = await qualifySearch({
        id: req.params.id,
        limit: typeof body.limit === "number" ? body.limit : 6,
        questionsOnly: Boolean(body.questionsOnly),
      });
      res.json(doc);
    } catch (err) {
      fail(res, err);
    }
  });

  router.post("/api/searches/:id/enrich", async (req, res) => {
    req.setTimeout(10 * 60 * 1000);
    try {
      const body = req.body ?? {};
      const result = await enrichSearch({
        id: req.params.id,
        enrichers:
          body.enrichers != null
            ? Array.isArray(body.enrichers)
              ? body.enrichers
              : parseEnricherSpecs(String(body.enrichers))
            : undefined,
        limit: typeof body.limit === "number" ? body.limit : undefined,
        force: Boolean(body.force),
        timeoutMs: typeof body.timeoutMs === "number" ? body.timeoutMs : undefined,
      });
      res.json({
        doc: result.doc,
        fetched: result.fetched,
        cached: result.cached,
        failed: result.failed,
        skipped: result.skipped,
        aiFetched: result.aiFetched,
        aiCached: result.aiCached,
        aiFailed: result.aiFailed,
        aiSkipped: result.aiSkipped,
      });
    } catch (err) {
      fail(res, err);
    }
  });

  router.post("/api/searches/:id/discover-more", async (req, res) => {
    req.setTimeout(10 * 60 * 1000);
    try {
      const body = req.body ?? {};
      const result = await discoverMore({
        id: req.params.id,
        force: Boolean(body.force),
        maxHubs: typeof body.maxHubs === "number" ? body.maxHubs : undefined,
      });
      res.json({
        doc: result.doc,
        hubs: result.hubs.length,
        neighbors: result.neighbors,
        cacheHits: result.cacheHits,
        transformed: result.transformed,
        fromCache: result.fromCache,
      });
    } catch (err) {
      fail(res, err);
    }
  });

  router.post("/api/searches/:id/neighbors/open", async (req, res) => {
    req.setTimeout(10 * 60 * 1000);
    try {
      const seed = String(req.body?.seed ?? "").trim();
      const result = await openNeighbor({ id: req.params.id, seed });
      res.json(result);
    } catch (err) {
      fail(res, err, 400);
    }
  });

  router.post("/api/searches/:id/generate", async (req, res) => {
    try {
      const body = req.body ?? {};
      const outDir = typeof body.outDir === "string" ? body.outDir : undefined;
      const result = await generateResults({
        id: req.params.id,
        outDir,
        options: parseGenerateOptions(body.options ?? body),
      });
      res.json({
        dir: result.dir,
        report: result.report,
        articles: result.articles,
        markdown: result.markdown,
        options: result.package.options,
        metrics: result.package.metrics,
        hubs: result.package.hubs.map((hub) => ({
          slug: hub.slug,
          h1: hub.h1,
          absorbs: hub.absorbs.length,
          fit: hub.fit,
          outcome: hub.outcome,
          depthScore: hub.depthScore,
        })),
      });
    } catch (err) {
      fail(res, err);
    }
  });

  router.post("/api/searches/:id/phrases", async (req, res) => {
    try {
      const phrase = String(req.body?.phrase ?? "").trim();
      const doc = await addManualPhrase(req.params.id, phrase);
      res.json(doc);
    } catch (err) {
      fail(res, err, 400);
    }
  });

  router.delete("/api/searches/:id/phrases", async (req, res) => {
    try {
      const phrase = String(req.body?.phrase ?? req.query.phrase ?? "").trim();
      const doc = await removePhrase(req.params.id, phrase);
      res.json(doc);
    } catch (err) {
      fail(res, err, 400);
    }
  });

  router.delete("/api/searches/:id", async (req, res) => {
    try {
      await deleteSearch(req.params.id);
      res.json({ ok: true });
    } catch (err) {
      fail(res, err);
    }
  });

  return router;
}
