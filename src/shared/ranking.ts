import type { OrganicResult, SearchDocument, SiteMeta } from "./phrases.js";
import { normalizeSiteUrl, siteFor } from "./sites.js";

export type RankingKind = "social" | "apps";

export interface RankingLeaf {
  kind: RankingKind;
  network: string;
  host: string;
  title: string;
  link: string;
  snippet?: string;
  source?: string;
  position: number | null;
  phrases: string[];
}

const SOCIAL: Array<{ network: string; test: (host: string) => boolean }> = [
  { network: "reddit", test: (h) => h === "reddit.com" || h.endsWith(".reddit.com") },
  { network: "facebook", test: (h) => h === "facebook.com" || h === "fb.com" || h.endsWith(".facebook.com") },
  { network: "instagram", test: (h) => h === "instagram.com" },
  { network: "x", test: (h) => h === "x.com" || h === "twitter.com" },
  { network: "tiktok", test: (h) => h === "tiktok.com" || h.endsWith(".tiktok.com") },
  { network: "youtube", test: (h) => h === "youtube.com" || h === "youtu.be" },
  { network: "linkedin", test: (h) => h === "linkedin.com" },
  { network: "threads", test: (h) => h === "threads.net" },
  { network: "quora", test: (h) => h === "quora.com" },
  { network: "pinterest", test: (h) => h === "pinterest.com" },
];

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return null;
  }
}

function isAppStore(url: string, host: string): string | null {
  if (host === "play.google.com") return "play";
  if (host === "apps.apple.com" || host === "itunes.apple.com") return "apple";
  if (host === "apps.microsoft.com") return "microsoft";
  if (host === "microsoft.com" && /\/(store|p)\//i.test(url)) return "microsoft";
  if (host === "chromewebstore.google.com") return "chrome";
  if (host === "chrome.google.com" && /webstore/i.test(url)) return "chrome";
  if (host === "amazon.com" && /(\/gp\/mas|\/appstore|\/apps\/)/i.test(url)) {
    return "amazon";
  }
  if (host === "galaxy.store" || host === "apps.samsung.com") return "samsung";
  if (host === "appgallery.huawei.com") return "huawei";
  if (host === "f-droid.org" || host === "apkpure.com" || host === "aptoide.com") {
    return host.split(".")[0];
  }
  return null;
}

export function rankingKind(
  url: string
): { kind: RankingKind; network: string } | null {
  const host = hostOf(url);
  if (!host) return null;
  const social = SOCIAL.find((row) => row.test(host));
  if (social) return { kind: "social", network: social.network };
  const store = isAppStore(url, host);
  if (store) return { kind: "apps", network: store };
  return null;
}

interface Draft {
  kind: RankingKind;
  network: string;
  host: string;
  title: string;
  link: string;
  snippet?: string;
  source?: string;
  position: number | null;
  phrases: Set<string>;
}

function pushOrganic(
  drafts: Map<string, Draft>,
  row: OrganicResult,
  phrase?: string
): void {
  const key = normalizeSiteUrl(row.link);
  if (!key) return;
  const classified = rankingKind(key);
  if (!classified) return;
  const host = hostOf(key) ?? "";
  const prev = drafts.get(key);
  if (!prev) {
    drafts.set(key, {
      kind: classified.kind,
      network: classified.network,
      host,
      title: row.title,
      link: key,
      snippet: row.snippet,
      source: row.source,
      position: row.position ?? null,
      phrases: new Set(phrase ? [phrase] : []),
    });
    return;
  }
  if (phrase) prev.phrases.add(phrase);
  if (row.position != null && (prev.position == null || row.position < prev.position)) {
    prev.position = row.position;
    prev.title = row.title || prev.title;
  }
  if (!prev.snippet && row.snippet) prev.snippet = row.snippet;
}

export function collectRankingLeaves(
  doc: Pick<SearchDocument, "phrases" | "landscape" | "sites">
): { social: RankingLeaf[]; apps: RankingLeaf[] } {
  const drafts = new Map<string, Draft>();
  for (const row of doc.landscape ?? []) {
    for (const organic of row.organics) pushOrganic(drafts, organic, row.query);
  }
  for (const phrase of doc.phrases) {
    for (const organic of phrase.serp?.organics ?? []) {
      pushOrganic(drafts, organic, phrase.phrase);
    }
    const answer = phrase.serp?.answer;
    if (answer?.link) {
      pushOrganic(
        drafts,
        {
          position: 0,
          title: answer.title || phrase.phrase,
          link: answer.link,
          snippet: answer.snippet,
        },
        phrase.phrase
      );
    }
  }

  const toLeaf = (draft: Draft, sites?: Record<string, SiteMeta>): RankingLeaf => {
    const meta = siteFor(draft.link, sites);
    return {
      kind: draft.kind,
      network: draft.network,
      host: draft.host,
      title: meta?.title || draft.title,
      link: draft.link,
      snippet: meta?.description || draft.snippet,
      source: meta?.siteName || draft.source,
      position: draft.position,
      phrases: [...draft.phrases],
    };
  };

  const social: RankingLeaf[] = [];
  const apps: RankingLeaf[] = [];
  for (const draft of drafts.values()) {
    const leaf = toLeaf(draft, doc.sites);
    if (leaf.kind === "social") social.push(leaf);
    else apps.push(leaf);
  }
  const byPos = (a: RankingLeaf, b: RankingLeaf) =>
    (a.position ?? 99) - (b.position ?? 99) || a.title.localeCompare(b.title);
  social.sort(byPos);
  apps.sort(byPos);
  return { social, apps };
}
