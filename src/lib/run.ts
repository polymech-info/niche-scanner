import { randomBytes } from "crypto";
import type {
  DiscoverOptions,
  Locale,
  PhraseRecord,
  SearchDocument,
  SerpLandscape,
} from "../shared/phrases.js";
import {
  DEFAULT_LOCALE,
  DEFAULT_OPTIONS,
  normalizePhrase,
} from "../shared/phrases.js";
import { classForPhrase, classifyPhrase } from "../shared/classify.js";
import { loadAppConfig } from "./app-config.js";
import { findSearchForSeed } from "../shared/neighbors.js";
import { discoverPhrases } from "./discover.js";
import { resolvedSearchesDir } from "./env.js";
import { rescore, scorePhrase } from "./score.js";
import { landscapeFrom, mergeSerp, parseQuestions, serpFromHit } from "./serp-parse.js";
import { fetchGoogleSerp, mapPool } from "./serpapi.js";
import { SearchStore } from "./store.js";

export interface RunSearchInput {
  seeds: string[];
  name?: string;
  locale?: Partial<Locale>;
  options?: Partial<DiscoverOptions>;
  parentId?: string;
  store?: SearchStore;
}

export interface ExpandSearchInput {
  id: string;
  seeds?: string[];
  options?: Partial<DiscoverOptions>;
  store?: SearchStore;
}

function slugify(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "search"
  );
}

export function makeId(name: string): string {
  return `${slugify(name)}-${randomBytes(3).toString("hex")}`;
}

export function uniqueSeeds(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const next = value.replace(/\s+/g, " ").trim();
    const key = next.toLowerCase();
    if (!next || seen.has(key)) continue;
    seen.add(key);
    out.push(next);
  }
  return out;
}

export function mergePhrases(
  existing: PhraseRecord[],
  incoming: PhraseRecord[],
  blacklist: readonly string[] = []
): PhraseRecord[] {
  const map = new Map<string, PhraseRecord>();
  for (const phrase of existing) {
    map.set(normalizePhrase(phrase.phrase), phrase);
  }
  for (const phrase of incoming) {
    const key = normalizePhrase(phrase.phrase);
    const prev = map.get(key);
    if (!prev) {
      map.set(key, {
        ...phrase,
        class: classForPhrase(phrase.phrase, phrase.class, blacklist),
      });
      continue;
    }
    const sources = [...new Set([...prev.sources, ...phrase.sources])];
    const seeds = [...new Set([...prev.seeds, ...phrase.seeds])];
    const merged: PhraseRecord = {
      ...prev,
      sources,
      seeds,
      class: classForPhrase(prev.phrase, prev.class ?? phrase.class, blacklist),
      serp: mergeSerp(prev.serp, phrase.serp),
    };
    map.set(key, rescore(merged));
  }
  return [...map.values()].sort(
    (a, b) => b.scores.niche - a.scores.niche || a.phrase.localeCompare(b.phrase)
  );
}

export function getStore(store?: SearchStore): SearchStore {
  return store ?? new SearchStore(resolvedSearchesDir());
}

export async function createSearch(
  input: RunSearchInput
): Promise<SearchDocument> {
  const seeds = uniqueSeeds(input.seeds);
  if (!seeds.length) throw new Error("At least one seed keyword is required");

  const locale: Locale = { ...DEFAULT_LOCALE, ...input.locale };
  const options: DiscoverOptions = {
    ...DEFAULT_OPTIONS,
    ...input.options,
    engines: input.options?.engines ?? DEFAULT_OPTIONS.engines,
  };
  const name = input.name?.trim() || seeds.join(", ");
  const found = await discoverPhrases(seeds, locale, options);
  const now = new Date().toISOString();
  const doc: SearchDocument = {
    id: makeId(name),
    name,
    createdAt: now,
    updatedAt: now,
    locale,
    seeds,
    options,
    phrases: found.phrases,
    landscape: found.landscape,
    parentId: input.parentId,
    meta: found.meta,
  };
  return getStore(input.store).save(doc);
}

