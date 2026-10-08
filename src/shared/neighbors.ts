import { classifyPhrase } from "./classify.js";
import { buildArticlePackage } from "./brief.js";
import { normalizePhrase, type SearchDocument, type SearchSummary } from "./phrases.js";

export type NeighborKind = "seed" | "survivor" | "related";

export interface NeighborHub {
  phrase: string;
  kind: NeighborKind;
  role: string;
  niche: number;
  text: string;
}

export interface NeighborHint {
  seed: string;
  why: string;
  via: string;
  kind: NeighborKind;
  searchId?: string;
}

export interface DiscoverMoreMeta {
  ranAt: string;
  hubs: number;
  cacheHits: number;
  transformed: number;
  source: string;
  dest: string;
}

export const NEIGHBOR_PROMPT =
  'Reply with ONLY a JSON object (no markdown): {"n1":"...","w1":"...","n2":"...","w2":"...","n3":"...","w3":"..."}. n is a next Google search that is not a synonym or form-factor of the text. w is a short reason, not another seed. Empty strings if you only have the same topic with digital/portable/handheld/best/free. No brands or URLs.';

const MODIFIERS = new Set([
  "a",
  "the",
  "on",
  "for",
  "to",
  "of",
  "and",
  "or",
  "in",
  "my",
  "your",
  "digital",
  "portable",
  "handheld",
  "free",
  "online",
  "best",
  "app",
  "apps",
  "device",
  "devices",
  "equipment",
  "tool",
  "tools",
  "software",
  "microphone",
  "mic",
  "background",
  "built",
  "inbuilt",
  "phone",
  "mobile",
  "android",
  "iphone",
  "improve",
]);

const STEMS: Record<string, string> = {
  recorder: "record",
  recording: "record",
  recordings: "record",
  record: "record",
  audio: "audio",
  sound: "audio",
  voice: "audio",
  speech: "audio",
  transcribe: "transcript",
  transcription: "transcript",
  transcript: "transcript",
  text: "transcript",
  memo: "memo",
  memos: "memo",
  call: "call",
  calls: "call",
  conversation: "call",
  interview: "interview",
  meeting: "meeting",
  lecture: "lecture",
  dictation: "dictation",
  dictate: "dictation",
  quality: "quality",
};

export function topicTokens(text: string): Set<string> {
  const tokens = new Set<string>();
  for (const raw of normalizePhrase(text).split(/[\s-]+/)) {
    if (!raw || MODIFIERS.has(raw)) continue;
    tokens.add(STEMS[raw] ?? raw);
  }
  return tokens;
}

export function topicKey(text: string): string {
  return [...topicTokens(text)].sort().join(" ");
}

export function sameTopic(a: string, b: string): boolean {
  const left = topicTokens(a);
  const right = topicTokens(b);
  if (!left.size || !right.size) return true;
  if (topicKey(a) === topicKey(b)) return true;
  const extra = [...right].filter((token) => !left.has(token));
  return extra.length === 0;
}

export function extraTokens(anchor: string, neighbor: string): string[] {
  const base = topicTokens(anchor);
  return [...topicTokens(neighbor)].filter((token) => !base.has(token));
}

export function hasNewTopic(anchors: string[], neighbor: string): boolean {
  const base = new Set(anchors.flatMap((anchor) => [...topicTokens(anchor)]));
  return [...topicTokens(neighbor)].some((token) => !base.has(token));
}

function isPhraseLike(value: string): boolean {
  const text = normalizePhrase(value);
  if (!text || /[.!?]/.test(text)) return false;
  if (/\b(vs|versus|because|not a)\b/.test(text)) return false;
  const words = text.split(" ");
  if (words.length < 2 || words.length > 6) return false;
  return topicTokens(text).size >= 2;
}

export function hubText(hub: Pick<NeighborHub, "phrase" | "kind">): string {
  if (hub.kind === "seed") {
    return `${hub.phrase} | kind=seed | next search seeds only`;
  }
  if (hub.kind === "survivor") {
    return `${hub.phrase} | kind=article | adjacent search seeds, not more titles`;
  }
  return `${hub.phrase} | kind=related | sibling search seeds`;
}

