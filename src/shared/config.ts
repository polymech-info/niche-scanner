import { normalizePhrase } from "./phrases.js";
import {
  EMPTY_CAPABILITY_OVERLAY,
  parseCapabilityOverlay,
  type CapabilityOverlay,
} from "./capability-overlay.js";

export interface ProductProfile {
  name: string;
  url?: string;
  summary?: string;
  platforms: string[];
  notPlatforms: string[];
  /** Brand/policy claims which must never be made. */
  doesNot: string[];
}

export interface AppSettings {
  blacklist: string[];
  product: ProductProfile | null;
  /** Enable/disable compiled caps and add custom ones. Survives snapshot recapture. */
  capabilities?: CapabilityOverlay;
}

export const EMPTY_PRODUCT: ProductProfile = {
  name: "",
  platforms: [],
  notPlatforms: [],
  doesNot: [],
};

export const EMPTY_SETTINGS: AppSettings = {
  blacklist: [],
  product: null,
  capabilities: { ...EMPTY_CAPABILITY_OVERLAY },
};

export interface TopWord {
  word: string;
  count: number;
  phrases: number;
}

const STOP = new Set([
  "a",
  "an",
  "the",
  "to",
  "of",
  "and",
  "or",
  "in",
  "on",
  "for",
  "is",
  "are",
  "do",
  "does",
  "can",
  "my",
  "your",
  "how",
  "what",
  "why",
  "when",
  "where",
  "who",
  "which",
  "with",
  "from",
  "it",
  "this",
  "that",
  "i",
  "me",
  "you",
]);

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function normalizeBlacklistWord(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

export function parseWordList(raw: unknown): string[] {
  const parts = Array.isArray(raw)
    ? raw.map((item) => String(item ?? ""))
    : typeof raw === "string"
      ? raw.split(/[,\n]/)
      : [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of parts) {
    const word = normalizeBlacklistWord(part);
    if (!word || seen.has(word)) continue;
    seen.add(word);
    out.push(word);
  }
  return out;
}

export function parseProduct(raw: unknown): ProductProfile | null {
  if (!raw || typeof raw !== "object") return null;
  const data = raw as Record<string, unknown>;
  const name = String(data.name ?? "").trim();
  if (!name) return null;
  const url = String(data.url ?? "").trim();
  const summary = String(data.summary ?? "").trim();
  return {
    name,
    url: url || undefined,
    summary: summary || undefined,
    platforms: parseWordList(data.platforms),
    notPlatforms: parseWordList(data.notPlatforms),
    doesNot: parseWordList(data.doesNot),
  };
}

export function parseSettings(raw: unknown): AppSettings {
  const data = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  return {
    blacklist: parseWordList(data.blacklist),
    product: parseProduct(data.product),
    capabilities: parseCapabilityOverlay(data.capabilities),
  };
}

export function resolveSettings(
  input?: AppSettings | readonly string[] | null
): AppSettings {
  if (Array.isArray(input)) {
    return {
      blacklist: parseWordList(input),
      product: null,
      capabilities: { ...EMPTY_CAPABILITY_OVERLAY },
    };
  }
  if (input && typeof input === "object") return parseSettings(input);
  return { ...EMPTY_SETTINGS, blacklist: [] };
}

export function tokenizeWords(text: string): string[] {
  return normalizePhrase(text)
    .split(/[^a-z0-9]+/i)
    .map((part) => part.toLowerCase())
    .filter(Boolean);
}

export function isBlacklisted(
  phrase: string,
  blacklist: readonly string[]
): boolean {
  const text = normalizePhrase(phrase);
  if (!text || !blacklist.length) return false;
  return blacklist.some((item) => {
    const word = normalizeBlacklistWord(item);
    if (!word) return false;
    if (word.includes(" ")) return text.includes(word);
    return new RegExp(`\\b${escapeRegExp(word)}\\b`, "i").test(text);
  });
}

export function blacklistHits(
  phrases: readonly string[],
  word: string
): number {
  return phrases.filter((phrase) => isBlacklisted(phrase, [word])).length;
}

export function topWords(
  phrases: readonly string[],
  limit = 80
): TopWord[] {
  const counts = new Map<string, { count: number; docs: Set<number> }>();
  phrases.forEach((phrase, index) => {
    for (const raw of tokenizeWords(phrase)) {
      if (raw.length < 2 || STOP.has(raw)) continue;
      const row = counts.get(raw) ?? { count: 0, docs: new Set() };
      row.count += 1;
      row.docs.add(index);
      counts.set(raw, row);
    }
  });
  return [...counts.entries()]
    .map(([word, row]) => ({
      word,
      count: row.count,
      phrases: row.docs.size,
    }))
    .sort((a, b) => b.count - a.count || a.word.localeCompare(b.word))
    .slice(0, limit);
}
