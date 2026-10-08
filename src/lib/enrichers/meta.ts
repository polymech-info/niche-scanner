import { load } from "cheerio";
import type { SiteMeta, SiteOg } from "../../shared/phrases.js";
import type { EnricherContext, ISiteEnricher, SiteTarget } from "./types.js";

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const MAX_HTML_BYTES = 512_000;

function readMeta(
  $: ReturnType<typeof load>,
  name: string
): string | undefined {
  const value =
    $(`meta[name="${name}"]`).attr("content") ||
    $(`meta[property="${name}"]`).attr("content") ||
    undefined;
  const trimmed = value?.trim();
  return trimmed || undefined;
}

function splitKeywords(raw: string | undefined): string[] | undefined {
  if (!raw) return undefined;
  const parts = raw
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  return parts.length ? parts : undefined;
}

/** Parse title / description / OG from HTML. Cheap path from pm-pics MetaEnricher. */
export function parseSiteHtml(html: string, url: string): Partial<SiteMeta> {
  const $ = load(html);
  const title = $("title").first().text().replace(/\s+/g, " ").trim() || undefined;
  const canonical = $("link[rel=canonical]").attr("href")?.trim() || undefined;

  const metaTitle = readMeta($, "title");
  const description = readMeta($, "description");
  const image = readMeta($, "image");

  const og: SiteOg = {};
  const ogTitle = readMeta($, "og:title");
  const ogDescription = readMeta($, "og:description");
  const ogImage = readMeta($, "og:image");
  const ogUrl = readMeta($, "og:url");
  const ogSiteName = readMeta($, "og:site_name");
  const ogType = readMeta($, "og:type");
  if (ogTitle) og.title = ogTitle;
  if (ogDescription) og.description = ogDescription;
  if (ogImage) og.image = ogImage;
  if (ogUrl) og.url = ogUrl;
  if (ogSiteName) og.siteName = ogSiteName;
  if (ogType) og.type = ogType;

  const keywords = splitKeywords(
    readMeta($, "keywords") || readMeta($, "og:keywords")
  );

  const resolvedTitle = metaTitle || title || og.title;
  const resolvedDescription = description || og.description;
  const resolvedImage = image || og.image;
  const headings = $("main h1, main h2, article h1, article h2, h1, h2")
    .map((_, element) => $(element).text().replace(/\s+/g, " ").trim())
    .get()
    .filter(Boolean)
    .filter((value, index, all) => all.indexOf(value) === index)
    .slice(0, 16);
  $("script, style, nav, footer, header, noscript, svg").remove();
  const excerptText = ($("main").first().text() || $("article").first().text() || $("body").text())
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 2400);

  return {
    url,
    title: resolvedTitle,
    description: resolvedDescription,
    image: resolvedImage,
    canonical,
    siteName: og.siteName,
    keywords,
    headings: headings.length ? headings : undefined,
    excerpt: excerptText || undefined,
    og: Object.keys(og).length ? og : undefined,
  };
}

export class MetaEnricher implements ISiteEnricher {
  name = "meta";

  async enrich(target: SiteTarget, context: EnricherContext = {}): Promise<SiteMeta> {
    const started = Date.now();
    const timeoutMs = context.timeoutMs ?? 8_000;
    const fetchedAt = new Date().toISOString();

    try {
      const response = await fetch(target.url, {
        headers: { "User-Agent": USER_AGENT, Accept: "text/html,application/xhtml+xml" },
        redirect: "follow",
        signal: AbortSignal.timeout(timeoutMs),
      });
      const contentType = response.headers.get("content-type") ?? "";
      if (!/html|xml|text\/plain/i.test(contentType) && contentType) {
        return {
          url: target.url,
          finalUrl: response.url,
          httpStatus: response.status,
          error: `not html (${contentType.split(";")[0]})`,
          enricher: this.name,
          fetchedAt,
          ms: Date.now() - started,
        };
      }

      const raw = await response.text();
      const parsed = parseSiteHtml(raw.slice(0, MAX_HTML_BYTES), target.url);
      return {
        url: target.url,
        finalUrl: response.url !== target.url ? response.url : undefined,
        title: parsed.title,
        description: parsed.description,
        image: parsed.image,
        canonical: parsed.canonical,
        siteName: parsed.siteName,
        keywords: parsed.keywords,
        headings: parsed.headings,
        excerpt: parsed.excerpt,
        og: parsed.og,
        httpStatus: response.status,
        error: response.ok ? undefined : `http ${response.status}`,
        enricher: this.name,
        fetchedAt,
        ms: Date.now() - started,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        url: target.url,
        error: message,
        enricher: this.name,
        fetchedAt,
        ms: Date.now() - started,
      };
    }
  }
}
