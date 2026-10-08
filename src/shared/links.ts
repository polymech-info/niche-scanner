import type { Locale } from "./phrases.js";

/** SerpAPI archive for a stored search id. Needs api_key to open. */
export function serpapiSearchUrl(
  searchId: string | null | undefined,
  apiKey?: string | null
): string | undefined {
  if (!searchId) return undefined;
  const url = new URL(
    `https://serpapi.com/searches/${encodeURIComponent(searchId)}`
  );
  const key = apiKey?.trim();
  if (key) url.searchParams.set("api_key", key);
  return url.href;
}

export function googleSearchUrl(
  query: string,
  locale?: Partial<Locale>
): string {
  const raw = (locale?.googleDomain || "google.com")
    .replace(/^https?:\/\//, "")
    .replace(/\/$/, "");
  const host = raw.startsWith("www.") ? raw : `www.${raw}`;
  const url = new URL(`https://${host}/search`);
  url.searchParams.set("q", query);
  if (locale?.gl) url.searchParams.set("gl", locale.gl);
  if (locale?.hl) url.searchParams.set("hl", locale.hl);
  return url.href;
}

export function markdownLink(label: string, href?: string | null): string {
  if (!href) return label;
  return `[${label.replace(/[\[\]]/g, "")}](${href})`;
}
