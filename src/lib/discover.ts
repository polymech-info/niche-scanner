import type {
  DiscoverEngine,
  DiscoverOptions,
  Locale,
  PhraseRecord,
  PhraseSource,
  SearchMeta,
  SerpLandscape,
} from "../shared/phrases.js";
import { QUESTION_PREFIXES, normalizePhrase } from "../shared/phrases.js";
import { classifyPhrase } from "../shared/classify.js";
import { loadAppConfig } from "./app-config.js";
import { isQuestion, scorePhrase, wordCount } from "./score.js";
import {
  landscapeFrom,
  parseQuestions,
  serpFromHit,
} from "./serp-parse.js";
import {
  fetchAutocomplete,
  fetchGoogleSerp,
  fetchRelatedQuestions,
  mapPool,
  type SerpHit,
} from "./serpapi.js";

const LETTERS = "abcdefghijklmnopqrstuvwxyz".split("");

interface Draft {
  phrase: string;
  sources: Set<PhraseSource>;
  seeds: Set<string>;
  relevance: number | null;
  searchId: string | null;
  engine: string | null;
  answer?: import("../shared/phrases.js").PaaAnswer;
  organics?: import("../shared/phrases.js").OrganicResult[];
  features?: string[];
}

export interface DiscoverResult {
  phrases: PhraseRecord[];
  landscape: SerpLandscape[];
  meta: SearchMeta;
}

function nowIso(): string {
  return new Date().toISOString();
}

function isJunkQuery(key: string): boolean {
  return (
    /^https?:\/\//.test(key) || /^[\w-]+\.[a-z]{2,}(\/|$)/.test(key)
  );
}

function addDraft(
  drafts: Map<string, Draft>,
  phrase: string,
  source: PhraseSource,
  seed: string,
  hit: SerpHit,
  extras?: {
    relevance?: number;
    answer?: import("../shared/phrases.js").PaaAnswer;
  }
): void {
  const key = normalizePhrase(phrase);
  if (!key || key.length < 2 || isJunkQuery(key)) return;
  const existing = drafts.get(key);  if (existing) {
    existing.sources.add(source);
    existing.seeds.add(seed);
    if (existing.relevance == null && extras?.relevance != null) {
      existing.relevance = extras.relevance;
    }
    if (!existing.searchId && hit.meta.searchId) {
      existing.searchId = hit.meta.searchId;
      existing.engine = hit.meta.engine;
    }
    if (!existing.answer && extras?.answer) existing.answer = extras.answer;
    return;
  }
  const parsed = serpFromHit(hit, extras);
  const ownSerp = normalizePhrase(hit.meta.query) === key;
  drafts.set(key, {
    phrase: key,
    sources: new Set([source]),
    seeds: new Set([seed]),
    relevance: extras?.relevance ?? null,
    searchId: hit.meta.searchId,
    engine: hit.meta.engine,
    answer: extras?.answer ?? parsed.answer,
    organics: ownSerp ? parsed.organics : undefined,
    features: ownSerp
      ? parsed.features
      : extras?.answer
        ? ["people_also_ask"]
        : undefined,
  });
}

function addSeedDraft(drafts: Map<string, Draft>, seed: string): void {
  const key = normalizePhrase(seed);
  if (!key || key.length < 2 || isJunkQuery(key)) return;
  const existing = drafts.get(key);
  if (existing) {
    existing.sources.add("seed");
    existing.seeds.add(seed);
    return;
  }
  drafts.set(key, {
    phrase: key,
    sources: new Set(["seed"]),
    seeds: new Set([seed]),
    relevance: null,
    searchId: null,
    engine: null,
  });
}

function autocompleteQueries(
  seed: string,
  options: DiscoverOptions
): string[] {
  const queries = new Set<string>([seed]);
  const long = wordCount(seed) >= 4;
  if (options.alphabet && !long) {
    for (const letter of LETTERS) queries.add(`${seed} ${letter}`);
  }
  if (options.questionPrefixes && !isQuestion(seed)) {
    for (const prefix of QUESTION_PREFIXES) queries.add(`${prefix} ${seed}`);
  }
  return [...queries];
}

