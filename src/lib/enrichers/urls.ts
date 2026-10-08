import type { SearchDocument } from "../../shared/phrases.js";
import { isFetchablePage, normalizeSiteUrl } from "../../shared/sites.js";

export { isFetchablePage, normalizeSiteUrl, siteFor } from "../../shared/sites.js";

/** Unique ranking URLs: phrase organics, PAA answers, then landscape. */
export function collectSiteUrls(doc: SearchDocument): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const push = (raw?: string) => {
    if (!raw || !isFetchablePage(raw)) return;
    const key = normalizeSiteUrl(raw);
    if (!key || seen.has(key)) return;
    seen.add(key);
    out.push(key);
  };

  const ranked = [...doc.phrases].sort(
    (a, b) => b.scores.niche - a.scores.niche
  );
  for (const phrase of ranked) {
    for (const organic of phrase.serp?.organics ?? []) push(organic.link);
    push(phrase.serp?.answer?.link);
  }
  for (const row of doc.landscape ?? []) {
    for (const organic of row.organics) push(organic.link);
  }
  return out;
}
