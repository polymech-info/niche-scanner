import fs from "node:fs/promises";
import path from "node:path";
import type { Locale, SiteMeta } from "../shared/phrases.js";
import { normalizePhrase } from "../shared/phrases.js";
import type {
  ProductJob,
  ProductJobDiscovery,
  ProductPlanDecision,
  ProductPlanEvidence,
} from "../shared/product-plan.js";

export interface ProductPlanCacheFlags {
  forceDiscover?: boolean;
  forceDecide?: boolean;
  forceExpand?: boolean;
  forceQualify?: boolean;
  forceEnrich?: boolean;
}

export interface DiscoveryCacheEntry {
  key: {
    jobId: string;
    serpCallsPerJob: 2 | 4;
    locale: Locale;
    seeds: string[];
  };
  cachedAt: string;
  job: ProductJob;
  phrases: ProductJobDiscovery["phrases"];
  landscape: ProductJobDiscovery["landscape"];
}

export interface DecideCacheEntry {
  digest: string;
  cachedAt: string;
  decisions: Record<string, ProductPlanDecision>;
}

export interface ExpandFill {
  seeds: string[];
  notThis: string[];
}

export interface ExpandCacheEntry {
  digest: string;
  cachedAt: string;
  fills: Record<string, ExpandFill>;
}

export const QUALIFY_CACHE_VERSION = 2;

export interface QualifyCacheEntry {
  key: {
    version: number;
    jobId: string;
    canonicalQuery: string;
    locale: Locale;
  };
  cachedAt: string;
  evidence: ProductPlanEvidence;
}

export interface EnrichCacheEntry {
  key: {
    jobId: string;
    urls: string[];
    enrichers: string[];
  };
  cachedAt: string;
  sites: Record<string, SiteMeta>;
}

export function productPlanCacheDir(outDir: string): string {
  return path.join(outDir, ".cache");
}

function safeName(jobId: string): string {
  return jobId.replace(/[^a-z0-9._-]+/gi, "_");
}

function discoveryPath(cacheDir: string, jobId: string): string {
  return path.join(cacheDir, "discover", `${safeName(jobId)}.json`);
}

function decidePath(cacheDir: string): string {
  return path.join(cacheDir, "decide.json");
}

function expandPath(cacheDir: string): string {
  return path.join(cacheDir, "expand.json");
}

function qualifyPath(cacheDir: string, jobId: string): string {
  return path.join(cacheDir, "qualify", `${safeName(jobId)}.json`);
}

function enrichPath(cacheDir: string, jobId: string): string {
  return path.join(cacheDir, "enrich", `${safeName(jobId)}.json`);
}

async function unlinkQuiet(file: string): Promise<void> {
  try {
    await fs.unlink(file);
  } catch {
    // Cache files are optional.
  }
}

export async function deleteJobStageCache(
  cacheDir: string,
  jobId: string
): Promise<void> {
  if (!cacheDir) return;
  await Promise.all([
    unlinkQuiet(discoveryPath(cacheDir, jobId)),
    unlinkQuiet(qualifyPath(cacheDir, jobId)),
    unlinkQuiet(enrichPath(cacheDir, jobId)),
  ]);
}

export async function deleteDecideCache(cacheDir: string): Promise<void> {
  if (!cacheDir) return;
  await unlinkQuiet(decidePath(cacheDir));
}

export async function deleteExpandCache(cacheDir: string): Promise<void> {
  if (!cacheDir) return;
  await unlinkQuiet(expandPath(cacheDir));
}

export async function deletePlanCache(cacheDir: string): Promise<void> {
  if (!cacheDir) return;
  await fs.rm(cacheDir, { recursive: true, force: true });
}

export function serpOnlyEvidence(
  evidence: ProductPlanEvidence
): ProductPlanEvidence {
  return {
    query: evidence.query,
    organics: evidence.organics,
    ...(evidence.aiOverview ? { aiOverview: evidence.aiOverview } : {}),
  };
}

export function organicUrls(evidence: ProductPlanEvidence): string[] {
  return [...new Set(evidence.organics.map((row) => row.link))].sort();
}

function discoveryKey(
  job: ProductJob,
  serpCallsPerJob: 2 | 4,
  locale: Locale,
  seeds: string[]
): DiscoveryCacheEntry["key"] {
  return {
    jobId: job.id,
    serpCallsPerJob,
    locale,
    seeds,
  };
}

function localeEquals(a: Locale, b: Locale): boolean {
  return (
    a.gl === b.gl && a.hl === b.hl && a.googleDomain === b.googleDomain
  );
}

export function expandDigest(jobs: ProductJob[]): string {
  return jobs
    .map(
      (job) =>
        `${job.id}:${job.summary ?? ""}:${job.command ?? ""}:${(job.seeds ?? []).join("|")}`
    )
    .sort()
    .join(";");
}

export function discoveryDigest(
  discoveries: ProductJobDiscovery[]
): string {
  return discoveries
    .map(
      (row) =>
        `${row.job.id}:${row.phrases
          .map((p) => normalizePhrase(p.phrase))
          .sort()
          .join("|")}`
    )
    .sort()
    .join(";");
}

export async function readDiscoveryCache(
  cacheDir: string,
  job: ProductJob,
  serpCallsPerJob: 2 | 4,
  locale: Locale,
  seeds: string[]
): Promise<ProductJobDiscovery | null> {
  const file = discoveryPath(cacheDir, job.id);
  try {
    const raw = JSON.parse(await fs.readFile(file, "utf8")) as DiscoveryCacheEntry;
    const want = discoveryKey(job, serpCallsPerJob, locale, seeds);
    if (JSON.stringify(raw.key) !== JSON.stringify(want)) return null;
    return {
      job: raw.job,
      phrases: raw.phrases,
      landscape: raw.landscape,
    };
  } catch {
    return null;
  }
}

