import { classForPhrase } from "./classify.js";
import type {
  ArticleRole,
  OrganicResult,
  PhraseClass,
  PhraseRecord,
  PhraseScores,
  SearchDocument,
  SiteMeta,
} from "./phrases.js";
import { normalizePhrase } from "./phrases.js";
import { googleSearchUrl, markdownLink, serpapiSearchUrl } from "./links.js";
import { collectRankingLeaves, type RankingLeaf } from "./ranking.js";
import { siteFor } from "./sites.js";
import { buildSearchSnapshot, type SearchSnapshot } from "./snapshot.js";
import {
  applyProduct,
  clusterHubs,
  hubForTitle,
  productLeaf,
  type ArticleHub,
  type ProductLeaf,
} from "./outcome-hubs.js";
import type {
  ProductCapabilitySnapshot,
  ProductMatch,
} from "./capabilities.js";
import {
  resolveSettings,
  type AppSettings,
} from "./config.js";

export interface GenerateOptions {
  minNiche: number;
  minWords: number;
  maxGenerate: number;
  roles: ArticleRole[];
  questionsOnly: boolean;
  qualifiedOnly: boolean;
  llmGrounding: boolean;
}

export const DEFAULT_GENERATE_OPTIONS: GenerateOptions = {
  minNiche: 40,
  minWords: 4,
  maxGenerate: 12,
  roles: ["write", "faq"],
  questionsOnly: false,
  qualifiedOnly: false,
  llmGrounding: true,
};

export function parseGenerateOptions(input: Record<string, unknown> = {}): Partial<GenerateOptions> {
  const rolesRaw = input.roles;
  const roles = Array.isArray(rolesRaw)
    ? (rolesRaw as string[])
    : typeof rolesRaw === "string"
      ? rolesRaw.split(",")
      : undefined;
  const allowed: ArticleRole[] = ["write", "faq", "cluster", "skip"];
  return {
    minNiche: typeof input.minNiche === "number" ? input.minNiche : undefined,
    minWords: typeof input.minWords === "number" ? input.minWords : undefined,
    maxGenerate: typeof input.maxGenerate === "number" ? input.maxGenerate : undefined,
    roles: roles
      ?.map((role) => role.trim() as ArticleRole)
      .filter((role) => allowed.includes(role)),
    questionsOnly:
      typeof input.questionsOnly === "boolean" ? input.questionsOnly : undefined,
    qualifiedOnly:
      typeof input.qualifiedOnly === "boolean" ? input.qualifiedOnly : undefined,
    llmGrounding:
      typeof input.llmGrounding === "boolean" ? input.llmGrounding : undefined,
  };
}

export function mergeGenerateOptions(
  partial?: Partial<GenerateOptions>
): GenerateOptions {
  const roles = partial?.roles?.length
    ? [...new Set(partial.roles)]
    : DEFAULT_GENERATE_OPTIONS.roles;
  return {
    minNiche: clampInt(partial?.minNiche, 0, 100, DEFAULT_GENERATE_OPTIONS.minNiche),
    minWords: clampInt(partial?.minWords, 1, 20, DEFAULT_GENERATE_OPTIONS.minWords),
    maxGenerate: clampInt(partial?.maxGenerate, 1, 200, DEFAULT_GENERATE_OPTIONS.maxGenerate),
    roles,
    questionsOnly: Boolean(partial?.questionsOnly),
    qualifiedOnly: Boolean(partial?.qualifiedOnly),
    llmGrounding: partial?.llmGrounding ?? DEFAULT_GENERATE_OPTIONS.llmGrounding,
  };
}

