import { randomBytes } from "node:crypto";
import type { ProductCapabilitySnapshot, ProductMatch } from "../shared/capabilities.js";
import { resolveCapability } from "../shared/capabilities.js";
import type { ProductProfile } from "../shared/config.js";
import type {
  CreateOpportunityInput,
  OpportunityCandidate,
  OpportunityRun,
  PromoteOpportunityInput,
} from "../shared/opportunities.js";
import {
  DEFAULT_LOCALE,
  DEFAULT_OPTIONS,
  normalizePhrase,
  type DiscoverOptions,
  type SearchDocument,
} from "../shared/phrases.js";
import { loadAppConfig } from "./app-config.js";
import { loadCapabilitySnapshot } from "./capabilities.js";
import { discoverPhrases, type DiscoverResult } from "./discover.js";
import {
  getStore,
  makeId,
  mergeLandscape,
  mergePhrases,
  uniqueSeeds,
} from "./run.js";
import type { SearchStore } from "./store.js";

const DEFAULT_BUDGET = 4;
const MAX_BUDGET = 12;
const DEFAULT_TTL_MS = 60 * 60 * 1000;
const SUPPORTED_FITS = new Set(["direct", "composed", "editorial"]);

export interface OpportunityDiscoveryDependencies {
  discover?: typeof discoverPhrases;
  loadSnapshot?: typeof loadCapabilitySnapshot;
  loadSettings?: typeof loadAppConfig;
  now?: () => Date;
  makeId?: () => string;
  ttlMs?: number;
}

