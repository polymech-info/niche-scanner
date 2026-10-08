import type { DiscoverOptions, Locale, SearchDocument } from "../shared/phrases.js";
import type { GenerateOptions } from "../shared/brief.js";
import { discoverMore, type DiscoverMoreResult } from "./discover-more.js";
import { enrichSearch, type EnrichSearchResult } from "./enrich.js";
import { generateResults, type GenerateResult } from "./generate.js";
import { log } from "./log.js";
import { createSearch, getSearch, qualifySearch } from "./run.js";
import type { SearchStore } from "./store.js";

export interface PipelineInput {
  seeds?: string[];
  id?: string;
  name?: string;
  locale?: Partial<Locale>;
  options?: Partial<DiscoverOptions>;
  qualifyLimit?: number;
  questionsOnly?: boolean;
  enrichers?: string;
  enrichLimit?: number;
  force?: boolean;
  maxHubs?: number;
  dryRun?: boolean;
  generate?: Partial<GenerateOptions>;
  outDir?: string;
  skipQualify?: boolean;
  skipEnrich?: boolean;
  skipDiscover?: boolean;
  skipGenerate?: boolean;
  store?: SearchStore;
}

export interface PipelineStep {
  step: "search" | "qualify" | "enrich" | "discover" | "generate";
  ok: boolean;
  error?: string;
}

export interface PipelineResult {
  id: string;
  name: string;
  phraseCount: number;
  steps: PipelineStep[];
  enrich?: Pick<
    EnrichSearchResult,
    "fetched" | "cached" | "failed" | "aiFetched" | "aiCached" | "aiFailed"
  >;
  discover?: Pick<
    DiscoverMoreResult,
    "fromCache" | "cacheHits" | "transformed" | "neighbors"
  >;
  generate?: {
    dir: string;
    report: string;
    articles: string;
    count: number;
  };
  errors: SearchDocument["meta"]["errors"];
}

export async function runPipeline(input: PipelineInput): Promise<PipelineResult> {
  const store = input.store;
  const steps: PipelineStep[] = [];
  const seeds = (input.seeds ?? []).map((s) => s.trim()).filter(Boolean);

  let doc: SearchDocument;
  if (input.id) {
    doc = await getSearch(input.id, store);
    steps.push({ step: "search", ok: true });
  } else {
    if (!seeds.length) throw new Error("Pass seed keywords, or --id for an existing search");
    doc = await createSearch({
      seeds,
      name: input.name,
      locale: input.locale,
      options: input.options,
      store,
    });
    steps.push({ step: "search", ok: true });
    log.info({ id: doc.id, phrases: doc.phrases.length }, "pipeline search");
  }

  if (!input.skipQualify) {
    try {
      doc = await qualifySearch({
        id: doc.id,
        limit: input.qualifyLimit,
        questionsOnly: input.questionsOnly,
        store,
      });
      steps.push({ step: "qualify", ok: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      steps.push({ step: "qualify", ok: false, error: message });
      throw err;
    }
  }

  let enrich: PipelineResult["enrich"];
  if (!input.skipEnrich) {
    try {
      const result = await enrichSearch({
        id: doc.id,
        enrichers: input.enrichers,
        limit: input.enrichLimit,
        force: input.force,
        store,
      });
      doc = result.doc;
      enrich = {
        fetched: result.fetched,
        cached: result.cached,
        failed: result.failed,
        aiFetched: result.aiFetched,
        aiCached: result.aiCached,
        aiFailed: result.aiFailed,
      };
      steps.push({ step: "enrich", ok: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      steps.push({ step: "enrich", ok: false, error: message });
      throw err;
    }
  }

  let discover: PipelineResult["discover"];
  if (!input.skipDiscover) {
    try {
      const result = await discoverMore({
        id: doc.id,
        force: input.force,
        maxHubs: input.maxHubs,
        dryRun: input.dryRun,
        store,
      });
      doc = result.doc;
      discover = {
        fromCache: result.fromCache,
        cacheHits: result.cacheHits,
        transformed: result.transformed,
        neighbors: result.neighbors,
      };
      steps.push({ step: "discover", ok: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      steps.push({ step: "discover", ok: false, error: message });
      log.warn({ id: doc.id, err: message }, "pipeline discover skipped");
    }
  }

  let generated: GenerateResult | undefined;
  if (!input.skipGenerate) {
    try {
      generated = await generateResults({
        id: doc.id,
        outDir: input.outDir,
        options: input.generate,
        store,
      });
      steps.push({ step: "generate", ok: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      steps.push({ step: "generate", ok: false, error: message });
      throw err;
    }
  }

  return {
    id: doc.id,
    name: doc.name,
    phraseCount: doc.phrases.length,
    steps,
    enrich,
    discover,
    generate: generated
      ? {
          dir: generated.dir,
          report: generated.report,
          articles: generated.articles,
          count: generated.package.metrics.generateCount,
        }
      : undefined,
    errors: doc.meta.errors,
  };
}