function clampInt(
  value: number | undefined,
  min: number,
  max: number,
  fallback: number
): number {
  if (typeof value !== "number" || Number.isNaN(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

export interface CompetitorResult extends OrganicResult {
  site?: Pick<
    SiteMeta,
    "title" | "description" | "siteName" | "httpStatus" | "headings" | "excerpt"
  >;
}

export interface ArticleBrief {
  title: string;
  role: ArticleRole;
  intent: PhraseClass["intent"];
  reason: string;
  filterReason?: string;
  scores: PhraseScores;
  sources: PhraseRecord["sources"];
  seeds: string[];
  h2s: string[];
  answer?: {
    snippet?: string;
    title?: string;
    link?: string;
  };
  competitors: CompetitorResult[];
  qualified: boolean;
  googleUrl: string;
  serpUrl?: string;
  /** Hub slug when this phrase is a page H1. */
  hub?: string;
  productMatch?: ProductMatch;
  workflow?: {
    id?: string;
    nodeIds: string[];
    rationale: string;
  };
  constraints?: string[];
  questions?: string[];
  contentGaps?: string[];
  evidenceSources?: Array<{
    title: string;
    url: string;
    position?: number;
    note?: string;
  }>;
  outline?: string[];
}

export interface ArticlePackageMetrics {
  phraseCount: number;
  generateCount: number;
  hubCount: number;
  absorbedCount: number;
  skipCount: number;
  qualifiedCount: number;
  questionCount: number;
  serpCalls: number;
  serpErrors: number;
  avgNicheGenerate: number | null;
}

export interface ArticlePackage {
  searchId: string;
  name: string;
  generatedAt: string;
  locale: SearchDocument["locale"];
  seeds: string[];
  options: GenerateOptions;
  metrics: ArticlePackageMetrics;
  generate: ArticleBrief[];
  hubs: ArticleHub[];
  product: ProductLeaf | null;
  skip: ArticleBrief[];
  social: RankingLeaf[];
  apps: RankingLeaf[];
  snapshot: SearchSnapshot;
  grounding: {
    schemaVersion: number | null;
    generatedAt: string | null;
    capabilityCount: number;
    workflowCount: number;
    unresolvedCount: number;
  };
}

function resolvedClass(
  row: PhraseRecord,
  blacklist: readonly string[] = []
): PhraseClass {
  return classForPhrase(row.phrase, row.class, blacklist);
}

const RELEVANCE_STOP = new Set([
  "a",
  "an",
  "and",
  "are",
  "can",
  "do",
  "does",
  "for",
  "how",
  "i",
  "in",
  "is",
  "of",
  "on",
  "the",
  "to",
  "what",
  "with",
]);

function relevanceTokens(value: string): Set<string> {
  return new Set(
    normalizePhrase(value)
      .split(/[^a-z0-9]+/)
      .filter((token) => token.length > 1 && !RELEVANCE_STOP.has(token))
      .map((token) => {
        if (token.endsWith("ing") && token.length > 6) return token.slice(0, -3);
        if (token.endsWith("ers") && token.length > 6) return token.slice(0, -3);
        if (token.endsWith("er") && token.length > 5) return token.slice(0, -2);
        if (token.endsWith("s") && token.length > 4) return token.slice(0, -1);
        return token;
      })
  );
}

export function isSeedRelevant(phrase: string, seeds: readonly string[]): boolean {
  if (!seeds.length) return true;
  const candidate = relevanceTokens(phrase);
  return seeds.some((seed) => {
    const terms = relevanceTokens(seed);
    const required = terms.size >= 2 ? 2 : 1;
    let overlap = 0;
    for (const term of terms) {
      if (candidate.has(term)) overlap += 1;
    }
    return overlap >= required;
  });
}

function siblingHeadings(
  row: PhraseRecord,
  all: PhraseRecord[],
  blacklist: readonly string[] = []
): string[] {
  const own = row.phrase;
  return all
    .filter((other) => other.phrase !== own)
    .filter((other) => {
      const role = resolvedClass(other, blacklist).role;
      return role === "write" || role === "faq" || role === "cluster";
    })
    .filter((other) => other.seeds.some((seed) => row.seeds.includes(seed)))
    .sort((a, b) => b.scores.niche - a.scores.niche)
    .slice(0, 6)
    .map((other) => other.phrase);
}

function attachSite(
  organic: OrganicResult,
  sites?: Record<string, SiteMeta>
): CompetitorResult {
  const site = siteFor(organic.link, sites);
  if (!site) return organic;
  return {
    ...organic,
    site: {
      title: site.title,
      description: site.description,
      siteName: site.siteName,
      httpStatus: site.httpStatus,
      headings: site.headings,
      excerpt: site.excerpt,
    },
  };
}

export function toBrief(
  row: PhraseRecord,
  all: PhraseRecord[],
  sites?: Record<string, SiteMeta>,
  locale?: SearchDocument["locale"],
  blacklist: readonly string[] = [],
  apiKey?: string
): ArticleBrief {
  const cls = resolvedClass(row, blacklist);
  return {
    title: row.phrase,
    role: cls.role,
    intent: cls.intent,
    reason: cls.reason,
    scores: row.scores,
    sources: row.sources,
    seeds: row.seeds,
    h2s: siblingHeadings(row, all, blacklist),
    answer: row.serp?.answer
      ? {
          snippet: row.serp.answer.snippet,
          title: row.serp.answer.title,
          link: row.serp.answer.link,
        }
      : undefined,
    competitors: (row.serp?.organics ?? []).slice(0, 5).map((row) => attachSite(row, sites)),
    qualified: Boolean(row.serp?.organics?.length),
    googleUrl: googleSearchUrl(row.phrase, locale),
    serpUrl: serpapiSearchUrl(row.serp?.searchId, apiKey),
  };
}

function rejectReason(
  brief: ArticleBrief,
  options: GenerateOptions,
  seeds: readonly string[]
): string | null {
  if (!isSeedRelevant(brief.title, seeds)) {
    return "drifted from the original seed intent";
  }
  if (!options.roles.includes(brief.role)) {
    return `role ${brief.role} not in ${options.roles.join(",")}`;
  }
  if (brief.scores.niche < options.minNiche) {
    return `niche ${brief.scores.niche} < ${options.minNiche}`;
  }
  if (brief.scores.wordCount < options.minWords) {
    return `words ${brief.scores.wordCount} < ${options.minWords}`;
  }
  if (options.questionsOnly && !brief.scores.isQuestion) {
    return "questions only";
  }
  if (options.qualifiedOnly && !brief.qualified) {
    return "not qualified (no ranking links)";
  }
  return null;
}

export function buildArticlePackage(
  doc: SearchDocument,
  rawOptions?: Partial<GenerateOptions>,
  settings?: AppSettings | readonly string[],
  apiKey?: string,
  capabilitySnapshot: ProductCapabilitySnapshot | null = null,
  adjudications: ReadonlyMap<string, ProductMatch> = new Map()
): ArticlePackage {
  const resolved = resolveSettings(settings);
  const blacklist = resolved.blacklist;
  const options = mergeGenerateOptions(rawOptions);
  const eligible: ArticleBrief[] = [];
  const skip: ArticleBrief[] = [];
  for (const row of doc.phrases) {
    const brief = toBrief(row, doc.phrases, doc.sites, doc.locale, blacklist, apiKey);
    const reason = rejectReason(brief, options, doc.seeds);
    if (reason) {
      skip.push({ ...brief, filterReason: reason });
    } else {
      eligible.push(brief);
    }
  }
  eligible.sort((a, b) => b.scores.niche - a.scores.niche);

  const clustered = clusterHubs(
    eligible.map((brief) => ({
      title: brief.title,
      niche: brief.scores.niche,
      qualified: brief.qualified,
      competitors: brief.competitors,
      googleUrl: brief.googleUrl,
    })),
    doc.seeds,
    200,
    resolved.product,
    capabilitySnapshot,
    adjudications
  );
  const grounded = applyProduct(
    clustered.hubs,
    resolved.product,
    capabilitySnapshot === null
  );
  const hubs = grounded.hubs.slice(0, options.maxGenerate);
  const overflow = [
    ...grounded.hubs.slice(options.maxGenerate),
    ...clustered.overflow,
  ];

  const generate: ArticleBrief[] = [];
  for (const brief of eligible) {
    const hub = hubForTitle(brief.title, hubs);
    if (hub && hub.h1 === brief.title) {
      generate.push({
        ...brief,
        hub: hub.slug,
        h2s: hub.h2s,
        productMatch: hub.productMatch,
        workflow: {
          id: hub.productMatch.workflowId,
          nodeIds: hub.productMatch.nodeIds,
          rationale: hub.productMatch.rationale,
        },
        constraints: hub.productMatch.constraints,
        questions: hub.questions,
        contentGaps: hub.contentGaps,
        evidenceSources: hub.sources,
        outline: hub.outline,
      });
      continue;
    }
    if (hub) {
      skip.push({
        ...brief,
        hub: hub.slug,
        h2s: hub.h2s,
        filterReason: `absorbed by ${hub.slug}`,
      });
      continue;
    }
    const blocked = hubForTitle(brief.title, grounded.blocked);
    if (blocked) {
      skip.push({
        ...brief,
        hub: blocked.slug,
        h2s: blocked.h2s,
        productMatch: blocked.productMatch,
        filterReason: blocked.productMatch.rationale,
      });
      continue;
    }
    const over = hubForTitle(brief.title, overflow);
    skip.push({
      ...brief,
      filterReason: over
        ? `over max ${options.maxGenerate} hubs`
        : `over max ${options.maxGenerate}`,
    });
  }
  skip.sort((a, b) => b.scores.niche - a.scores.niche);

  const leaves = collectRankingLeaves(doc);
  const nicheSum = generate.reduce((sum, row) => sum + row.scores.niche, 0);
  const absorbedCount = hubs.reduce((sum, hub) => sum + hub.absorbs.length, 0);
  return {
    searchId: doc.id,
    name: doc.name,
    generatedAt: new Date().toISOString(),
    locale: doc.locale,
    seeds: doc.seeds,
    options,
    metrics: {
      phraseCount: doc.phrases.length,
      generateCount: generate.length,
      hubCount: hubs.length,
      absorbedCount,
      skipCount: skip.length,
      qualifiedCount: doc.phrases.filter((p) => p.serp?.organics?.length).length,
      questionCount: doc.phrases.filter((p) => p.scores.isQuestion).length,
      serpCalls: doc.meta.calls.length,
      serpErrors: doc.meta.errors.length,
      avgNicheGenerate: generate.length
        ? Math.round(nicheSum / generate.length)
        : null,
    },
    generate,
    hubs,
    product: productLeaf(hubs, resolved.product, capabilitySnapshot),
    skip,
    social: leaves.social,
    apps: leaves.apps,
    snapshot: buildSearchSnapshot(doc),
    grounding: {
      schemaVersion: capabilitySnapshot?.schemaVersion ?? null,
      generatedAt: capabilitySnapshot?.generatedAt ?? null,
      capabilityCount: capabilitySnapshot?.capabilities.length ?? 0,
      workflowCount: capabilitySnapshot?.workflows.length ?? 0,
      unresolvedCount: grounded.blocked.filter(
        (hub) => hub.fit === "unknown"
      ).length,
    },
  };
}

export function renderReportMarkdown(pkg: ArticlePackage): string {
  const seedRanks = pkg.generate
    .find((row) => row.qualified)
    ?.competitors ?? [];
  const lines = [
    `# ${pkg.name} — article report`,
    "",
    `Search: \`${pkg.searchId}\``,
    `Generated: ${pkg.generatedAt}`,
    `Locale: ${pkg.locale.gl}/${pkg.locale.hl} (${pkg.locale.googleDomain})`,
    `Seeds: ${pkg.seeds.join(", ") || "-"}`,
    "",
    "## Landscape",
    "",
    pkg.snapshot.headline,
    "",
    pkg.snapshot.flags.length
      ? `- ${pkg.snapshot.flags.join(" · ")}`
      : "- no flags yet",
    pkg.snapshot.topHosts.length
      ? `- Hosts: ${pkg.snapshot.topHosts.join(", ")}`
      : "",
    "",
    "## Generate options",
    "",
    `- min niche: ${pkg.options.minNiche}`,
    `- min words: ${pkg.options.minWords}`,
    `- max generate: ${pkg.options.maxGenerate}`,
    `- roles: ${pkg.options.roles.join(", ")}`,
    `- questions only: ${pkg.options.questionsOnly}`,
    `- qualified only: ${pkg.options.qualifiedOnly}`,
    `- LLM capability adjudication: ${pkg.options.llmGrounding}`,
    `- capability snapshot: ${
      pkg.grounding.generatedAt
        ? `v${pkg.grounding.schemaVersion} · ${pkg.grounding.generatedAt}`
        : "missing"
    }`,
    `- capability evidence: ${pkg.grounding.capabilityCount} nodes · ${pkg.grounding.workflowCount} verified workflows · ${pkg.grounding.unresolvedCount} unresolved`,
    "",
    "## Metrics",
    "",
    `| Metric | Value |`,
    `| --- | ---: |`,
    `| Phrases | ${pkg.metrics.phraseCount} |`,
    `| Pages (hubs) | ${pkg.metrics.hubCount} |`,
    `| Absorbed into hubs | ${pkg.metrics.absorbedCount} |`,
    `| Articles to generate | ${pkg.metrics.generateCount} |`,
    `| Do not generate | ${pkg.metrics.skipCount} |`,
    `| Qualified with ranking links | ${pkg.metrics.qualifiedCount} |`,
    `| Questions | ${pkg.metrics.questionCount} |`,
    `| SerpAPI calls | ${pkg.metrics.serpCalls} |`,
    `| SerpAPI errors | ${pkg.metrics.serpErrors} |`,
    `| Avg niche (generate) | ${pkg.metrics.avgNicheGenerate ?? "—"} |`,
    "",
    "## How to use",
    "",
    "`generate` stops here: this is intelligence for a separate article-writing tool.",
    "Prefer structured `productMatch`, `workflow`, `outline`, `contentGaps`, and `sources`; `.hubs[].text` is only a compact instruction.",
    "`fit=direct` is an atomic verified capability; `fit=composed` has a verified XBlox path; `fit=editorial` must answer alternatives before selling.",
    "Never invent commands, blocks, formats, or platforms outside the attached evidence.",
    "",
    "## Pages to write",
    "",
  ];

  if (!pkg.hubs.length) {
    lines.push("_None. Qualify the search or add write/faq phrases._", "");
  }
  for (const hub of pkg.hubs) {
    const article = pkg.generate.find((row) => row.hub === hub.slug);
    lines.push(`### ${markdownLink(hub.h1, hub.googleUrl)}`, "");
    lines.push(
      `- Hub: \`${hub.slug}\` · Fit: ${hub.fit} · Outcome: ${hub.outcome} · Depth: ${hub.depthScore} · Niche: ${hub.niche}${
        article ? ` · Role: ${article.role}` : ""
      }`
    );
    lines.push(`- Each leaf: \`${hub.text}\``);
    lines.push(
      `- Product evidence: ${hub.productMatch.nodeIds.join(" → ") || "none"} (${Math.round(hub.productMatch.confidence * 100)}% confidence)`
    );
    lines.push(`- Why: ${hub.productMatch.rationale}`);
    if (hub.productMatch.constraints.length) {
      lines.push(`- Constraints: ${hub.productMatch.constraints.join("; ")}`);
    }
    lines.push(`- Google: ${markdownLink(hub.h1, hub.googleUrl)}`);
    if (article?.serpUrl) {
      lines.push(`- SerpAPI: ${markdownLink(hub.h1, article.serpUrl)}`);
    }
    if (hub.absorbs.length) {
      lines.push(`- Absorbs (FAQ, not pages): ${hub.absorbs.join("; ")}`);
    }
    if (hub.h2s.length) {
      lines.push(
        `- Suggested H2s: ${hub.h2s
          .map((h2) => markdownLink(h2, googleSearchUrl(h2, pkg.locale)))
          .join("; ")}`
      );
    }
    if (hub.contentGaps.length) {
      lines.push(`- Content gaps: ${hub.contentGaps.join("; ")}`);
    }
    if (hub.outline.length) {
      lines.push("- Planned depth:");
      for (const section of hub.outline) lines.push(`  - ${section}`);
    }
    if (article?.answer?.snippet) {
      lines.push(`- Current answer: ${article.answer.snippet}`);
      if (article.answer.link) {
        lines.push(
          `  - Source: ${markdownLink(article.answer.title || article.answer.link, article.answer.link)}`
        );
      }
    }
    if (hub.competitors.length) {
      lines.push("- Who ranks:");
      for (const row of hub.competitors) {
        lines.push(`  ${row.position}. ${markdownLink(row.title, row.link)}`);
        if (row.site?.description) {
          lines.push(`     ${row.site.siteName ? `${row.site.siteName}: ` : ""}${row.site.description}`);
        }
        if (row.site?.headings?.length) {
          lines.push(`     Covers: ${row.site.headings.slice(0, 8).join("; ")}`);
        }
      }
    } else {
      lines.push("- Who ranks: not qualified yet");
    }
    lines.push("");
  }

  if (pkg.product) {
    lines.push("## Shared product", "");
    if (pkg.product.name) {
      lines.push(`- Name: ${pkg.product.name}`);
    }
    if (pkg.product.platforms?.length) {
      lines.push(`- Platforms: ${pkg.product.platforms.join(", ")}`);
    }
    if (pkg.product.notPlatforms?.length) {
      lines.push(`- Not: ${pkg.product.notPlatforms.join(", ")}`);
    }
    if (pkg.product.summary) {
      lines.push(`- ${pkg.product.summary}`);
    }
    if (pkg.product.capabilitySnapshot) {
      lines.push(
        `- Grounding: capability snapshot v${pkg.product.capabilitySnapshot.schemaVersion} · ${pkg.product.capabilitySnapshot.capabilityCount} nodes · ${pkg.product.capabilitySnapshot.workflowCount} workflows`
      );
    }
    lines.push(`- Each leaf: \`${pkg.product.text}\``, "");
  }

  if (seedRanks.length) {
    lines.push("## Ranking snapshot (first qualified generate phrase)", "");
    for (const row of seedRanks) {
      lines.push(`${row.position}. ${markdownLink(row.title, row.link)}`);
    }
    lines.push("");
  }

  if (pkg.social.length || pkg.apps.length) {
    lines.push("## Extra leaves", "");
    if (pkg.social.length) {
      lines.push("### Social", "");
      for (const leaf of pkg.social) {
        lines.push(
          `- ${markdownLink(leaf.title, leaf.link)} — ${leaf.network}${
            leaf.phrases.length ? ` · via ${leaf.phrases.slice(0, 2).join("; ")}` : ""
          }`
        );
      }
      lines.push("");
    }
    if (pkg.apps.length) {
      lines.push("### Apps", "");
      for (const leaf of pkg.apps) {
        lines.push(
          `- ${markdownLink(leaf.title, leaf.link)} — ${leaf.network}${
            leaf.phrases.length ? ` · via ${leaf.phrases.slice(0, 2).join("; ")}` : ""
          }`
        );
      }
      lines.push("");
    }
  }

  lines.push("## Do not generate", "");
  if (!pkg.skip.length) {
    lines.push("_None._", "");
  } else {
    for (const article of pkg.skip) {
      const title = markdownLink(article.title, article.googleUrl);
      const extra = article.serpUrl
        ? ` · ${markdownLink("SerpAPI", article.serpUrl)}`
        : "";
      lines.push(
        `- ${title}${extra} — ${article.filterReason ?? article.reason}`
      );
    }
    lines.push("");
  }

  return `${lines.join("\n")}\n`;
}