function unique(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const normalized = normalizePhrase(value);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

function naturalLabel(value: string): string {
  return normalizePhrase(value)
    .replace(/[._:/-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function normalizeOpportunityBudget(value?: number): number {
  const requested = Number.isFinite(value) ? Math.floor(value!) : DEFAULT_BUDGET;
  const bounded = Math.max(2, Math.min(MAX_BUDGET, requested));
  return bounded - (bounded % 2);
}

export function opportunityVariations(
  query: string,
  match: ProductMatch,
  snapshot: ProductCapabilitySnapshot,
  limit: number
): string[] {
  const nodes = match.nodeIds
    .map((id) => snapshot.capabilities.find((node) => node.id === id))
    .filter((node): node is ProductCapabilitySnapshot["capabilities"][number] =>
      Boolean(node)
    );
  const workflow = match.workflowId
    ? snapshot.workflows.find((item) => item.id === match.workflowId)
    : undefined;
  const capabilityPhrases = nodes.flatMap((node) => [
    naturalLabel(node.label),
    `how to ${naturalLabel(node.label)}`,
    ...node.terms
      .map(naturalLabel)
      .filter((term) => term.split(" ").length >= 2)
      .map((term) => `how to ${term}`),
  ]);
  const variants = unique([
    query,
    ...match.followUps,
    workflow ? naturalLabel(workflow.label) : "",
    ...capabilityPhrases,
  ]);
  return variants.slice(0, Math.max(1, limit));
}

function candidateRank(
  phrase: string,
  query: string,
  match: ProductMatch,
  niche: number
): number {
  const fitBoost = match.fit === "direct" ? 20 : match.fit === "composed" ? 16 : 8;
  const queryBoost = normalizePhrase(phrase) === normalizePhrase(query) ? 8 : 0;
  return Math.round(
    Math.min(100, niche * 0.55 + match.confidence * 25 + fitBoost + queryBoost)
  );
}

export function rankOpportunityCandidates(
  query: string,
  result: DiscoverResult,
  snapshot: ProductCapabilitySnapshot,
  product: ProductProfile | null
): OpportunityCandidate[] {
  return result.phrases
    .map((record) => {
      const productMatch = resolveCapability(record.phrase, snapshot, product);
      return {
        phrase: record.phrase,
        record,
        productMatch,
        rank: candidateRank(
          record.phrase,
          query,
          productMatch,
          record.scores.niche
        ),
      };
    })
    .filter((candidate) => SUPPORTED_FITS.has(candidate.productMatch.fit))
    .sort(
      (a, b) =>
        b.rank - a.rank ||
        b.record.scores.niche - a.record.scores.niche ||
        a.phrase.localeCompare(b.phrase)
    );
}

export async function discoverOpportunity(
  input: CreateOpportunityInput,
  deps: OpportunityDiscoveryDependencies = {}
): Promise<OpportunityRun> {
  const query = normalizePhrase(input.query);
  if (!query) throw new Error("A discovery query is required");

  const [settings, snapshot] = await Promise.all([
    (deps.loadSettings ?? loadAppConfig)(),
    (deps.loadSnapshot ?? loadCapabilitySnapshot)(),
  ]);
  const productMatch = resolveCapability(query, snapshot, settings.product);
  const budget = normalizeOpportunityBudget(input.serpBudget);
  const planned = SUPPORTED_FITS.has(productMatch.fit) ? budget : 0;
  const variations = planned
    ? opportunityVariations(query, productMatch, snapshot, planned / 2)
    : [query];
  const locale = { ...DEFAULT_LOCALE, ...input.locale };
  const options: DiscoverOptions = {
    engines: ["autocomplete", "related_searches", "people_also_ask"],
    paaDepth: 0,
    alphabet: false,
    questionPrefixes: false,
  };
  const result: DiscoverResult = planned
    ? await (deps.discover ?? discoverPhrases)(variations, locale, options)
    : { phrases: [], landscape: [], meta: { calls: [], errors: [] } };
  const now = (deps.now ?? (() => new Date()))();
  const expiresAt = new Date(
    now.getTime() + (deps.ttlMs ?? DEFAULT_TTL_MS)
  ).toISOString();

  return {
    id: (deps.makeId ?? (() => `opportunity-${randomBytes(5).toString("hex")}`))(),
    status: "ready",
    query,
    createdAt: now.toISOString(),
    expiresAt,
    locale,
    productMatch,
    variations,
    candidates: rankOpportunityCandidates(
      query,
      result,
      snapshot,
      settings.product
    ),
    landscape: result.landscape,
    calls: result.meta.calls,
    errors: result.meta.errors,
    budget: {
      requested: budget,
      planned,
      attempted: result.meta.calls.length + result.meta.errors.length,
    },
  };
}

export async function promoteOpportunity(
  run: OpportunityRun,
  input: PromoteOpportunityInput,
  store?: SearchStore,
  now = new Date()
): Promise<SearchDocument> {
  const selectedKeys = new Set(input.phrases.map(normalizePhrase).filter(Boolean));
  if (!selectedKeys.size) throw new Error("Select at least one candidate to promote");
  const selected = run.candidates.filter((candidate) =>
    selectedKeys.has(normalizePhrase(candidate.phrase))
  );
  if (selected.length !== selectedKeys.size) {
    throw new Error("One or more selected candidates are not part of this run");
  }

  const db = getStore(store);
  const settings = await loadAppConfig();
  const promotedAt = now.toISOString();
  const matches = Object.fromEntries(
    selected.map((candidate) => [
      normalizePhrase(candidate.phrase),
      candidate.productMatch,
    ])
  );
  const phrases = selected.map((candidate) => candidate.record);

  if (input.targetSearchId) {
    const current = await db.get(input.targetSearchId);
    return db.save({
      ...current,
      updatedAt: promotedAt,
      seeds: uniqueSeeds([...current.seeds, run.query]),
      phrases: mergePhrases(current.phrases, phrases, settings.blacklist),
      landscape: mergeLandscape(current.landscape, run.landscape),
      opportunity: {
        runId: run.id,
        query: run.query,
        promotedAt,
        matches: { ...(current.opportunity?.matches ?? {}), ...matches },
      },
      meta: {
        calls: [...current.meta.calls, ...run.calls],
        errors: [...current.meta.errors, ...run.errors],
      },
    });
  }

  const name = input.name?.trim() || run.query;
  const doc: SearchDocument = {
    id: makeId(name),
    name,
    createdAt: promotedAt,
    updatedAt: promotedAt,
    locale: run.locale,
    seeds: [run.query],
    options: {
      ...DEFAULT_OPTIONS,
      paaDepth: 0,
      alphabet: false,
      questionPrefixes: false,
    },
    phrases: mergePhrases([], phrases, settings.blacklist),
    landscape: run.landscape,
    opportunity: {
      runId: run.id,
      query: run.query,
      promotedAt,
      matches,
    },
    meta: { calls: run.calls, errors: run.errors },
  };
  return db.save(doc);
}
