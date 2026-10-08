import { classifyPhrase } from "../../shared/classify.js";
import { normalizePhrase, type PhraseRecord, type SearchDocument } from "../../shared/phrases.js";
import { fetchAiOverview, fetchGoogleSerp } from "../serpapi.js";
import {
  flattenAiOverview,
  mergeSerp,
  parseQuestions,
  serpFromHit,
} from "../serp-parse.js";

export interface AiEnrichStats {
  fetched: number;
  cached: number;
  failed: number;
  skipped: number;
}

function hasAiSnippet(row: PhraseRecord): boolean {
  return (
    row.serp?.answer?.type === "ai_overview" &&
    Boolean(row.serp.answer.snippet)
  );
}

function pickAiTargets(doc: SearchDocument, limit: number, force: boolean) {
  const seed = normalizePhrase(doc.seeds[0] ?? "");
  return [...doc.phrases]
    .filter((row) => force || !hasAiSnippet(row))
    .sort((a, b) => {
      const rank = (row: PhraseRecord) => {
        if (normalizePhrase(row.phrase) === seed) return 0;
        if (row.scores.isQuestion) return 1;
        const role = (row.class ?? classifyPhrase(row.phrase)).role;
        return role === "write" ? 2 : role === "faq" ? 3 : 4;
      };
      return rank(a) - rank(b) || b.scores.niche - a.scores.niche;
    })
    .slice(0, limit);
}

export async function enrichAiOverviews(
  doc: SearchDocument,
  input: { limit: number; force?: boolean }
): Promise<{ phrases: PhraseRecord[]; stats: AiEnrichStats }> {
  const all = pickAiTargets(doc, 200, Boolean(input.force));
  const targets = all.slice(0, input.limit);
  const stats: AiEnrichStats = {
    fetched: 0,
    cached: 0,
    failed: 0,
    skipped: Math.max(0, all.length - targets.length),
  };

  const map = new Map(
    doc.phrases.map((row) => [normalizePhrase(row.phrase), row] as const)
  );

  for (const target of targets) {
    const key = normalizePhrase(target.phrase);
    const current = map.get(key) ?? target;
    if (!input.force && hasAiSnippet(current)) {
      stats.cached += 1;
      continue;
    }
    try {
      const hit = await fetchGoogleSerp(target.phrase, doc.locale, {
        noCache: true,
      });
      let answer =
        flattenAiOverview(hit.response.ai_overview) ??
        parseQuestions(hit.response).find(
          (row) => normalizePhrase(row.question) === key
        )?.answer;

      const token = answer?.snippet ? undefined : answer?.pageToken;
      if (token) {
        const next = await fetchAiOverview(token, target.phrase);
        answer = flattenAiOverview(next.response.ai_overview) ?? answer;
      }

      const merged = mergeSerp(current.serp, serpFromHit(hit, { answer }));
      map.set(key, {
        ...current,
        serp: merged
          ? { ...merged, answer: answer?.snippet ? answer : merged.answer }
          : current.serp,
      });
      const stored = map.get(key);
      if (stored && hasAiSnippet(stored)) stats.fetched += 1;
      else stats.failed += 1;
    } catch {
      stats.failed += 1;
    }
  }

  return { phrases: [...map.values()], stats };
}
