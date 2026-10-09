import type {
  CapabilityFit,
  ProductCapability,
  ProductCapabilitySnapshot,
} from "./capabilities.js";
import {
  normalizePhrase,
  type OrganicResult,
  type PhraseRecord,
  type SerpLandscape,
  type SiteMeta,
} from "./phrases.js";
import { collectRankingLeaves, type RankingLeaf } from "./ranking.js";
import type { ProductProfile } from "./config.js";

export type ProductJobProofKind =
  | "workflow"
  | "command"
  | "documentation"
  | "intent";
export type ProductPlanAction = "pillar" | "section" | "skip";

export interface ProductJob {
  id: string;
  label: string;
  proofKind: ProductJobProofKind;
  proofIds: string[];
  capabilityIds: string[];
  sources: string[];
  terms: string[];
  parentId?: string;
  summary?: string;
  command?: string;
  seeds?: string[];
  notThis?: string[];
}

export interface ProductJobDiscovery {
  job: ProductJob;
  phrases: PhraseRecord[];
  landscape?: SerpLandscape[];
}

export interface ProductPlanEvidence {
  query: string;
  organics: OrganicResult[];
  aiOverview?: string;
  sites?: Record<string, SiteMeta>;
  error?: string;
}

export interface ProductPlanDecision {
  action: ProductPlanAction;
  demand: number;
}

export interface ProductPlanChapter {
  jobId: string;
  label: string;
  canonicalQuery: string;
  absorbedQueries: string[];
  proofKind: ProductJobProofKind;
  proof: string[];
  parentId?: string;
  summary?: string;
  command?: string;
  seeds?: string[];
  fit: CapabilityFit;
  demandScore: number;
  priority: number;
  action: ProductPlanAction;
  demand: number;
  gap: string;
  qualified: boolean;
  phrases: PhraseRecord[];
  sites: SiteMeta[];
  social: RankingLeaf[];
  apps: RankingLeaf[];
  evidence?: ProductPlanEvidence;
}

export interface ProductPlan {
  schemaVersion: 1;
  product: string;
  generatedAt: string;
  chapters: ProductPlanChapter[];
  appendix: ProductPlanChapter[];
  productHoles: string[];
  metrics: {
    jobs: number;
    phrases: number;
    pillars: number;
    sections: number;
    skipped: number;
    holes: number;
  };
}

const INTERNAL_COMMANDS = new Set([
  "ui",
  "settings",
  "provider",
  "llm",
  "register-explorer",
  "register-startmenu",
  "installer",
  "batch",
  "login",
  "test",
  "status",
  "daemon",
  "llama",
  "hg",
  "run-ipc",
  "media",
  "mcp",
]);

const FAMILY_RULES: Array<[RegExp, string, string]> = [
  [/^video-recorder(?:-|$)/, "video-recorder", "screen recording"],
  [/^video-detect(?:-|$)/, "video-detect", "video detection"],
  [/^video-encode(?:-|$)/, "video-encode", "video encoding"],
  [/^inspect-text(?:-|$)/, "inspect-text", "inspect and transform text"],
  [/^screenshot(?:-|$)/, "screenshot", "screenshots"],
  [/^ocr-pipe(?:-|$)/, "ocr-pipe", "OCR documents"],
  [/^stt-paste(?:-|$)/, "stt-paste", "speech to text paste"],
  [/^vision-pipe(?:-|$)/, "vision-pipe", "image vision"],
  [/^new-file(?:-|$)/, "new-file", "create files"],
];

const COMMAND_FAMILIES: Record<string, string> = {
  audio: "audio-recorder",
  bluetooth: "bluetooth-yamaha",
  video: "video-recorder",
};

const STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "app",
  "best",
  "can",
  "file",
  "files",
  "for",
  "free",
  "how",
  "in",
  "is",
  "my",
  "of",
  "on",
  "the",
  "to",
  "using",
  "what",
  "with",
]);

function tokens(value: string): string[] {
  return normalizePhrase(value)
    .replace(/\bback\s+up\b/g, "backup")
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 1 && !STOP_WORDS.has(token))
    .map((token) => {
      if (token === "md") return "markdown";
      if (/^(record|recorded|recorder|recording|recordings)$/.test(token)) return "record";
      if (/^(caption|captions|subtitle|subtitles)$/.test(token)) return "caption";
      if (/^(encrypt|encrypted|encryption)$/.test(token)) return "encrypt";
      if (/^(view|viewer|preview|render)$/.test(token)) return "view";
      return token.endsWith("s") && token.length > 4 ? token.slice(0, -1) : token;
    });
}