async function safeCall(
  engine: string,
  query: string,
  meta: SearchMeta,
  fn: () => Promise<SerpHit>
): Promise<SerpHit | null> {
  try {
    const hit = await fn();
    meta.calls.push(hit.meta);
    return hit;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    meta.errors.push({ engine, query, message });
    return null;
  }
}

export async function discoverPhrases(
  seeds: string[],
  locale: Locale,
  options: DiscoverOptions
): Promise<DiscoverResult> {
  const cleanSeeds = [
    ...new Set(seeds.map((s) => s.replace(/\s+/g, " ").trim()).filter(Boolean)),
  ];
  const { blacklist } = await loadAppConfig();
  const drafts = new Map<string, Draft>();
  const landscape: SerpLandscape[] = [];
  const meta: SearchMeta = { calls: [], errors: [] };
  for (const seed of cleanSeeds) addSeedDraft(drafts, seed);
  const engines = new Set<DiscoverEngine>(options.engines);
  if (engines.has("autocomplete")) {
    const jobs = cleanSeeds.flatMap((seed) =>
      autocompleteQueries(seed, options).map((query) => ({ seed, query }))
    );
    await mapPool(jobs, 3, async ({ seed, query }) => {
      const hit = await safeCall("google_autocomplete", query, meta, () =>
        fetchAutocomplete(query, locale)
      );
      if (!hit) return;
      for (const suggestion of hit.response.suggestions ?? []) {
        if (!suggestion.value) continue;
        addDraft(drafts, suggestion.value, "autocomplete", seed, hit, {
          relevance: suggestion.relevance,
        });
      }
    });
  }

  if (engines.has("related_searches") || engines.has("people_also_ask")) {
    await mapPool(cleanSeeds, 2, async (seed) => {
      const hit = await safeCall("google", seed, meta, () =>
        fetchGoogleSerp(seed, locale)
      );
      if (!hit) return;
      landscape.push(landscapeFrom(hit));

      if (engines.has("related_searches")) {
        for (const related of hit.response.related_searches ?? []) {
          if (related.query) {
            addDraft(drafts, related.query, "related_searches", seed, hit);
          }
        }
      }

      if (!engines.has("people_also_ask")) return;

      const parsed = parseQuestions(hit.response);
      const queue = parsed.map((q) => ({
        question: q.question,
        token: q.token,
        depth: 0,
      }));

      for (const item of parsed) {
        addDraft(drafts, item.question, "people_also_ask", seed, hit, {
          answer: item.answer,
        });
      }

      let depth = 0;
      while (depth < options.paaDepth) {
        depth += 1;
        const tokens = queue
          .filter((q) => q.depth === depth - 1 && q.token)
          .map((q) => ({ token: q.token as string, question: q.question ?? seed }));
        if (!tokens.length) break;
        await mapPool(tokens, 2, async ({ token, question }) => {
          const next = await safeCall(
            "google_related_questions",
            question,
            meta,
            () => fetchRelatedQuestions(token, question)
          );
          if (!next) return;
          for (const related of parseQuestions(next.response)) {
            addDraft(drafts, related.question, "people_also_ask", seed, next, {
              answer: related.answer,
            });
            if (related.token) {
              queue.push({
                question: related.question,
                token: related.token,
                depth,
              });
            }
          }
        });
      }
    });
  }

  const addedAt = nowIso();
  const phrases = [...drafts.values()].map((draft) => {
    const sources = [...draft.sources];
    const record: PhraseRecord = {
      phrase: draft.phrase,
      sources,
      seeds: [...draft.seeds],
      scores: scorePhrase({
        phrase: draft.phrase,
        sources,
        relevance: draft.relevance,
      }),
      addedAt,
      class: classifyPhrase(draft.phrase, blacklist),
      serp: draft.searchId
        ? {
            engine: draft.engine ?? "google",
            searchId: draft.searchId,
            relevance: draft.relevance ?? undefined,
            answer: draft.answer,
            organics: draft.organics?.length ? draft.organics : undefined,
            features: draft.features,
          }
        : null,
    };
    return record;
  });

  phrases.sort((a, b) => b.scores.niche - a.scores.niche || a.phrase.localeCompare(b.phrase));
  return { phrases, landscape, meta };
}