export function mergeLandscape(
  existing: SerpLandscape[] | undefined,
  incoming: SerpLandscape[]
): SerpLandscape[] {
  const map = new Map<string, SerpLandscape>();
  for (const row of [...(existing ?? []), ...incoming]) {
    const prev = map.get(row.query);
    if (!prev || row.organics.length > prev.organics.length) map.set(row.query, row);
  }
  return [...map.values()];
}

export async function expandSearch(
  input: ExpandSearchInput
): Promise<SearchDocument> {
  const store = getStore(input.store);
  const current = await store.get(input.id);
  const extraSeeds = uniqueSeeds(input.seeds ?? []);
  const seeds = extraSeeds.length ? extraSeeds : current.seeds;
  const options: DiscoverOptions = {
    ...current.options,
    ...input.options,
    engines: input.options?.engines ?? current.options.engines,
  };
  const found = await discoverPhrases(seeds, current.locale, options);
  const { blacklist } = await loadAppConfig();
  const next: SearchDocument = {
    ...current,
    updatedAt: new Date().toISOString(),
    seeds: uniqueSeeds([...current.seeds, ...seeds]),
    options,
    phrases: mergePhrases(current.phrases, found.phrases, blacklist),
    landscape: mergeLandscape(current.landscape, found.landscape),
    meta: {
      calls: [...current.meta.calls, ...found.meta.calls],
      errors: [...current.meta.errors, ...found.meta.errors],
    },
  };
  return store.save(next);
}

export interface QualifySearchInput {
  id: string;
  limit?: number;
  questionsOnly?: boolean;
  store?: SearchStore;
}

function pickQualifyTargets(
  doc: SearchDocument,
  limit: number,
  questionsOnly: boolean,
  blacklist: readonly string[] = []
) {
  const ranked = [...doc.phrases]
    .map((phrase) => ({
      phrase,
      class: classForPhrase(phrase.phrase, phrase.class, blacklist),
    }))
    .filter(({ class: cls }) => cls.role !== "skip")
    .filter(({ phrase }) => !(phrase.serp?.organics && phrase.serp.organics.length))
    .sort((a, b) => {
      const rank = (role: string) =>
        role === "write" ? 0 : role === "faq" ? 1 : 2;
      if (questionsOnly) {
        return Number(b.phrase.scores.isQuestion) - Number(a.phrase.scores.isQuestion);
      }
      return rank(a.class.role) - rank(b.class.role) || b.phrase.scores.niche - a.phrase.scores.niche;
    });
  const picked = questionsOnly
    ? ranked.filter(({ phrase }) => phrase.scores.isQuestion)
    : ranked;
  return picked.slice(0, limit).map(({ phrase }) => phrase);
}