export function pickNeighborHubs(
  doc: SearchDocument,
  max = 8
): NeighborHub[] {
  const seen = new Set<string>();
  const hubs: NeighborHub[] = [];

  const add = (phrase: string, kind: NeighborKind, role: string, niche: number) => {
    const key = normalizePhrase(phrase);
    if (!key || seen.has(key) || hubs.length >= max) return;
    seen.add(key);
    hubs.push({
      phrase: key,
      kind,
      role,
      niche,
      text: hubText({ phrase: key, kind }),
    });
  };

  for (const seed of doc.seeds) {
    add(seed, "seed", "skip", 0);
  }

  const related = [...doc.phrases]
    .filter((row) => row.sources.includes("related_searches"))
    .sort((a, b) => b.scores.niche - a.scores.niche);

  const seedTopic = doc.seeds[0] ?? doc.name;
  let relatedAdded = 0;
  for (const row of related) {
    if (relatedAdded >= 3) break;
    const cls = row.class ?? classifyPhrase(row.phrase);
    if (cls.intent === "junk" || cls.intent === "local") continue;
    const words = normalizePhrase(row.phrase).split(" ").length;
    if (words < 2 || words > 5) continue;
    if (!hasNewTopic([seedTopic], row.phrase)) {
      continue;
    }
    const before = hubs.length;
    add(row.phrase, "related", cls.role, row.scores.niche);
    if (hubs.length > before) relatedAdded += 1;
  }

  const pkg = buildArticlePackage(doc);
  for (const hub of pkg.hubs) {
    if (!hasNewTopic([seedTopic], hub.h1)) {
      continue;
    }
    add(hub.h1, "survivor", "write", hub.niche);
  }

  return hubs;
}

export function knownPhrases(doc: SearchDocument): Set<string> {
  const keys = new Set<string>();
  for (const seed of doc.seeds) keys.add(normalizePhrase(seed));
  for (const row of doc.phrases) keys.add(normalizePhrase(row.phrase));
  return keys;
}

function asNeighborList(item: Record<string, unknown>): Array<{ seed?: unknown; why?: unknown }> {
  if (Array.isArray(item.neighbors)) return item.neighbors;
  const rows: Array<{ seed?: unknown; why?: unknown }> = [];
  for (const index of [1, 2, 3] as const) {
    const seed = item[`n${index}`];
    const why = item[`w${index}`];
    if (seed != null && String(seed).trim()) {
      rows.push({ seed, why });
    }
  }
  return rows;
}

export function flattenNeighbors<
  T extends { phrase?: string; kind?: NeighborKind; neighbors?: unknown },
>(
  items: T[],
  known: Set<string>,
  anchors: string[] = []
): NeighborHint[] {
  const raw: NeighborHint[] = [];

  for (const item of items) {
    const via = normalizePhrase(String(item.phrase ?? ""));
    const kind = item.kind === "survivor" || item.kind === "related" ? item.kind : "seed";
    for (const row of asNeighborList(item as Record<string, unknown>)) {
      const seed = normalizePhrase(String(row.seed ?? ""));
      const why = String(row.why ?? "").replace(/\s+/g, " ").trim().slice(0, 160);
      if (seed) {
        raw.push({ seed, why: isPhraseLike(why) ? "" : why, via, kind });
      }
      if (isPhraseLike(why)) {
        raw.push({ seed: normalizePhrase(why), why: "", via, kind });
      }
    }
  }

  return uniqueNeighbors(raw, [...known, ...anchors, ...items.map((item) => String(item.phrase ?? ""))]);
}

export function uniqueNeighbors(
  rows: NeighborHint[],
  anchors: string[]
): NeighborHint[] {
  const expanded: NeighborHint[] = [];
  for (const row of rows) {
    expanded.push(row);
    if (isPhraseLike(row.why)) {
      expanded.push({
        ...row,
        seed: normalizePhrase(row.why),
        why: "",
      });
    }
  }

  const out: NeighborHint[] = [];
  const seenExact = new Set(anchors.map((item) => normalizePhrase(item)).filter(Boolean));
  const seenTopic = new Set(anchors.map(topicKey).filter(Boolean));
  const seenExtra = new Set<string>();

  for (const row of expanded) {
    const seed = normalizePhrase(row.seed);
    if (!seed || seenExact.has(seed) || !isPhraseLike(seed)) continue;
    const cls = classifyPhrase(seed);
    if (cls.intent === "junk" || cls.intent === "local") continue;
    if (/^https?:\/\//.test(seed)) continue;
    if (!hasNewTopic(anchors, seed)) continue;
    const extra = [...new Set(anchors.flatMap((anchor) => extraTokens(anchor, seed)))];
    if (!extra.length || extra.some((token) => seenExtra.has(token))) continue;
    const key = topicKey(seed);
    if (!key || seenTopic.has(key)) continue;
    seenExact.add(seed);
    seenTopic.add(key);
    for (const token of extra) seenExtra.add(token);
    out.push({ ...row, seed });
  }

  return out.slice(0, 6);
}

export function findSearchForSeed(
  searches: SearchSummary[],
  seed: string
): SearchSummary | undefined {
  const key = normalizePhrase(seed);
  return searches.find(
    (row) =>
      row.seeds.some((item) => normalizePhrase(item) === key) ||
      normalizePhrase(row.name) === key
  );
}

export function mergeNeighborLinks(
  current: NeighborHint[] | undefined,
  incoming: NeighborHint[]
): NeighborHint[] {
  const prev = new Map(
    (current ?? []).map((row) => [normalizePhrase(row.seed), row] as const)
  );
  return incoming.map((row) => {
    const old = prev.get(row.seed);
    return old?.searchId ? { ...row, searchId: old.searchId } : row;
  });
}