export async function writeDiscoveryCache(
  cacheDir: string,
  discovery: ProductJobDiscovery,
  serpCallsPerJob: 2 | 4,
  locale: Locale,
  seeds: string[]
): Promise<void> {
  const dir = path.join(cacheDir, "discover");
  await fs.mkdir(dir, { recursive: true });
  const entry: DiscoveryCacheEntry = {
    key: discoveryKey(discovery.job, serpCallsPerJob, locale, seeds),
    cachedAt: new Date().toISOString(),
    job: discovery.job,
    phrases: discovery.phrases,
    landscape: discovery.landscape,
  };
  await fs.writeFile(
    discoveryPath(cacheDir, discovery.job.id),
    `${JSON.stringify(entry, null, 2)}\n`,
    "utf8"
  );
}

export async function readDecideCache(
  cacheDir: string,
  digest: string
): Promise<ReadonlyMap<string, ProductPlanDecision> | null> {
  try {
    const raw = JSON.parse(await fs.readFile(decidePath(cacheDir), "utf8")) as DecideCacheEntry;
    if (raw.digest !== digest) return null;
    return new Map(Object.entries(raw.decisions));
  } catch {
    return null;
  }
}

export async function readExpandCache(
  cacheDir: string,
  digest: string
): Promise<Record<string, ExpandFill> | null> {
  try {
    const raw = JSON.parse(await fs.readFile(expandPath(cacheDir), "utf8")) as ExpandCacheEntry;
    if (raw.digest !== digest) return null;
    return raw.fills;
  } catch {
    return null;
  }
}

export async function writeExpandCache(
  cacheDir: string,
  digest: string,
  fills: Record<string, ExpandFill>
): Promise<void> {
  await fs.mkdir(cacheDir, { recursive: true });
  const entry: ExpandCacheEntry = {
    digest,
    cachedAt: new Date().toISOString(),
    fills,
  };
  await fs.writeFile(expandPath(cacheDir), `${JSON.stringify(entry, null, 2)}\n`, "utf8");
}

export async function writeDecideCache(
  cacheDir: string,
  digest: string,
  decisions: ReadonlyMap<string, ProductPlanDecision>
): Promise<void> {
  await fs.mkdir(cacheDir, { recursive: true });
  const entry: DecideCacheEntry = {
    digest,
    cachedAt: new Date().toISOString(),
    decisions: Object.fromEntries(decisions.entries()),
  };
  await fs.writeFile(decidePath(cacheDir), `${JSON.stringify(entry, null, 2)}\n`, "utf8");
}

export async function readQualifyCache(
  cacheDir: string,
  jobId: string,
  canonicalQuery: string,
  locale: Locale
): Promise<ProductPlanEvidence | null> {
  try {
    const raw = JSON.parse(
      await fs.readFile(qualifyPath(cacheDir, jobId), "utf8")
    ) as QualifyCacheEntry;
    const want: QualifyCacheEntry["key"] = {
      version: QUALIFY_CACHE_VERSION,
      jobId,
      canonicalQuery: normalizePhrase(canonicalQuery),
      locale,
    };
    if (
      raw.key.version !== want.version ||
      raw.key.jobId !== want.jobId ||
      normalizePhrase(raw.key.canonicalQuery) !== want.canonicalQuery ||
      !localeEquals(raw.key.locale, want.locale)
    ) {
      return null;
    }
    return serpOnlyEvidence(raw.evidence);
  } catch {
    return null;
  }
}

export async function writeQualifyCache(
  cacheDir: string,
  jobId: string,
  canonicalQuery: string,
  locale: Locale,
  evidence: ProductPlanEvidence
): Promise<void> {
  const dir = path.join(cacheDir, "qualify");
  await fs.mkdir(dir, { recursive: true });
  const entry: QualifyCacheEntry = {
    key: {
      version: QUALIFY_CACHE_VERSION,
      jobId,
      canonicalQuery: normalizePhrase(canonicalQuery),
      locale,
    },
    cachedAt: new Date().toISOString(),
    evidence: serpOnlyEvidence(evidence),
  };
  await fs.writeFile(
    qualifyPath(cacheDir, jobId),
    `${JSON.stringify(entry, null, 2)}\n`,
    "utf8"
  );
}

export async function readEnrichCache(
  cacheDir: string,
  jobId: string,
  urls: string[],
  enrichers: string[]
): Promise<Record<string, SiteMeta> | null> {
  try {
    const raw = JSON.parse(
      await fs.readFile(enrichPath(cacheDir, jobId), "utf8")
    ) as EnrichCacheEntry;
    const wantUrls = [...urls].sort();
    const wantEnrichers = [...enrichers].sort();
    if (
      raw.key.jobId !== jobId ||
      JSON.stringify(raw.key.urls) !== JSON.stringify(wantUrls) ||
      JSON.stringify(raw.key.enrichers) !== JSON.stringify(wantEnrichers)
    ) {
      return null;
    }
    return raw.sites;
  } catch {
    return null;
  }
}

export async function writeEnrichCache(
  cacheDir: string,
  jobId: string,
  urls: string[],
  enrichers: string[],
  sites: Record<string, SiteMeta>
): Promise<void> {
  const dir = path.join(cacheDir, "enrich");
  await fs.mkdir(dir, { recursive: true });
  const entry: EnrichCacheEntry = {
    key: {
      jobId,
      urls: [...urls].sort(),
      enrichers: [...enrichers].sort(),
    },
    cachedAt: new Date().toISOString(),
    sites,
  };
  await fs.writeFile(
    enrichPath(cacheDir, jobId),
    `${JSON.stringify(entry, null, 2)}\n`,
    "utf8"
  );
}
