import type { AppSettings } from "../../shared/config";
import type {
  AppInfo,
  SearchDocument,
  SearchSummary,
  DiscoverOptions,
  Locale,
} from "../../shared/phrases";
import type {
  ArticlePackageMetrics,
  GenerateOptions,
} from "../../shared/brief";
import type {
  CreateOpportunityInput,
  OpportunityRun,
  PromoteOpportunityInput,
} from "../../shared/opportunities";
import type { ProductCapabilitySnapshot } from "../../shared/capabilities";
import type { CapabilityOverlay } from "../../shared/capability-overlay";
import type { ProductJob, ProductPlan } from "../../shared/product-plan";

const BASE = "";

async function readJson<T>(res: Response): Promise<T> {
  const data = (await res.json()) as T & { error?: string };
  if (!res.ok) {
    throw new Error(data.error || `${res.status} ${res.statusText}`);
  }
  return data;
}

export async function fetchConfig(): Promise<AppInfo> {
  const res = await fetch(`${BASE}/api/config`);
  return readJson<AppInfo>(res);
}

export async function fetchSettings(): Promise<AppSettings> {
  const res = await fetch(`${BASE}/api/settings`);
  return readJson<AppSettings>(res);
}

export async function addBlacklistWord(word: string): Promise<AppSettings> {
  const res = await fetch(`${BASE}/api/settings/blacklist`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ word }),
  });
  return readJson<AppSettings>(res);
}

export async function updateBlacklistWord(
  from: string,
  to: string
): Promise<AppSettings> {
  const res = await fetch(`${BASE}/api/settings/blacklist`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ from, to }),
  });
  return readJson<AppSettings>(res);
}

export async function saveSettings(settings: AppSettings): Promise<AppSettings> {
  const res = await fetch(`${BASE}/api/settings`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(settings),
  });
  return readJson<AppSettings>(res);
}

export async function removeBlacklistWord(word: string): Promise<AppSettings> {
  const res = await fetch(`${BASE}/api/settings/blacklist`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ word }),
  });
  return readJson<AppSettings>(res);
}

export async function fetchSearches(): Promise<SearchSummary[]> {
  const res = await fetch(`${BASE}/api/searches`);
  return readJson<SearchSummary[]>(res);
}

export async function fetchSearch(id: string): Promise<SearchDocument> {
  const res = await fetch(`${BASE}/api/searches/${encodeURIComponent(id)}`);
  return readJson<SearchDocument>(res);
}

export async function createSearch(input: {
  seeds: string[];
  name?: string;
  locale?: Partial<Locale>;
  options?: Partial<DiscoverOptions>;
}): Promise<SearchDocument> {
  const res = await fetch(`${BASE}/api/searches`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  return readJson<SearchDocument>(res);
}

export async function expandSearch(
  id: string,
  input: { seeds?: string[]; options?: Partial<DiscoverOptions> }
): Promise<SearchDocument> {
  const res = await fetch(
    `${BASE}/api/searches/${encodeURIComponent(id)}/expand`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    }
  );
  return readJson<SearchDocument>(res);
}

export async function qualifySearch(
  id: string,
  input: { limit?: number; questionsOnly?: boolean } = {}
): Promise<SearchDocument> {
  const res = await fetch(
    `${BASE}/api/searches/${encodeURIComponent(id)}/qualify`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    }
  );
  return readJson<SearchDocument>(res);
}

export interface GenerateOutput {
  dir: string;
  report: string;
  articles: string;
  markdown: string;
  options: GenerateOptions;
  metrics: ArticlePackageMetrics;
  hubs?: Array<{
    slug: string;
    h1: string;
    absorbs: number;
    fit: string;
    outcome: string;
    depthScore: number;
  }>;
}

export interface ReportOutput {
  exists: boolean;
  report: string;
  markdown?: string;
}

export async function fetchReport(id: string): Promise<ReportOutput> {
  const res = await fetch(
    `${BASE}/api/searches/${encodeURIComponent(id)}/report`
  );
  return readJson<ReportOutput>(res);
}

export interface EnrichOutput {
  doc: SearchDocument;
  fetched: number;
  cached: number;
  failed: number;
  skipped: number;
  aiFetched?: number;
  aiCached?: number;
  aiFailed?: number;
  aiSkipped?: number;
}

