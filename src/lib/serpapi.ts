import type { Locale, SerpCallMeta } from "../shared/phrases.js";
import { requireSerpapiKey } from "./env.js";
import { log } from "./log.js";

const TIMEOUT_MS = Number(process.env.PHRASES_SERPAPI_TIMEOUT_MS) || 45_000;
const RETRIES = 2;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function describeSerpError(err: unknown): string {
  const name = err instanceof Error ? err.name : "";
  const message = err instanceof Error ? err.message : String(err ?? "SerpAPI request failed");
  if (
    name === "TimeoutError" ||
    name === "AbortError" ||
    /aborted due to timeout/i.test(message)
  ) {
    return `SerpAPI timed out after ${TIMEOUT_MS}ms`;
  }
  return message;
}

function isRetryable(err: unknown): boolean {
  const message = describeSerpError(err);
  return /timed out|ECONNRESET|EAI_AGAIN|fetch failed/i.test(message);
}

const ENDPOINT = "https://serpapi.com/search.json";

export interface SerpResponse {
  error?: string;
  search_metadata?: {
    id?: string;
    status?: string;
    created_at?: string;
    total_time_taken?: number;
  };
  search_information?: {
    autocomplete_results_state?: string;
  };
  suggestions?: Array<{
    value?: string;
    relevance?: number;
    type?: string;
  }>;
  related_searches?: Array<{
    query?: string;
  }>;
  related_questions?: Array<{
    question?: string;
    snippet?: string;
    title?: string;
    link?: string;
    displayed_link?: string;
    type?: string;
    page_token?: string;
    next_page_token?: string;
  }>;
  organic_results?: Array<{
    position?: number;
    title?: string;
    link?: string;
    snippet?: string;
    source?: string;
  }>;
  answer_box?: Record<string, unknown>;
  ai_overview?: Record<string, unknown>;
}

export interface SerpHit {
  response: SerpResponse;
  meta: SerpCallMeta;
}

function asMeta(
  engine: string,
  query: string,
  response: SerpResponse,
  resultCount: number
): SerpCallMeta {
  const md = response.search_metadata;
  return {
    engine,
    query,
    status: md?.status ?? (response.error ? "error" : null),
    searchId: md?.id ?? null,
    createdAt: md?.created_at ?? null,
    totalTimeTaken: md?.total_time_taken ?? null,
    resultCount,
  };
}

export async function serpapiSearch(
  params: Record<string, string | number | undefined>
): Promise<SerpResponse> {
  const api_key = requireSerpapiKey();
  const url = new URL(ENDPOINT);
  url.searchParams.set("api_key", api_key);
  for (const [key, value] of Object.entries(params)) {
    if (value == null || value === "") continue;
    url.searchParams.set(key, String(value));
  }

  let last: unknown;
  for (let attempt = 1; attempt <= RETRIES + 1; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
      const body = (await res.json()) as SerpResponse;
      if (!res.ok && !body.error) {
        throw new Error(`SerpAPI HTTP ${res.status}`);
      }
      if (body.error) {
        throw new Error(body.error);
      }
      return body;
    } catch (err) {
      last = err;
      const message = describeSerpError(err);
      if (!isRetryable(err) || attempt > RETRIES) {
        throw new Error(
          `${message} (${String(params.engine ?? "search")}${
            params.q ? ` q=${params.q}` : ""
          })`
        );
      }
      log.warn(
        { attempt, engine: params.engine, q: params.q },
        `serpapi retry after ${message}`
      );
      await sleep(1000 * attempt);
    }
  }
  throw new Error(describeSerpError(last));
}

export async function fetchAutocomplete(
  query: string,
  locale: Locale
): Promise<SerpHit> {
  const response = await serpapiSearch({
    engine: "google_autocomplete",
    q: query,
    hl: locale.hl,
    client: "chrome",
    json_restrictor: "search_metadata,search_information,suggestions",
  });
  return {
    response,
    meta: asMeta(
      "google_autocomplete",
      query,
      response,
      response.suggestions?.length ?? 0
    ),
  };
}

export async function fetchGoogleSerp(
  query: string,
  locale: Locale,
  options: { noCache?: boolean; num?: number } = {}
): Promise<SerpHit> {
  const response = await serpapiSearch({
    engine: "google",
    q: query,
    gl: locale.gl,
    hl: locale.hl,
    google_domain: locale.googleDomain,
    num: options.num,
    no_cache: options.noCache ? "true" : undefined,
    json_restrictor:
      "search_metadata,search_parameters,organic_results,related_searches,related_questions,answer_box,ai_overview",
  });
  const resultCount =
    (response.organic_results?.length ?? 0) +
    (response.related_searches?.length ?? 0) +
    (response.related_questions?.length ?? 0);
  return {
    response,
    meta: asMeta("google", query, response, resultCount),
  };
}

export async function fetchRelatedQuestions(
  nextPageToken: string,
  query: string
): Promise<SerpHit> {
  const response = await serpapiSearch({
    engine: "google_related_questions",
    next_page_token: nextPageToken,
    json_restrictor:
      "search_metadata,related_questions,organic_results,answer_box,ai_overview",
  });
  return {
    response,
    meta: asMeta(
      "google_related_questions",
      query,
      response,
      response.related_questions?.length ?? 0
    ),
  };
}

export async function fetchAiOverview(
  pageToken: string,
  query: string
): Promise<SerpHit> {
  const response = await serpapiSearch({
    engine: "google_ai_overview",
    page_token: pageToken,
    json_restrictor: "search_metadata,ai_overview",
  });
  return {
    response,
    meta: asMeta("google_ai_overview", query, response, 1),
  };
}

export async function mapPool<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let cursor = 0;
  const workers = Array.from(
    { length: Math.min(Math.max(1, limit), items.length || 1) },
    async () => {
      while (cursor < items.length) {
        const index = cursor++;
        out[index] = await fn(items[index]);
      }
    }
  );
  await Promise.all(workers);
  return out;
}
