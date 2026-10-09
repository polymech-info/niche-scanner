import type { DiscoverMoreMeta, NeighborHint } from "./neighbors.js";
import type { ProductMatch } from "./capabilities.js";

export type PhraseSource =
  | "autocomplete"
  | "related_searches"
  | "people_also_ask"
  | "manual"
  | "seed";

export type DiscoverEngine = Exclude<PhraseSource, "manual" | "seed">;

export interface Locale {
  gl: string;
  hl: string;
  googleDomain: string;
}

export interface DiscoverOptions {
  engines: DiscoverEngine[];
  paaDepth: number;
  alphabet: boolean;
  questionPrefixes: boolean;
}

export type PhraseIntent =
  | "informational"
  | "commercial"
  | "navigational"
  | "local"
  | "junk";

export type ArticleRole = "write" | "faq" | "cluster" | "skip";

export interface PhraseScores {
  /** 0–100 local niche score (long-tail + question + source overlap). */
  niche: number;
  wordCount: number;
  isQuestion: boolean;
  /** Autocomplete relevance when Google provided one. */
  relevance: number | null;
  sourceCount: number;
}

export interface PhraseClass {
  intent: PhraseIntent;
  role: ArticleRole;
  reason: string;
}

export interface OrganicResult {
  position: number;
  title: string;
  link: string;
  snippet?: string;
  source?: string;
  /** SerpAPI relative or published date, e.g. "2 days ago". */
  date?: string;
}

/** Cheap page head — title / description / OG. No body HTML. */
export interface SiteOg {
  title?: string;
  description?: string;
  image?: string;
  url?: string;
  siteName?: string;
  type?: string;
}

export interface SiteMeta {
  url: string;
  finalUrl?: string;
  title?: string;
  description?: string;
  image?: string;
  canonical?: string;
  siteName?: string;
  keywords?: string[];
  /** Bounded page-body evidence used for article gap analysis. */
  headings?: string[];
  excerpt?: string;
  og?: SiteOg;
  httpStatus?: number;
  error?: string;
  fromCache?: boolean;
  enricher: string;
  fetchedAt: string;
  ms: number;
}

export interface PaaAnswer {
  snippet?: string;
  title?: string;
  link?: string;
  displayedLink?: string;
  type?: string;
  pageToken?: string;
}

export interface PhraseSerpRef {
  engine: string;
  searchId: string | null;
  relevance?: number;
  answer?: PaaAnswer;
  organics?: OrganicResult[];
  features?: string[];
}

export interface PhraseRecord {
  phrase: string;
  sources: PhraseSource[];
  seeds: string[];
  scores: PhraseScores;
  class?: PhraseClass;
  addedAt: string;
  serp: PhraseSerpRef | null;
}

export interface SerpLandscape {
  query: string;
  searchId: string | null;
  features: string[];
  organics: OrganicResult[];
}

export interface SerpCallMeta {
  engine: string;
  query: string;
  status: string | null;
  searchId: string | null;
  createdAt: string | null;
  totalTimeTaken: number | null;
  resultCount: number;
}

export interface SearchError {
  engine: string;
  query: string;
  message: string;
}

export interface SearchMeta {
  calls: SerpCallMeta[];
  errors: SearchError[];
}

export interface SearchDocument {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  locale: Locale;
  seeds: string[];
  options: DiscoverOptions;
  phrases: PhraseRecord[];
  landscape?: SerpLandscape[];
  /** Deduped ranking-page meta, keyed by normalized URL. */
  sites?: Record<string, SiteMeta>;
  parentId?: string;
  neighbors?: NeighborHint[];
  discoverMore?: DiscoverMoreMeta;
  /** Grounded evidence copied from a promoted disposable opportunity run. */
  opportunity?: {
    runId: string;
    query: string;
    promotedAt: string;
    matches: Record<string, ProductMatch>;
  };
  meta: SearchMeta;
}

export interface SearchSummary {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  seeds: string[];
  phraseCount: number;
  locale: Locale;
  parentId?: string;
  neighborCount?: number;
}

export interface AppInfo {
  name: string;
  dataDir: string;
  resultsDir: string;
  logDir: string;
  locale: Locale;
  hasSerpapiKey: boolean;
  serpapiKey?: string;
  searchCount: number;
}

export const ENGINE_ALIASES = {
  ac: "autocomplete",
  rs: "related_searches",
  rq: "people_also_ask",
} as const;

export const DEFAULT_LOCALE: Locale = {
  gl: "us",
  hl: "en",
  googleDomain: "google.com",
};

export const DEFAULT_OPTIONS: DiscoverOptions = {
  engines: ["autocomplete", "related_searches", "people_also_ask"],
  paaDepth: 0,
  alphabet: false,
  questionPrefixes: false,
};

export const QUESTION_PREFIXES = [
  "how",
  "what",
  "why",
  "when",
  "can",
  "does",
  "is",
  "best",
] as const;

export function normalizePhrase(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

export function parseEngines(raw?: string | string[]): DiscoverEngine[] {
  const parts = (Array.isArray(raw) ? raw.join(",") : raw ?? "ac,rs,rq")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

  const engines: DiscoverEngine[] = [];
  for (const part of parts) {
    const mapped =
      part in ENGINE_ALIASES
        ? ENGINE_ALIASES[part as keyof typeof ENGINE_ALIASES]
        : part;
    if (
      mapped === "autocomplete" ||
      mapped === "related_searches" ||
      mapped === "people_also_ask"
    ) {
      if (!engines.includes(mapped)) engines.push(mapped);
    }
  }
  return engines.length ? engines : [...DEFAULT_OPTIONS.engines];
}

export function summarize(doc: SearchDocument): SearchSummary {
  return {
    id: doc.id,
    name: doc.name,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
    seeds: doc.seeds,
    phraseCount: doc.phrases.length,
    locale: doc.locale,
    parentId: doc.parentId,
    neighborCount: doc.neighbors?.length,
  };
}