export async function enrichSearch(
  id: string,
  input: {
    enrichers?: string[] | string;
    limit?: number;
    force?: boolean;
  } = {}
): Promise<EnrichOutput> {
  const res = await fetch(
    `${BASE}/api/searches/${encodeURIComponent(id)}/enrich`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    }
  );
  return readJson<EnrichOutput>(res);
}

export interface DiscoverMoreOutput {
  doc: SearchDocument;
  hubs: number;
  neighbors: SearchDocument["neighbors"];
  cacheHits: number;
  transformed: number;
  fromCache: boolean;
}

export async function discoverMoreSearch(
  id: string,
  input: { force?: boolean; maxHubs?: number } = {}
): Promise<DiscoverMoreOutput> {
  const res = await fetch(
    `${BASE}/api/searches/${encodeURIComponent(id)}/discover-more`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    }
  );
  return readJson<DiscoverMoreOutput>(res);
}

export async function openNeighborSearch(
  id: string,
  seed: string
): Promise<{ parent: SearchDocument; child: SearchDocument }> {
  const res = await fetch(
    `${BASE}/api/searches/${encodeURIComponent(id)}/neighbors/open`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ seed }),
    }
  );
  return readJson<{ parent: SearchDocument; child: SearchDocument }>(res);
}

export async function generateSearch(
  id: string,
  input: { outDir?: string; options?: Partial<GenerateOptions> } = {}
): Promise<GenerateOutput> {
  const res = await fetch(
    `${BASE}/api/searches/${encodeURIComponent(id)}/generate`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    }
  );
  return readJson<GenerateOutput>(res);
}

export async function addPhrase(
  id: string,
  phrase: string
): Promise<SearchDocument> {
  const res = await fetch(
    `${BASE}/api/searches/${encodeURIComponent(id)}/phrases`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ phrase }),
    }
  );
  return readJson<SearchDocument>(res);
}

export async function removePhrase(
  id: string,
  phrase: string
): Promise<SearchDocument> {
  const res = await fetch(
    `${BASE}/api/searches/${encodeURIComponent(id)}/phrases`,
    {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ phrase }),
    }
  );
  return readJson<SearchDocument>(res);
}

