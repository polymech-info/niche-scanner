import type { PhraseRecord, PhraseScores, PhraseSource } from "../shared/phrases.js";
import { normalizePhrase } from "../shared/phrases.js";

const QUESTION_RE =
  /^(how|what|why|when|where|who|which|can|does|do|is|are|should|will)\b|\?$/i;

export function wordCount(phrase: string): number {
  const n = normalizePhrase(phrase);
  return n ? n.split(" ").length : 0;
}

export function isQuestion(phrase: string): boolean {
  return QUESTION_RE.test(normalizePhrase(phrase));
}

export function scorePhrase(input: {
  phrase: string;
  sources: PhraseSource[];
  relevance?: number | null;
}): PhraseScores {
  const words = wordCount(input.phrase);
  const question = isQuestion(input.phrase);
  const sourceCount = new Set(
    input.sources.filter((s) => s !== "manual" && s !== "seed")
  ).size;
  const relevance =
    typeof input.relevance === "number" && Number.isFinite(input.relevance)
      ? input.relevance
      : null;

  let niche = 0;
  if (words >= 6) niche += 36;
  else if (words >= 4) niche += 28;
  else if (words === 3) niche += 14;
  else if (words === 2) niche += 6;

  if (question) niche += 22;
  if (sourceCount >= 3) niche += 18;
  else if (sourceCount === 2) niche += 10;

  if (relevance != null) {
    if (relevance >= 800) niche += 12;
    else if (relevance >= 500) niche += 8;
    else if (relevance >= 200) niche += 4;
  }

  if (input.sources.includes("manual") || input.sources.includes("seed")) {
    niche += 4;
  }

  return {
    niche: Math.max(0, Math.min(100, niche)),
    wordCount: words,
    isQuestion: question,
    relevance,
    sourceCount,
  };
}

export function rescore(record: PhraseRecord): PhraseRecord {
  return {
    ...record,
    scores: scorePhrase({
      phrase: record.phrase,
      sources: record.sources,
      relevance: record.serp?.relevance ?? record.scores.relevance,
    }),
  };
}
