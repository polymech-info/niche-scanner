/**
 * Phrase enrichment pipeline
 *
 * Orchestrates MetaEnricher (and later steps) for unique ranking URLs.
 * Canonical place to instantiate and sequence enrichers — same idea as
 * pm-pics gridSearchEnrich.
 */

import type { SiteMeta } from "../../shared/phrases.js";
import { mapPool } from "../serpapi.js";
import { getEnricher } from "./registry.js";
import {
  DEFAULT_ENRICHERS,
  type EnricherSpec,
  type EnrichPipelineOptions,
} from "./types.js";

function resolveNames(specs: EnricherSpec[]): Array<{
  name: string;
  timeoutMs?: number;
}> {
  const seen = new Set<string>();
  const out: Array<{ name: string; timeoutMs?: number }> = [];
  for (const spec of specs) {
    const name = typeof spec === "string" ? spec : spec.name;
    const timeoutMs = typeof spec === "string" ? undefined : spec.options?.timeoutMs;
    if (seen.has(name)) continue;
    seen.add(name);
    out.push({ name, timeoutMs });
  }
  return out;
}

export function parseEnricherSpecs(raw?: string | string[]): EnricherSpec[] {
  const parts = (Array.isArray(raw) ? raw.join(",") : raw ?? "meta,ai")
    .split(",")
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean);
  const specs: EnricherSpec[] = [];
  for (const part of parts) {
    if (part === "meta") specs.push("meta");
    if (part === "ai" || part === "ai_overview") specs.push("ai");
  }
  return specs.length ? specs : [...DEFAULT_ENRICHERS];
}

export async function enrichUrls(
  urls: string[],
  options: EnrichPipelineOptions = {}
): Promise<Record<string, SiteMeta>> {
  const specs = resolveNames(options.enrichers ?? DEFAULT_ENRICHERS);
  const timeoutMs = options.timeoutMs ?? 8_000;
  const concurrency = options.concurrency ?? 4;
  const existing = options.existing ?? {};
  const sites: Record<string, SiteMeta> = { ...existing };

  if (!specs.length || !urls.length) return sites;

  await mapPool(urls, concurrency, async (url) => {
    const cached = existing[url];
    if (!options.force && cached && !cached.error && (cached.title || cached.description)) {
      sites[url] = { ...cached, fromCache: true };
      return;
    }

    let last: SiteMeta | undefined;
    for (const spec of specs) {
      const enricher = getEnricher(spec.name);
      if (!enricher) continue;
      last = await enricher.enrich(
        { url },
        { timeoutMs: spec.timeoutMs ?? timeoutMs, forceRefresh: options.force }
      );
    }
    if (last) sites[url] = last;
  });

  return sites;
}
