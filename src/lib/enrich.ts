import type { SearchDocument } from "../shared/phrases.js";
import { enrichAiOverviews } from "./enrichers/ai.js";
import { enrichUrls, parseEnricherSpecs } from "./enrichers/pipeline.js";
import { collectSiteUrls } from "./enrichers/urls.js";
import type { EnricherSpec } from "./enrichers/types.js";
import { getStore } from "./run.js";
import type { SearchStore } from "./store.js";

export interface EnrichSearchInput {
  id: string;
  enrichers?: EnricherSpec[] | string;
  limit?: number;
  force?: boolean;
  timeoutMs?: number;
  concurrency?: number;
  store?: SearchStore;
}

export interface EnrichSearchResult {
  doc: SearchDocument;
  fetched: number;
  cached: number;
  failed: number;
  skipped: number;
  aiFetched: number;
  aiCached: number;
  aiFailed: number;
  aiSkipped: number;
}

export async function enrichSearch(
  input: EnrichSearchInput
): Promise<EnrichSearchResult> {
  const store = getStore(input.store);
  const current = await store.get(input.id);
  const enrichers = Array.isArray(input.enrichers)
    ? input.enrichers
    : parseEnricherSpecs(input.enrichers);
  const names = enrichers.map((spec) =>
    typeof spec === "string" ? spec : spec.name
  );
  const limit = Math.min(200, Math.max(1, input.limit ?? 20));
  const wantMeta = names.includes("meta");
  const wantAi = names.includes("ai");

  const all = collectSiteUrls(current);
  const targets = wantMeta ? all.slice(0, limit) : [];
  const skipped = wantMeta ? Math.max(0, all.length - targets.length) : 0;

  const sites = wantMeta
    ? await enrichUrls(targets, {
        enrichers,
        force: Boolean(input.force),
        timeoutMs: input.timeoutMs,
        concurrency: input.concurrency,
        existing: current.sites ?? {},
      })
    : current.sites ?? {};

  const ai = wantAi
    ? await enrichAiOverviews(current, {
        limit,
        force: Boolean(input.force),
      })
    : {
        phrases: current.phrases,
        stats: { fetched: 0, cached: 0, failed: 0, skipped: 0 },
      };

  const next: SearchDocument = {
    ...current,
    updatedAt: new Date().toISOString(),
    phrases: ai.phrases,
    sites,
  };
  const doc = await store.save(next);

  const values = targets.map((url) => sites[url]).filter(Boolean);
  return {
    doc,
    fetched: values.filter((site) => !site.fromCache).length,
    cached: values.filter((site) => site.fromCache).length,
    failed: values.filter((site) => Boolean(site.error)).length,
    skipped,
    aiFetched: ai.stats.fetched,
    aiCached: ai.stats.cached,
    aiFailed: ai.stats.failed,
    aiSkipped: ai.stats.skipped,
  };
}
