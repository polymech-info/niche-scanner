import { isBlacklisted } from "./config.js";
import type { ArticleRole, PhraseClass, PhraseRecord } from "./phrases.js";
import { normalizePhrase } from "./phrases.js";

const LOCAL_RE = /\b(near me|nearby|open now)\b/;
const COMMERCIAL_RE = /\b(best|which|vs|versus|review|reviews|app|free|online|device|buy|price)\b/;
const LEGAL_RE = /\b(without you knowing|legal|allowed|consent|permission|secretly|illegal)\b/;
const JUNK_RE = /\b(apk|jjs)\b/;
const NAV_RE = /\b(google|youtube|amazon|wikipedia)\b/;
const PLATFORM_RE = /\b(iphone|android|samsung|pc|windows|mac|chrome)\b/;

export function classifyPhrase(
  phrase: string,
  blacklist: readonly string[] = []
): PhraseClass {
  if (isBlacklisted(phrase, blacklist)) {
    return { intent: "junk", role: "skip", reason: "blacklisted word" };
  }
  const text = normalizePhrase(phrase);
  if (!text) return { intent: "junk", role: "skip", reason: "empty" };
  if (/^https?:\/\//.test(text) || /^[\w-]+\.[a-z]{2,}(\/|$)/.test(text)) {
    return { intent: "junk", role: "skip", reason: "URL / domain, not an article query" };
  }
  if (LOCAL_RE.test(text)) {
    return { intent: "local", role: "skip", reason: "local pack / store locator" };
  }
  if (JUNK_RE.test(text)) {
    return { intent: "junk", role: "skip", reason: "download / brand noise" };
  }
  if (NAV_RE.test(text) && text.split(" ").length <= 3) {
    return { intent: "navigational", role: "skip", reason: "looking for a brand, not a topic" };
  }
  if (LEGAL_RE.test(text)) {
    return {
      intent: "informational",
      role: "faq",
      reason: "consent / legality — answer first, sell later",
    };
  }
  if (/^(how|what|why|when|where|who|which|can|does|do|is|are|should)\b/.test(text) || text.endsWith("?")) {
    return {
      intent: "informational",
      role: "write",
      reason: "exact question — title the article with this phrase",
    };
  }
  if (COMMERCIAL_RE.test(text)) {
    return {
      intent: "commercial",
      role: "write",
      reason: "comparison / product query — good landing or listicle",
    };
  }
  if (PLATFORM_RE.test(text) || /\b(download|mp3)\b/.test(text)) {
    return {
      intent: "commercial",
      role: "cluster",
      reason: "platform / format variant — section or sibling page",
    };
  }
  if (text.split(" ").length <= 3) {
    return { intent: "navigational", role: "skip", reason: "too broad for an exact-match article" };
  }
  return { intent: "informational", role: "cluster", reason: "supporting long-tail" };
}

export function withClass(
  record: PhraseRecord,
  blacklist: readonly string[] = []
): PhraseRecord {
  return { ...record, class: classifyPhrase(record.phrase, blacklist) };
}

export function classForPhrase(
  phrase: string,
  stored?: PhraseClass | null,
  blacklist: readonly string[] = []
): PhraseClass {
  if (isBlacklisted(phrase, blacklist)) {
    return { intent: "junk", role: "skip", reason: "blacklisted word" };
  }
  return stored ?? classifyPhrase(phrase, blacklist);
}

export interface ArticleGroup {
  role: ArticleRole;
  title: string;
  phrases: PhraseRecord[];
}

export function groupArticles(phrases: PhraseRecord[]): ArticleGroup[] {
  const buckets: Record<ArticleRole, PhraseRecord[]> = {
    write: [],
    faq: [],
    cluster: [],
    skip: [],
  };
  for (const phrase of phrases) {
    const role = (phrase.class ?? classifyPhrase(phrase.phrase)).role;
    buckets[role].push(phrase);
  }
  return (["write", "faq", "cluster", "skip"] as ArticleRole[])
    .filter((role) => buckets[role].length)
    .map((role) => ({
      role,
      title:
        role === "write"
          ? "Write these"
          : role === "faq"
            ? "FAQ / caution"
            : role === "cluster"
              ? "Cluster under a parent"
              : "Skip",
      phrases: buckets[role],
    }));
}