export async function deleteSearch(id: string): Promise<void> {
  const res = await fetch(`${BASE}/api/searches/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
  await readJson<{ ok: boolean }>(res);
}

export async function createOpportunity(
  input: CreateOpportunityInput
): Promise<OpportunityRun> {
  const res = await fetch(`${BASE}/api/opportunities`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  return readJson<OpportunityRun>(res);
}

export async function fetchOpportunity(id: string): Promise<OpportunityRun> {
  const res = await fetch(
    `${BASE}/api/opportunities/${encodeURIComponent(id)}`
  );
  return readJson<OpportunityRun>(res);
}

export async function discardOpportunity(id: string): Promise<void> {
  const res = await fetch(
    `${BASE}/api/opportunities/${encodeURIComponent(id)}`,
    { method: "DELETE" }
  );
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
}

export interface CapabilityGrounding {
  path: string;
  generatedAt: string;
  product: string;
  overlay: CapabilityOverlay;
  counts: {
    capabilities: number;
    workflows: number;
    commands: number;
    blocks: number;
    surfaces: number;
    documentation: number;
    jobs: number;
    enabled: number;
    disabled: number;
    custom: number;
    customCommands: number;
  };
  capabilities: ProductCapabilitySnapshot["capabilities"];
  workflows: ProductCapabilitySnapshot["workflows"];
  jobs: ProductJob[];
}

export async function fetchCapabilities(): Promise<CapabilityGrounding> {
  const res = await fetch(`${BASE}/api/capabilities`);
  return readJson<CapabilityGrounding>(res);
}

export async function refreshCapabilities(stage: "capture" | "compile" | "refresh") {
  const res = await fetch(`${BASE}/api/capabilities/refresh`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ stage }),
  });
  return readJson<{
    stage: string;
    captured: { outDir: string; files: string[] } | null;
    compiled: { outputPath: string } | null;
    grounding: CapabilityGrounding;
  }>(res);
}

export async function setCapabilityAvailability(input: {
  enabled: boolean;
  ids?: string[];
  workflows?: string[];
}): Promise<CapabilityGrounding> {
  const res = await fetch(`${BASE}/api/capabilities`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      enabled: input.enabled,
      ids: input.ids,
      workflows: input.workflows,
    }),
  });
  return readJson<CapabilityGrounding>(res);
}

export async function setCapabilityEnabled(
  id: string,
  enabled: boolean
): Promise<CapabilityGrounding> {
  const res = await fetch(
    `${BASE}/api/capabilities/${encodeURIComponent(id)}`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled }),
    }
  );
  return readJson<CapabilityGrounding>(res);
}

export async function setWorkflowEnabled(
  id: string,
  enabled: boolean
): Promise<CapabilityGrounding> {
  const res = await fetch(
    `${BASE}/api/capabilities/workflows/${encodeURIComponent(id)}`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled }),
    }
  );
  return readJson<CapabilityGrounding>(res);
}

export async function saveCapabilityOverride(
  id: string,
  input: { description?: string; terms?: string }
): Promise<CapabilityGrounding> {
  const res = await fetch(
    `${BASE}/api/capabilities/${encodeURIComponent(id)}/override`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    }
  );
  return readJson<CapabilityGrounding>(res);
}

export async function deleteCapabilityOverride(
  id: string
): Promise<CapabilityGrounding> {
  const res = await fetch(
    `${BASE}/api/capabilities/${encodeURIComponent(id)}/override`,
    { method: "DELETE" }
  );
  return readJson<CapabilityGrounding>(res);
}

export async function saveCustomCapability(input: {
  id?: string;
  kind?: string;
  label: string;
  description?: string;
  terms?: string;
  inputs?: string;
  outputs?: string;
}): Promise<CapabilityGrounding> {
  const path = input.id
    ? `${BASE}/api/capabilities/custom/${encodeURIComponent(input.id)}`
    : `${BASE}/api/capabilities/custom`;
  const res = await fetch(path, {
    method: input.id ? "PATCH" : "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  return readJson<CapabilityGrounding>(res);
}

export async function deleteCustomCapability(
  id: string
): Promise<CapabilityGrounding> {
  const res = await fetch(
    `${BASE}/api/capabilities/custom/${encodeURIComponent(id)}`,
    { method: "DELETE" }
  );
  return readJson<CapabilityGrounding>(res);
}

export interface ProductPlanLogEvent {
  at: string;
  level: "info" | "warn" | "error";
  stage: string;
  jobId?: string;
  message: string;
}

export interface ProductPlanRunStatus {
  status: "idle" | "running" | "ok" | "error";
  startedAt: string | null;
  finishedAt: string | null;
  outDir: string;
  jobs: number;
  current: { stage: string; jobId?: string; label?: string } | null;
  events: ProductPlanLogEvent[];
  error?: string;
}

export interface ProductPlanRun {
  plan: ProductPlan | null;
  markdown: string;
  outDir: string;
  run?: ProductPlanRunStatus;
}

export async function fetchProductPlan(): Promise<ProductPlanRun> {
  const res = await fetch(`${BASE}/api/product-plan`);
  return readJson<ProductPlanRun>(res);
}

export async function runProductPlan(input: {
  jobIds?: string[];
  maxJobs?: number;
  serpCallsPerJob?: 2 | 4;
  expand?: boolean;
  decide?: boolean;
  qualify?: boolean;
  enrich?: boolean;
  force?: boolean;
  forceDiscover?: boolean;
  forceExpand?: boolean;
  forceDecide?: boolean;
  forceQualify?: boolean;
  forceEnrich?: boolean;
}): Promise<ProductPlanRun> {
  const res = await fetch(`${BASE}/api/product-plan`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  return readJson<ProductPlanRun>(res);
}

export async function renderProductPlan(): Promise<ProductPlanRun> {
  const res = await fetch(`${BASE}/api/product-plan/render`, {
    method: "POST",
  });
  return readJson<ProductPlanRun>(res);
}

export async function deleteProductPlan(
  jobIds?: string[]
): Promise<ProductPlanRun> {
  const qs = jobIds?.length
    ? `?jobs=${encodeURIComponent(jobIds.join(","))}`
    : "";
  const res = await fetch(`${BASE}/api/product-plan${qs}`, {
    method: "DELETE",
  });
  return readJson<ProductPlanRun>(res);
}

export async function promoteOpportunity(
  id: string,
  input: PromoteOpportunityInput
): Promise<SearchDocument> {
  const res = await fetch(
    `${BASE}/api/opportunities/${encodeURIComponent(id)}/promote`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    }
  );
  return readJson<SearchDocument>(res);
}

export type {
  AppInfo,
  SearchDocument,
  SearchSummary,
  DiscoverOptions,
  Locale,
  GenerateOptions,
  AppSettings,
  OpportunityRun,
  ProductPlan,
  ProductJob,
};