function unique(values: Iterable<string>): string[] {
  return [...new Set([...values].filter(Boolean))];
}

function workflowName(id: string): string {
  return id
    .replace(/^workflow:/, "")
    .replace(/\s+-\s+copy$/i, "")
    .replaceAll("_", "-")
    .toLowerCase();
}

export function workflowFamily(id: string): { id: string; label: string } {
  const name = workflowName(id);
  for (const [pattern, family, label] of FAMILY_RULES) {
    if (pattern.test(name)) return { id: family, label };
  }
  return { id: name, label: name.replaceAll("-", " ") };
}

function capabilityTerms(nodes: ProductCapability[]): string[] {
  return unique(
    nodes.flatMap((node) => [
      ...tokens(node.label),
      ...node.terms,
      ...node.inputs,
      ...node.outputs,
    ])
  );
}

export function isCustomProductJob(job: ProductJob): boolean {
  if (
    job.id.startsWith("job:custom:") ||
    job.id.startsWith("job:command:custom.")
  ) {
    return true;
  }
  return (
    job.capabilityIds.some(
      (id) => id.startsWith("custom:") || id.startsWith("command:custom.")
    ) ||
    job.sources.some(
      (source) => source === "custom" || /commands --json custom/.test(source)
    )
  );
}

export function harvestProductJobs(
  snapshot: ProductCapabilitySnapshot
): ProductJob[] {
  const nodes = new Map(snapshot.capabilities.map((node) => [node.id, node]));
  const workflowGroups = new Map<string, ProductJob>();

  for (const workflow of snapshot.workflows) {
    if (/(^|[-_\s])copy($|[-_\s])/i.test(workflow.id)) continue;
    const family = workflowFamily(workflow.id);
    const members = workflow.nodeIds
      .map((id) => nodes.get(id))
      .filter(
        (node): node is ProductCapability =>
          node != null && node.available !== false
      );
    if (!members.length) continue;
    const existing = workflowGroups.get(family.id);
    const next: ProductJob = {
      id: `job:workflow:${family.id}`,
      label: family.label,
      proofKind: "workflow",
      proofIds: unique([...(existing?.proofIds ?? []), workflow.id]),
      capabilityIds: unique([
        ...(existing?.capabilityIds ?? []),
        ...workflow.nodeIds,
      ]),
      sources: unique([...(existing?.sources ?? []), workflow.source]),
      terms: unique([
        ...(existing?.terms ?? []),
        ...tokens(family.label),
        ...tokens(workflow.label),
        ...capabilityTerms(members),
      ]),
    };
    workflowGroups.set(family.id, next);
  }

  const coveredFamilies = new Set(workflowGroups.keys());
  const commands = snapshot.capabilities
    .filter((node) => node.kind === "command" && node.available !== false)
    .filter((node) => {
      const command = node.id.replace(/^command:/, "");
      if (INTERNAL_COMMANDS.has(command)) return false;
      const family = COMMAND_FAMILIES[command];
      return !family || !coveredFamilies.has(family);
    })
    .map((node): ProductJob => ({
      id: `job:${node.id}`,
      label: node.label,
      proofKind: "command",
      proofIds: [node.id],
      capabilityIds: [node.id],
      sources: [node.source],
      terms: capabilityTerms([node]),
    }));

  const documents = snapshot.capabilities
    .filter((node) => node.kind === "documentation" && node.available !== false)
    .map((node): ProductJob => ({
      id: `job:${node.id}`,
      label: node.label,
      proofKind: "documentation",
      proofIds: [node.id],
      capabilityIds: [node.id],
      sources: [node.source],
      terms: capabilityTerms([node]),
    }));

  const overlay = snapshot.capabilities
    .filter((node) => node.available !== false)
    .filter(
      (node) => node.id.startsWith("custom:") || node.source === "custom"
    )
    .filter((node) => node.kind !== "documentation" && node.kind !== "command")
    .map(
      (node): ProductJob => ({
        id: `job:${node.id}`,
        label: node.label,
        proofKind: "documentation",
        proofIds: [node.id],
        capabilityIds: [node.id],
        sources: [node.source || "custom"],
        terms: capabilityTerms([node]),
      })
    );

  const seen = new Set<string>();
  return [...workflowGroups.values(), ...commands, ...documents, ...overlay]
    .filter((job) => {
      if (seen.has(job.id)) return false;
      seen.add(job.id);
      return true;
    })
    .sort((a, b) => a.id.localeCompare(b.id));
}