export async function qualifySearch(
  input: QualifySearchInput
): Promise<SearchDocument> {
  const store = getStore(input.store);
  const current = await store.get(input.id);
  const { blacklist } = await loadAppConfig();
  const limit = input.limit ?? 6;
  const targets = pickQualifyTargets(
    current,
    limit,
    Boolean(input.questionsOnly),
    blacklist
  );
  if (!targets.length) return current;

  const meta = {
    calls: [...current.meta.calls],
    errors: [...current.meta.errors],
  };
  const incoming: PhraseRecord[] = [];
  const landscapes: SerpLandscape[] = [];

  if (!current.landscape?.length && current.seeds[0]) {
    try {
      const hit = await fetchGoogleSerp(current.seeds[0], current.locale);
      meta.calls.push(hit.meta);
      landscapes.push(landscapeFrom(hit));
    } catch (err) {
      meta.errors.push({
        engine: "google",
        query: current.seeds[0],
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  await mapPool(targets, 2, async (target) => {
    try {
      const hit = await fetchGoogleSerp(target.phrase, current.locale);
      meta.calls.push(hit.meta);
      landscapes.push(landscapeFrom(hit));
      const parsed = parseQuestions(hit.response);
      const self = parsed.find(
        (q) => normalizePhrase(q.question) === normalizePhrase(target.phrase)
      );
      incoming.push({
        ...target,
        class: classForPhrase(target.phrase, target.class, blacklist),
        serp: mergeSerp(
          target.serp,
          serpFromHit(hit, { answer: self?.answer })
        ),
      });
      for (const extra of parsed) {
        incoming.push({
          phrase: normalizePhrase(extra.question),
          sources: ["people_also_ask"],
          seeds: target.seeds,
          scores: scorePhrase({
            phrase: extra.question,
            sources: ["people_also_ask"],
          }),
          class: classifyPhrase(extra.question, blacklist),
          addedAt: new Date().toISOString(),
          serp: {
            engine: hit.meta.engine,
            searchId: hit.meta.searchId,
            answer: extra.answer,
            features: ["people_also_ask"],
          },
        });
      }
    } catch (err) {
      meta.errors.push({
        engine: "google",
        query: target.phrase,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  });

  const next: SearchDocument = {
    ...current,
    updatedAt: new Date().toISOString(),
    phrases: mergePhrases(current.phrases, incoming, blacklist),
    landscape: mergeLandscape(current.landscape, landscapes),
    meta,
  };
  return store.save(next);
}

export async function addManualPhrase(
  id: string,
  phrase: string,
  store?: SearchStore
): Promise<SearchDocument> {
  const db = getStore(store);
  const current = await db.get(id);
  const { blacklist } = await loadAppConfig();
  const clean = normalizePhrase(phrase);
  if (!clean) throw new Error("Phrase is empty");
  if (current.phrases.some((row) => normalizePhrase(row.phrase) === clean)) {
    throw new Error(`Already in this search: ${clean}`);
  }
  const record: PhraseRecord = {
    phrase: clean,
    sources: ["manual"],
    seeds: current.seeds,
    scores: scorePhrase({ phrase: clean, sources: ["manual"] }),
    class: classifyPhrase(clean, blacklist),
    addedAt: new Date().toISOString(),
    serp: null,
  };
  const next: SearchDocument = {
    ...current,
    updatedAt: new Date().toISOString(),
    phrases: mergePhrases(current.phrases, [record], blacklist),
  };
  return db.save(next);
}

export async function removePhrase(
  id: string,
  phrase: string,
  store?: SearchStore
): Promise<SearchDocument> {
  const db = getStore(store);
  const current = await db.get(id);
  const clean = normalizePhrase(phrase);
  if (!clean) throw new Error("Phrase is empty");
  const phrases = current.phrases.filter(
    (row) => normalizePhrase(row.phrase) !== clean
  );
  if (phrases.length === current.phrases.length) {
    throw new Error(`No such phrase: ${clean}`);
  }
  return db.save({
    ...current,
    updatedAt: new Date().toISOString(),
    phrases,
  });
}

export async function openNeighbor(input: {
  id: string;
  seed: string;
  store?: SearchStore;
}): Promise<{ parent: SearchDocument; child: SearchDocument }> {
  const store = getStore(input.store);
  const parent = await store.get(input.id);
  const seed = normalizePhrase(input.seed);
  if (!seed) throw new Error("Neighbor seed is empty");

  const listed = await store.list();
  const existing = findSearchForSeed(listed, seed);
  const child = existing
    ? await store.get(existing.id)
    : await createSearch({
        seeds: [seed],
        name: seed,
        locale: parent.locale,
        options: parent.options,
        parentId: parent.id,
        store,
      });

  const neighbors = (parent.neighbors ?? []).map((row) =>
    normalizePhrase(row.seed) === seed
      ? { ...row, searchId: child.id }
      : row
  );
  const linked = neighbors.some((row) => normalizePhrase(row.seed) === seed)
    ? neighbors
    : [
        ...neighbors,
        { seed, why: "", via: parent.seeds[0] ?? parent.name, kind: "related" as const, searchId: child.id },
      ];

  const nextParent = await store.save({
    ...parent,
    updatedAt: new Date().toISOString(),
    neighbors: linked,
  });
  return { parent: nextParent, child };
}

export async function listSearches(store?: SearchStore) {
  return getStore(store).list();
}

export async function getSearch(id: string, store?: SearchStore) {
  return getStore(store).get(id);
}

export async function deleteSearch(id: string, store?: SearchStore) {
  return getStore(store).delete(id);
}
