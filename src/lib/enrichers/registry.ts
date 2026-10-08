import { MetaEnricher } from "./meta.js";
import type { EnricherName, ISiteEnricher } from "./types.js";

const enrichers = new Map<string, ISiteEnricher>([["meta", new MetaEnricher()]]);

export function getEnricher(name: EnricherName | string): ISiteEnricher | undefined {
  return enrichers.get(name);
}

export function listEnrichers(): ISiteEnricher[] {
  return [...enrichers.values()];
}
