import { normalizePhrase } from "./phrases.js";
import type { ProductProfile } from "./config.js";
import type { CompetitorResult } from "./brief.js";
import {
  capabilityOutcomeKey,
  resolveCapability,
  type CapabilityFit,
  type ProductCapabilitySnapshot,
  type ProductMatch,
} from "./capabilities.js";

export interface HubMember {
  title: string;
  niche: number;
  qualified: boolean;
  competitors: CompetitorResult[];
  googleUrl: string;
}

export type HubFit = CapabilityFit;

export interface ArticleSource {
  title: string;
  url: string;
  position?: number;
  note?: string;
}

export interface ArticleHub {
  slug: string;
  key: string;
  h1: string;
  outcome: string;
  native: string;
  platforms: string[];
  absorbs: string[];
  questions: string[];
  h2s: string[];
  outline: string[];
  contentGaps: string[];
  sources: ArticleSource[];
  text: string;
  fit: HubFit;
  productMatch: ProductMatch;
  niche: number;
  depthScore: number;
  qualified: boolean;
  googleUrl: string;
  competitors: CompetitorResult[];
}

export interface ProductLeaf {
  text: string;
  name?: string;
  platforms?: string[];
  notPlatforms?: string[];
  summary?: string;
  doesNot?: string[];
  capabilitySnapshot?: {
    schemaVersion: number;
    generatedAt: string;
    capabilityCount: number;
    workflowCount: number;
  };
}

function slugify(value: string): string {
  return (
    normalizePhrase(value)
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 72) || "article"
  );
}

function competitorSources(rows: CompetitorResult[]): ArticleSource[] {
  return rows.slice(0, 5).map((row) => ({
    title: row.title,
    url: row.link,
    position: row.position,
    note:
      [
        row.site?.description || row.snippet,
        row.site?.headings?.length
          ? `Headings: ${row.site.headings.join("; ")}`
          : "",
        row.site?.excerpt,
      ]
        .filter(Boolean)
        .join(" | ")
        .slice(0, 3000) || undefined,
  }));
}

function outlineFor(h1: string, match: ProductMatch, questions: string[]): string[] {
  const sections = [
    `Directly answer: ${h1}`,
    "Explain the requested method and expected result",
  ];
  if (match.fit === "direct") {
    sections.push(`Verified Tanit capability: ${match.nodeIds.join(", ")}`);
  } else if (match.fit === "composed") {
    sections.push(
      `Verified Tanit workflow: ${match.workflowId ?? match.nodeIds.join(" → ")}`
    );
    sections.push("Walk through the blocks, hand-offs, and output");
  } else {
    sections.push("Compare native choices before introducing Tanit");
  }
  if (match.input || match.output) {
    sections.push(
      `Variations and formats: ${[match.input, match.output].filter(Boolean).join(" → ")}`
    );
  }
  if (match.constraints.length) sections.push("Limits and platform constraints");
  if (questions.length) sections.push("Follow-up questions and troubleshooting");
  sections.push("When Tanit is the useful next step");
  return sections;
}

function gapSignals(match: ProductMatch, competitors: CompetitorResult[]): string[] {
  const corpus = competitors
    .map(
      (row) =>
        `${row.title} ${row.snippet ?? ""} ${row.site?.description ?? ""} ${(row.site?.headings ?? []).join(" ")} ${row.site?.excerpt ?? ""}`
    )
    .join(" ")
    .toLowerCase();
  const gaps: string[] = [];
  if (
    match.nodeIds.length &&
    !match.nodeIds.some((id) => corpus.includes(id.split(":").at(-1) ?? id))
  ) {
    gaps.push("Ranking pages do not document the verified Tanit path");
  }
  if (match.fit === "composed") {
    gaps.push("Show the end-to-end composition, not isolated tools");
  }
  if (!/limit|support|require|platform/.test(corpus)) {
    gaps.push("State format and platform limits explicitly");
  }
  return gaps;
}