function capabilityOf(
  job: ProductJob,
  capabilities: ProductCapability[]
): ProductCapability | undefined {
  const id =
    job.proofIds.find((proof) => proof.startsWith("documentation:")) ??
    job.id.replace(/^job:/, "");
  return capabilities.find((node) => node.id === id);
}

export function heuristicIntentSeeds(label: string): string[] {
  const cleaned = normalizePhrase(label)
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 1 && !STOP_WORDS.has(token))
    .slice(0, 6)
    .join(" ");
  if (!cleaned) return [label];
  return unique([cleaned, `how to ${cleaned}`]);
}

export function documentationIntentJobs(
  job: ProductJob,
  capability?: ProductCapability | null
): ProductJob[] {
  if (job.proofKind !== "documentation") return [];
  const sections = capability?.sections ?? [];
  if (sections.length < 2) return [];
  const feature = (capability?.id ?? job.proofIds[0] ?? job.id).replace(
    /^documentation:/,
    ""
  );
  return sections.map((section) => ({
    id: `job:intent:${feature}:${section.id}`,
    label: section.label,
    proofKind: "intent",
    proofIds: unique([
      ...job.proofIds,
      `${capability?.id ?? job.proofIds[0]}#${section.id}`,
    ]),
    capabilityIds: job.capabilityIds,
    sources: job.sources,
    terms: unique([
      ...job.terms,
      ...(capability?.terms ?? []),
      ...tokens(section.label),
      ...tokens(section.summary),
      ...tokens(section.command ?? ""),
    ]),
    parentId: job.id,
    summary: section.summary,
    command: section.command,
    seeds: heuristicIntentSeeds(section.label),
  }));
}

export function expandProductPlanJobs(
  jobs: ProductJob[],
  capabilities: ProductCapability[]
): ProductJob[] {
  const out: ProductJob[] = [];
  const seen = new Set<string>();
  const push = (job: ProductJob) => {
    if (seen.has(job.id)) return;
    seen.add(job.id);
    out.push(job);
  };
  for (const job of jobs) {
    const intents = documentationIntentJobs(job, capabilityOf(job, capabilities));
    if (intents.length >= 2) {
      for (const intent of intents) push(intent);
      continue;
    }
    push(job);
  }
  return out;
}

function phraseRejected(phrase: string, job: ProductJob): boolean {
  if (!job.notThis?.length) return false;
  const banned = new Set(job.notThis.flatMap((row) => tokens(row)));
  if (!banned.size) return false;
  const hits = unique(tokens(phrase)).filter((token) => banned.has(token)).length;
  if (hits >= 2) return true;
  return hits > 0 && phraseOverlap(phrase, job) <= hits;
}

function fitFor(job: ProductJob, overlap: number): CapabilityFit {
  if (overlap < 2) return "editorial";
  return job.proofKind === "workflow" ? "composed" : "direct";
}

function fitRank(fit: CapabilityFit): number {
  if (fit === "direct") return 3;
  if (fit === "composed") return 2;
  if (fit === "editorial") return 1;
  return 0;
}

function phraseOverlap(phrase: string, job: ProductJob): number {
  const jobTerms = new Set(job.terms);
  return unique(tokens(phrase)).filter((token) => jobTerms.has(token)).length;
}

interface Claim {
  record: PhraseRecord;
  job: ProductJob;
  fit: CapabilityFit;
  overlap: number;
}

function chooseCanonical(claims: Claim[]): Claim {
  return [...claims].sort(
    (a, b) =>
      Number(b.record.sources.some((source) => source !== "seed")) -
        Number(a.record.sources.some((source) => source !== "seed")) ||
      b.overlap / Math.max(1, unique(tokens(b.record.phrase)).length) -
        a.overlap / Math.max(1, unique(tokens(a.record.phrase)).length) ||
      b.overlap - a.overlap ||
      b.record.scores.niche - a.record.scores.niche ||
      a.record.phrase.length - b.record.phrase.length
  )[0];
}

function deniedPlatform(
  phrase: string,
  product: ProductProfile | null
): boolean {
  if (!product) return false;
  const normalized = normalizePhrase(phrase);
  const query = new Set(
    normalized
      .split(/[^a-z0-9]+/)
      .filter(Boolean)
      .map((token) => {
        if (/^phones?$/.test(token)) return "mobile";
        if (/^(macos|macbook)$/.test(token)) return "mac";
        if (/^(ipad|iphone)$/.test(token)) return "ios";
        return token;
      })
  );
  return product.notPlatforms.some((platform) => query.has(platform));
}

function defaultAction(claims: Claim[], demandScore: number): ProductPlanAction {
  const discovered = claims.some((claim) =>
    claim.record.sources.some((source) => source !== "seed")
  );
  if (discovered && demandScore >= 40) return "pillar";
  if (discovered) return "section";
  return "skip";
}

