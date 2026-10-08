import type { SiteMeta } from "./phrases.js";

export function normalizeSiteUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    parsed.hash = "";
    parsed.hostname = parsed.hostname.toLowerCase();
    if (parsed.pathname.endsWith("/") && parsed.pathname !== "/") {
      parsed.pathname = parsed.pathname.replace(/\/+$/, "");
    }
    return parsed.href;
  } catch {
    return null;
  }
}

export function isFetchablePage(url: string): boolean {
  const normalized = normalizeSiteUrl(url);
  if (!normalized) return false;
  const host = new URL(normalized).hostname;
  if (host === "webcache.googleusercontent.com") return false;
  if (host.endsWith("google.com") && /\/search/i.test(normalized)) return false;
  return true;
}

export function siteFor(
  url: string | undefined,
  sites: Record<string, SiteMeta> | undefined
): SiteMeta | undefined {
  if (!url || !sites) return undefined;
  const key = normalizeSiteUrl(url);
  return (key && sites[key]) || sites[url];
}
