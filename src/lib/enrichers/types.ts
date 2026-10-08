import type { SiteMeta } from "../../shared/phrases.js";

export interface SiteTarget {
  url: string;
}

export interface EnricherContext {
  forceRefresh?: boolean;
  timeoutMs?: number;
}

export interface ISiteEnricher {
  name: string;
  enrich(target: SiteTarget, context: EnricherContext): Promise<SiteMeta>;
}

export type EnricherName = "meta" | "ai";

export type EnricherSpec =
  | EnricherName
  | { name: EnricherName; options?: { timeoutMs?: number } };

export interface EnrichPipelineOptions {
  enrichers?: EnricherSpec[];
  timeoutMs?: number;
  concurrency?: number;
  force?: boolean;
  existing?: Record<string, SiteMeta>;
}

export const DEFAULT_ENRICHERS: EnricherSpec[] = ["meta", "ai"];