export function buildProductPlan(
  product: string,
  jobs: ProductJob[],
  discoveries: ProductJobDiscovery[],
  decisions: ReadonlyMap<string, ProductPlanDecision> = new Map(),
  generatedAt = new Date().toISOString(),
  productProfile: ProductProfile | null = null
): ProductPlan {
  const contenders = new Map<string, Claim[]>();
  for (const discovery of discoveries) {
    for (const record of discovery.phrases) {
      if (record.class?.role === "skip" || deniedPlatform(record.phrase, productProfile)) {
        continue;
      }
      if (phraseRejected(record.phrase, discovery.job)) continue;
      const overlap = phraseOverlap(record.phrase, discovery.job);
      const minOverlap = discovery.job.proofKind === "intent" ? 2 : 1;
      if (overlap < minOverlap) continue;
      const key = normalizePhrase(record.phrase);
      const claims = contenders.get(key) ?? [];
      claims.push({
        record,
        job: discovery.job,
        fit: fitFor(discovery.job, overlap),
        overlap,
      });
      contenders.set(key, claims);
    }
  }

  const assigned = new Map<string, Claim[]>();
  for (const claims of contenders.values()) {
    const winner = [...claims].sort(
      (a, b) =>
        fitRank(b.fit) - fitRank(a.fit) ||
        b.overlap - a.overlap ||
        b.record.scores.niche - a.record.scores.niche ||
        a.job.id.localeCompare(b.job.id)
    )[0];
    const rows = assigned.get(winner.job.id) ?? [];
    rows.push(winner);
    assigned.set(winner.job.id, rows);
  }

  const allPhrases = unique(
    discoveries.flatMap((discovery) =>
      discovery.phrases
        .filter(
          (record) =>
            record.class?.role !== "skip" &&
            !deniedPlatform(record.phrase, productProfile)
        )
        .map((record) => normalizePhrase(record.phrase))
    )
  );
  const claimed = new Set(contenders.keys());
  const productHoles = allPhrases.filter((phrase) => !claimed.has(phrase)).sort();

  const chapters = jobs.map((job): ProductPlanChapter => {
    const claims = assigned.get(job.id) ?? [];
    const phraseRecords = claims.map((claim) => claim.record);
    const discovery = discoveries.find((row) => row.job.id === job.id);
    const leaves = collectRankingLeaves({
      phrases: phraseRecords,
      landscape: discovery?.landscape,
    });
    const canonical = claims.length ? chooseCanonical(claims) : undefined;
    const fit =
      canonical?.fit ??
      (job.proofKind === "workflow" ? "composed" : "direct");
    const demandScore = claims.reduce(
      (score, claim) => Math.max(score, claim.record.scores.niche),
      0
    );
    const decision = decisions.get(job.id);
    const action = decision?.action ?? defaultAction(claims, demandScore);
    const canonicalQuery = canonical?.record.phrase ?? job.label;
    return {
      jobId: job.id,
      label: job.label,
      canonicalQuery,
      absorbedQueries: unique(
        claims
          .map((claim) => claim.record.phrase)
          .filter((phrase) => normalizePhrase(phrase) !== normalizePhrase(canonicalQuery))
      ),
      proofKind: job.proofKind,
      proof: job.proofIds,
      parentId: job.parentId,
      summary: job.summary,
      command: job.command,
      seeds: job.seeds,
      fit,
      demandScore,
      priority: Math.round(demandScore * (fitRank(fit) / 3)),
      action,
      demand: decision?.demand ?? (demandScore > 0 ? demandScore / 100 : 0),
      gap: claims.length
        ? "Ranking-page proof has not been collected yet."
        : "No search demand found in the bounded discovery pass.",
      qualified: false,
      phrases: phraseRecords,
      sites: [],
      social: leaves.social,
      apps: leaves.apps,
    };
  });

  chapters.sort(
    (a, b) => b.priority - a.priority || a.label.localeCompare(b.label)
  );
  const active = chapters.filter((chapter) => chapter.action !== "skip");
  const appendix = chapters.filter((chapter) => chapter.action === "skip");
  return {
    schemaVersion: 1,
    product,
    generatedAt,
    chapters: active,
    appendix,
    productHoles,
    metrics: {
      jobs: jobs.length,
      phrases: allPhrases.length,
      pillars: chapters.filter((chapter) => chapter.action === "pillar").length,
      sections: chapters.filter((chapter) => chapter.action === "section").length,
      skipped: appendix.length,
      holes: productHoles.length,
    },
  };
}