function toHub(
  key: string,
  members: Array<HubMember & { match: ProductMatch }>
): ArticleHub {
  const sorted = [...members].sort(
    (a, b) =>
      Number(b.qualified) - Number(a.qualified) ||
      b.niche - a.niche ||
      b.match.confidence - a.match.confidence ||
      a.title.length - b.title.length
  );
  const lead = sorted[0];
  const questions = [
    ...new Set([
      ...sorted.slice(1).map((member) => member.title),
      ...lead.match.followUps,
    ]),
  ];
  const match = lead.match;
  const contentGaps = gapSignals(match, lead.competitors);
  const depthScore = Math.min(
    100,
    Math.round(
      lead.niche * 0.45 +
        match.confidence * 35 +
        Math.min(15, questions.length * 3) +
        Math.min(10, contentGaps.length * 5)
    )
  );
  return {
    slug: slugify(match.outcome),
    key,
    h1: lead.title,
    outcome: match.outcome,
    native: match.nodeIds[0] ?? "editorial",
    platforms: match.platforms,
    absorbs: questions,
    questions,
    h2s: questions,
    outline: outlineFor(lead.title, match, questions),
    contentGaps,
    sources: competitorSources(lead.competitors),
    text: [
      `question=${lead.title}`,
      `outcome=${match.outcome}`,
      `fit=${match.fit}`,
      `evidence=${match.nodeIds.join(" -> ") || "none"}`,
      `questions=${questions.join("; ") || "none"}`,
      `limits=${match.constraints.join("; ") || "none"}`,
      "answer first; sell Tanit only from verified evidence",
    ].join(" | "),
    fit: match.fit,
    productMatch: match,
    niche: Math.max(...members.map((member) => member.niche)),
    depthScore,
    qualified: members.some((member) => member.qualified),
    googleUrl: lead.googleUrl,
    competitors: lead.competitors,
  };
}

export function clusterHubs(
  members: HubMember[],
  _seeds: string[] = [],
  maxHubs = 12,
  product: ProductProfile | null = null,
  snapshot: ProductCapabilitySnapshot | null = null,
  adjudications: ReadonlyMap<string, ProductMatch> = new Map()
): { hubs: ArticleHub[]; overflow: ArticleHub[] } {
  const buckets = new Map<string, Array<HubMember & { match: ProductMatch }>>();
  for (const member of members) {
    const match =
      adjudications.get(normalizePhrase(member.title)) ??
      resolveCapability(member.title, snapshot, product);
    const key = capabilityOutcomeKey(match);
    const bucket = buckets.get(key);
    const row = { ...member, match };
    if (bucket) bucket.push(row);
    else buckets.set(key, [row]);
  }
  const hubs = [...buckets.entries()]
    .map(([key, rows]) => toHub(key, rows))
    .sort(
      (a, b) =>
        b.depthScore - a.depthScore ||
        b.niche - a.niche ||
        a.h1.localeCompare(b.h1)
    );
  return { hubs: hubs.slice(0, maxHubs), overflow: hubs.slice(maxHubs) };
}

export function hubFit(
  hub: Pick<ArticleHub, "productMatch">,
  _product: ProductProfile | null
): HubFit {
  return hub.productMatch.fit;
}

export function groundHub(
  hub: ArticleHub,
  _product: ProductProfile | null
): ArticleHub {
  return hub;
}

export function applyProduct(
  hubs: ArticleHub[],
  _product: ProductProfile | null,
  allowUnknown = false
): { hubs: ArticleHub[]; blocked: ArticleHub[] } {
  return {
    hubs: hubs.filter(
      (hub) =>
        hub.fit !== "unsupported" && (allowUnknown || hub.fit !== "unknown")
    ),
    blocked: hubs.filter(
      (hub) =>
        hub.fit === "unsupported" || (!allowUnknown && hub.fit === "unknown")
    ),
  };
}

export function productLeaf(
  hubs: ArticleHub[],
  product: ProductProfile | null = null,
  snapshot: ProductCapabilitySnapshot | null = null
): ProductLeaf | null {
  if (!hubs.length || !product) return null;
  return {
    text: [
      `product=${product.name}`,
      product.platforms.length ? `supported=${product.platforms.join(", ")}` : "",
      product.notPlatforms.length
        ? `unsupported=${product.notPlatforms.join(", ")}`
        : "",
      product.summary ?? "",
      "use only capability evidence attached to each article plan",
    ]
      .filter(Boolean)
      .join(" | "),
    name: product.name,
    platforms: product.platforms,
    notPlatforms: product.notPlatforms,
    summary: product.summary,
    doesNot: product.doesNot,
    capabilitySnapshot: snapshot
      ? {
          schemaVersion: snapshot.schemaVersion,
          generatedAt: snapshot.generatedAt,
          capabilityCount: snapshot.capabilities.length,
          workflowCount: snapshot.workflows.length,
        }
      : undefined,
  };
}

export function hubForTitle(
  title: string,
  hubs: ArticleHub[]
): ArticleHub | undefined {
  return hubs.find((hub) => hub.h1 === title || hub.questions.includes(title));
}
