import type {
  OrganicResult,
  PaaAnswer,
  PhraseSerpRef,
  SerpLandscape,
} from "../shared/phrases.js";
import type { SerpHit, SerpResponse } from "./serpapi.js";

export interface ParsedQuestion {
  question: string;
  token?: string;
  answer?: PaaAnswer;
}

export function parseOrganics(response: SerpResponse): OrganicResult[] {
  return (response.organic_results ?? []).flatMap((row, index) => {
    if (!row.link || !row.title) return [];
    return [
      {
        position: row.position ?? index + 1,
        title: row.title,
        link: row.link,
        snippet: row.snippet,
        source: row.source,
      },
    ];
  });
}

function blockText(block: unknown): string[] {
  if (!block || typeof block !== "object") return [];
  const row = block as Record<string, unknown>;
  const out: string[] = [];
  if (typeof row.snippet === "string" && row.snippet.trim()) {
    out.push(row.snippet.trim());
  }
  if (typeof row.answer === "string" && row.answer.trim()) {
    out.push(row.answer.trim());
  }
  const nested = row.list ?? row.items;
  if (Array.isArray(nested)) {
    for (const item of nested) out.push(...blockText(item));
  }
  return out;
}

export function flattenAiOverview(
  raw: Record<string, unknown> | undefined
): PaaAnswer | undefined {
  if (!raw) return undefined;
  const pageToken =
    typeof raw.page_token === "string" && raw.page_token.trim()
      ? raw.page_token.trim()
      : undefined;
  const texts = Array.isArray(raw.text_blocks)
    ? raw.text_blocks.flatMap(blockText)
    : [];
  if (typeof raw.snippet === "string" && raw.snippet.trim()) {
    texts.unshift(raw.snippet.trim());
  }
  const refs = Array.isArray(raw.references) ? raw.references : [];
  const first =
    refs.find((item) => item && typeof item === "object") as
      | { title?: string; link?: string }
      | undefined;
  const snippet = texts.join(" ").replace(/\s+/g, " ").trim().slice(0, 1600);
  if (!snippet && !pageToken) return undefined;
  return {
    snippet: snippet || undefined,
    title: first?.title,
    link: first?.link,
    type: "ai_overview",
    pageToken,
  };
}

export function parseQuestions(response: SerpResponse): ParsedQuestion[] {
  return (response.related_questions ?? []).flatMap((row) => {
    if (!row.question) return [];
    const answer: PaaAnswer | undefined =
      row.snippet || row.title || row.link || row.page_token || row.type
        ? {
            snippet: row.snippet,
            title: row.title,
            link: row.link,
            displayedLink: row.displayed_link,
            type: row.type,
            pageToken: row.page_token,
          }
        : undefined;
    return [
      {
        question: row.question,
        token: row.next_page_token,
        answer,
      },
    ];
  });
}

export function parseFeatures(response: SerpResponse): string[] {
  const features: string[] = [];
  if (response.organic_results?.length) features.push("organic");
  if (response.related_questions?.length) features.push("people_also_ask");
  if (response.related_searches?.length) features.push("related_searches");
  if (response.answer_box) features.push("answer_box");
  if (response.ai_overview) features.push("ai_overview");
  return features;
}

export function landscapeFrom(hit: SerpHit): SerpLandscape {
  return {
    query: hit.meta.query,
    searchId: hit.meta.searchId,
    features: parseFeatures(hit.response),
    organics: parseOrganics(hit.response),
  };
}

export function serpFromHit(
  hit: SerpHit,
  extras?: { relevance?: number; answer?: PaaAnswer }
): PhraseSerpRef {
  const ai = flattenAiOverview(hit.response.ai_overview);
  const answer =
    extras?.answer?.snippet
      ? extras.answer
      : ai?.snippet
        ? ai
        : extras?.answer ?? ai;
  return {
    engine: hit.meta.engine,
    searchId: hit.meta.searchId,
    relevance: extras?.relevance,
    answer,
    organics: parseOrganics(hit.response),
    features: parseFeatures(hit.response),
  };
}

export function mergeSerp(
  a: PhraseSerpRef | null | undefined,
  b: PhraseSerpRef | null | undefined
): PhraseSerpRef | null {
  if (!a) return b ?? null;
  if (!b) return a;
  return {
    engine: b.organics?.length ? b.engine : a.engine,
    searchId: b.searchId ?? a.searchId,
    relevance: a.relevance ?? b.relevance,
    answer: a.answer?.snippet ? a.answer : b.answer ?? a.answer,
    organics: b.organics?.length ? b.organics : a.organics,
    features: [...new Set([...(a.features ?? []), ...(b.features ?? [])])],
  };
}
