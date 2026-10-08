import fs from "node:fs/promises";
import path from "node:path";
import {
  buildProductPlan,
  harvestProductJobs,
  type ProductJob,
  type ProductJobDiscovery,
  type ProductPlan,
  type ProductPlanChapter,
  type ProductPlanDecision,
  type ProductPlanEvidence,
} from "../shared/product-plan.js";
import {
  DEFAULT_LOCALE,
  normalizePhrase,
  type DiscoverOptions,
  type Locale,
  type OrganicResult,
  type PhraseRecord,
  type PhraseSource,
  type SiteMeta,
} from "../shared/phrases.js";
import { isQuestion } from "./score.js";
import { loadCapabilitySnapshot } from "./capabilities.js";
import { loadAppConfig } from "./app-config.js";
import { resolvedResultsDir } from "./env.js";
import {
  collectRankingLeaves,
  rankingKind,
  type RankingLeaf,
} from "../shared/ranking.js";
import { discoverPhrases, type DiscoverResult } from "./discover.js";
import { enrichUrls, parseEnricherSpecs } from "./enrichers/pipeline.js";
import type { EnricherSpec } from "./enrichers/types.js";
import {
  flattenAiOverview,
  parseOrganics,
  parseQuestions,
} from "./serp-parse.js";
import { describeSerpError, fetchAiOverview, fetchGoogleSerp } from "./serpapi.js";
import { runShell } from "./shell.js";
import {
  discoveryDigest,
  organicUrls,
  productPlanCacheDir,
  readDecideCache,
  readDiscoveryCache,
  readEnrichCache,
  readQualifyCache,
  serpOnlyEvidence,
  writeDecideCache,
  writeDiscoveryCache,
  writeEnrichCache,
  writeQualifyCache,
  deleteDecideCache,
  deleteJobStageCache,
  deletePlanCache,
} from "./product-plan-cache.js";
import {
  beginProductPlanRun,
  endProductPlanRun,
  noteProductPlan,
  resetProductPlanRun,
} from "./product-plan-run.js";

export interface ProductPlanInput {
  snapshotPath?: string;
  locale?: Partial<Locale>;
  /** 2 = autocomplete only; 4 = autocomplete plus one Google result per seed. */
  serpCallsPerJob?: 2 | 4;
  /** Explicit small-sample selector. */
  jobIds?: string[];
  maxJobs?: number;
  decide?: boolean;
  decisionDir?: string;
  qualify?: boolean;
  /** Fetch ranking-page meta for pillar chapters (needs qualify results or cache). */
  enrich?: boolean;
  enrichers?: EnricherSpec[] | string;
  outDir?: string;
  /** Read/write stage caches under `{outDir}/.cache` (default true when `outDir` is set). */
  useCache?: boolean;
  forceDiscover?: boolean;
  forceDecide?: boolean;
  forceQualify?: boolean;
  forceEnrich?: boolean;
}

export interface ProductPlanDependencies {
  loadSnapshot?: typeof loadCapabilitySnapshot;
  loadSettings?: typeof loadAppConfig;
  discover?: (
    job: ProductJob,
    seeds: string[],
    locale: Locale,
    options: DiscoverOptions
  ) => Promise<DiscoverResult>;
  decide?: (
    chapters: ProductPlanChapter[]
  ) => Promise<ReadonlyMap<string, ProductPlanDecision>>;
  qualify?: (
    chapter: ProductPlanChapter,
    locale: Locale
  ) => Promise<ProductPlanEvidence>;
  enrich?: (
    chapter: ProductPlanChapter,
    evidence: ProductPlanEvidence
  ) => Promise<Record<string, SiteMeta>>;
  now?: () => Date;
}

function discoveryOptions(calls: 2 | 4): DiscoverOptions {
  return {
    engines:
      calls === 4
        ? ["autocomplete", "related_searches", "people_also_ask"]
        : ["autocomplete"],
    paaDepth: 0,
    alphabet: false,
    questionPrefixes: false,
  };
}

export function productJobSeeds(job: ProductJob): string[] {
  if (job.id === "job:workflow:video-recorder") {
    return ["screen recording", "how to record screen"];
  }
  if (job.id === "job:documentation:feature-markdown") {
    return ["markdown viewer", "how to view markdown files"];
  }
  return [job.label, `how to ${job.label}`];
}

function selectJobs(jobs: ProductJob[], input: ProductPlanInput): ProductJob[] {
  const ids = new Set(input.jobIds ?? []);
  const selected = ids.size ? jobs.filter((job) => ids.has(job.id)) : jobs;
  return selected.slice(0, Math.max(1, input.maxJobs ?? selected.length));
}

async function defaultDiscovery(
  _job: ProductJob,
  seeds: string[],
  locale: Locale,
  options: DiscoverOptions
): Promise<DiscoverResult> {
  return discoverPhrases(seeds, locale, options);
}

const QUALIFY_QUERY_CAP = 4;

function mergeOrganics(rows: OrganicResult[]): OrganicResult[] {
  const map = new Map<string, OrganicResult>();
  for (const row of rows) {
    if (!row.link || map.has(row.link)) continue;
    map.set(row.link, row);
  }
  return [...map.values()].sort((a, b) => a.position - b.position);
}

async function defaultQualification(
  chapter: ProductPlanChapter,
  locale: Locale
): Promise<ProductPlanEvidence> {
  const extras = questionPhrases(chapter.phrases)
    .map((row) => row.phrase)
    .filter(
      (phrase) => normalizePhrase(phrase) !== normalizePhrase(chapter.canonicalQuery)
    );
  const queries = [...new Set([chapter.canonicalQuery, ...extras])].slice(
    0,
    QUALIFY_QUERY_CAP
  );
  const organics: OrganicResult[] = [];
  let aiOverview: string | undefined;
  for (const query of queries) {
    const hit = await fetchGoogleSerp(query, locale, { num: 20 });
    organics.push(...parseOrganics(hit.response));
    for (const row of parseQuestions(hit.response)) {
      if (!row.answer?.link) continue;
      organics.push({
        position: 0,
        title: row.answer.title || row.question,
        link: row.answer.link,
        snippet: row.answer.snippet,
        source: row.answer.displayedLink,
      });
    }
    if (aiOverview) continue;
    let answer = flattenAiOverview(hit.response.ai_overview);
    if (answer?.pageToken && !answer.snippet) {
      const ai = await fetchAiOverview(answer.pageToken, query);
      answer = flattenAiOverview(ai.response.ai_overview) ?? answer;
    }
    aiOverview = answer?.snippet;
  }
  return {
    query: chapter.canonicalQuery,
    organics: mergeOrganics(organics),
    aiOverview,
  };
}

function enricherNames(specs: EnricherSpec[]): string[] {
  return [
    ...new Set(specs.map((spec) => (typeof spec === "string" ? spec : spec.name))),
  ].sort();
}

async function defaultEnrichment(
  evidence: ProductPlanEvidence,
  enrichers: EnricherSpec[]
): Promise<Record<string, SiteMeta>> {
  return enrichUrls(organicUrls(evidence), { enrichers });
}

function evidenceGap(evidence: ProductPlanEvidence): string {
  if (!evidence.organics.length) return "No ranking pages were returned.";
  const corpus = [
    ...evidence.organics.flatMap((row) => [row.title, row.snippet ?? ""]),
    ...Object.values(evidence.sites ?? {}).flatMap((site) => [
      site.title ?? "",
      site.description ?? "",
      ...(site.headings ?? []),
    ]),
  ]
    .join(" ")
    .toLowerCase();
  const documented = corpus.includes("tanit");
  return documented
    ? "Ranking pages mention the verified product path."
    : "Ranking pages do not document the verified product path.";
}

function allChapters(plan: ProductPlan): ProductPlanChapter[] {
  return [...plan.chapters, ...plan.appendix];
}

function applyEvidence(
  plan: ProductPlan,
  evidence: ReadonlyMap<string, ProductPlanEvidence>
): ProductPlan {
  const mergeLeaves = (
    left: RankingLeaf[],
    right: RankingLeaf[]
  ): RankingLeaf[] => {
    const rows = new Map(left.map((leaf) => [leaf.link, leaf]));
    for (const leaf of right) rows.set(leaf.link, leaf);
    return [...rows.values()];
  };
  const apply = (chapter: ProductPlanChapter): ProductPlanChapter => {
    const found = evidence.get(chapter.jobId);
    if (!found) return chapter;
    if (found.error) {
      return {
        ...chapter,
        qualified: false,
        evidence: found,
        gap: found.error,
      };
    }
    const leaves = collectRankingLeaves({
      phrases: chapter.phrases,
      landscape: [
        {
          query: found.query,
          searchId: null,
          features: [],
          organics: found.organics,
        },
      ],
      sites: found.sites,
    });
    return {
      ...chapter,
      qualified: true,
      evidence: found,
      sites: Object.values(found.sites ?? {}).filter(
        (site) => !rankingKind(site.url)
      ),
      social: mergeLeaves(chapter.social, leaves.social),
      apps: mergeLeaves(chapter.apps, leaves.apps),
      gap: evidenceGap(found),
    };
  };
  return {
    ...plan,
    chapters: plan.chapters.map(apply),
    appendix: plan.appendix.map(apply),
  };
}

export async function decideProductPlanWithCli(
  chapters: ProductPlanChapter[],
  dir: string
): Promise<ReadonlyMap<string, ProductPlanDecision>> {
  await fs.mkdir(dir, { recursive: true });
  const source = path.join(dir, "product-plan.decide.in.json");
  const questions = path.join(dir, "product-plan.questions.json");
  const dest = path.join(dir, "product-plan.decide.out.json");
  await fs.writeFile(
    source,
    `${JSON.stringify(
      {
        items: chapters.map((chapter) => ({
          id: chapter.jobId,
          label: chapter.label,
          canonicalQuery: chapter.canonicalQuery,
          absorbedQueries: chapter.absorbedQueries,
          proofKind: chapter.proofKind,
          proof: chapter.proof,
          fit: chapter.fit,
          demandScore: chapter.demandScore,
        })),
      },
      null,
      2
    )}\n`,
    "utf8"
  );
  await fs.writeFile(
    questions,
    `${JSON.stringify(
      {
        action: {
          type: "choice",
          instructions:
            "Choose the honest content action for `item`. Prefer pillar only for a distinct job with demonstrated demand; section for supporting demand; skip when demand is absent.",
          criteria: {
            pillar: "A standalone product chapter with demonstrated demand",
            section: "Useful supporting demand best absorbed by another chapter",
            skip: "No demonstrated demand in this bounded pass",
          },
        },
        demand: {
          type: "noul",
          instructions:
            "Does `item` contain credible search demand rather than only its catalog seed?",
        },
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  const args = [
    "llm",
    "agent",
    "decide",
    "-i",
    source,
    "--questions",
    questions,
    "--selector",
    ".items[]",
    "--target",
    "decisions",
    "-o",
    dest,
    "--json",
  ];
  const provider = process.env.PHRASES_DECIDE_PROVIDER?.trim();
  const model = process.env.PHRASES_LLM_MODEL?.trim();
  if (provider) args.push("--provider", provider);
  if (model) args.push("--model", model);
  const run = await runShell({
    bin: process.env.PHRASES_LLM_BIN?.trim() || "tanit-cli",
    args,
    label: "tanit-cli-decide-product-plan",
    timeoutMs: 10 * 60 * 1000,
  });
  if (run.code !== 0) {
    throw new Error(
      `tanit-cli decide exited ${run.code}${run.stderr.trim() ? `: ${run.stderr.trim()}` : ""}`
    );
  }
  const payload = JSON.parse(run.stdout) as {
    ok?: boolean;
    output?: {
      items?: Array<{
        id?: string;
        decisions?: {
          action?: { choice?: string };
          demand?: { noul?: number };
        };
      }>;
    };
  };
  if (!payload.ok) throw new Error("tanit-cli decide failed");
  const result = new Map<string, ProductPlanDecision>();
  for (const item of payload.output?.items ?? []) {
    const action = item.decisions?.action?.choice;
    if (
      !item.id ||
      (action !== "pillar" && action !== "section" && action !== "skip")
    ) {
      continue;
    }
    const demand = Number(item.decisions?.demand?.noul);
    result.set(item.id, {
      action,
      demand: Number.isFinite(demand) ? Math.max(0, Math.min(1, demand)) : 0.5,
    });
  }
  return result;
}

const MIN_QUESTIONS_MD = 5;

function featureTitle(chapter: ProductPlanChapter): string {
  const proof = chapter.proof.find((id) => id.includes("feature-"));
  if (proof) {
    const slug = proof.replace(/^documentation:/, "").replace(/^feature-/, "");
    return slug
      .split("-")
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(" ");
  }
  return chapter.label
    .split(" ")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function questionPhrases(rows: PhraseRecord[]): PhraseRecord[] {
  return [...rows]
    .filter((row) => row.scores.isQuestion || isQuestion(row.phrase))
    .sort(
      (a, b) =>
        b.scores.niche - a.scores.niche ||
        a.phrase.localeCompare(b.phrase)
    );
}

function keywordPhrases(rows: PhraseRecord[]): PhraseRecord[] {
  const questions = new Set(questionPhrases(rows).map((row) => row.phrase));
  return [...rows]
    .filter((row) => !questions.has(row.phrase))
    .sort(
      (a, b) =>
        b.scores.niche - a.scores.niche ||
        a.phrase.localeCompare(b.phrase)
    );
}

function phrasesBySource(rows: PhraseRecord[]): Map<PhraseSource, string[]> {
  const map = new Map<PhraseSource, Set<string>>();
  for (const row of rows) {
    for (const source of row.sources) {
      const bucket = map.get(source) ?? new Set<string>();
      bucket.add(row.phrase);
      map.set(source, bucket);
    }
  }
  const order: PhraseSource[] = [
    "people_also_ask",
    "related_searches",
    "autocomplete",
    "seed",
    "manual",
  ];
  const out = new Map<PhraseSource, string[]>();
  for (const source of order) {
    const values = map.get(source);
    if (values?.size) out.set(source, [...values].sort());
  }
  for (const [source, values] of map) {
    if (!out.has(source)) out.set(source, [...values].sort());
  }
  return out;
}

function mdLink(title: string, url: string): string {
  const safe = title.replace(/\[/g, "\\[").replace(/\]/g, "\\]");
  return `[${safe}](${url})`;
}

function renderLeafSection(
  lines: string[],
  heading: string,
  leaves: RankingLeaf[],
  empty: string
): void {
  lines.push(`#### ${heading}`, "");
  if (!leaves.length) {
    lines.push(`_${empty}_`, "");
    return;
  }
  for (const leaf of leaves) {
    lines.push(
      `- **${leaf.network}** · ${mdLink(leaf.title, leaf.link)}${
        leaf.position != null ? ` (≈#${leaf.position})` : ""
      }`
    );
    if (leaf.snippet) lines.push(`  - ${leaf.snippet.slice(0, 220)}`);
  }
  lines.push("");
}

function renderFeatureSection(
  lines: string[],
  chapter: ProductPlanChapter
): void {
  const title = featureTitle(chapter);
  lines.push(
    `## Feature: ${title}`,
    "",
    `- **Job:** ${chapter.label} (\`${chapter.jobId}\`)`,
    `- **Action:** ${chapter.action} · demand ${Math.round(chapter.demand * 100)}% · fit ${chapter.fit}`,
    `- **Canonical query:** ${chapter.canonicalQuery}`,
    `- **Proof:** ${chapter.proof.join(", ")}`,
    `- **Gap:** ${chapter.gap}`,
    `- **Qualified / enriched:** ${chapter.qualified ? "yes" : "no"}`,
    ""
  );

  const questions = questionPhrases(chapter.phrases);
  const show = questions.slice(0, Math.max(MIN_QUESTIONS_MD, questions.length));
  lines.push(
    `### Questions (${show.length}${questions.length < MIN_QUESTIONS_MD ? ` — only ${questions.length} found in discovery` : ""})`,
    ""
  );
  if (!show.length) {
    lines.push("_No question-shaped phrases in this pass._", "");
  } else {
    for (const row of show) {
      const src = row.sources.join(", ");
      lines.push(`- ${row.phrase} _(niche ${row.scores.niche}, ${src})_`);
    }
    lines.push("");
  }

  lines.push("### Phrases by source", "");
  const bySource = phrasesBySource(chapter.phrases);
  if (!bySource.size) {
    lines.push("_No phrases attached._", "");
  } else {
    for (const [source, phrases] of bySource) {
      lines.push(`**${source}** (${phrases.length})`, "");
      for (const phrase of phrases) lines.push(`- ${phrase}`);
      lines.push("");
    }
  }

  const keywords = keywordPhrases(chapter.phrases).slice(0, 24);
  if (keywords.length) {
    lines.push(`### Keyword variants (top ${keywords.length})`, "");
    for (const row of keywords) {
      lines.push(`- ${row.phrase} _(niche ${row.scores.niche})_`);
    }
    lines.push("");
  }

  if (chapter.absorbedQueries.length) {
    lines.push(
      `### Absorbed into this chapter (${chapter.absorbedQueries.length})`,
      ""
    );
    for (const phrase of chapter.absorbedQueries.slice(0, 20)) {
      lines.push(`- ${phrase}`);
    }
    if (chapter.absorbedQueries.length > 20) {
      lines.push(`- …and ${chapter.absorbedQueries.length - 20} more`);
    }
    lines.push("");
  }

  renderLeafSection(lines, "Social", chapter.social, "No social leaves in SERP.");
  renderLeafSection(lines, "App stores", chapter.apps, "No app-store leaves.");

  lines.push("#### Sites (ranking pages)", "");
  if (!chapter.sites.length) {
    const fromEvidence = chapter.evidence?.organics?.filter(
      (row) => row.link && !rankingKind(row.link)
    );
    if (fromEvidence?.length) {
      for (const row of fromEvidence.slice(0, 8)) {
        lines.push(`- ${mdLink(row.title, row.link)}`);
        if (row.snippet) lines.push(`  - ${row.snippet.slice(0, 220)}`);
      }
    } else {
      lines.push("_No plain-site meta captured (social/app URLs excluded)._", "");
    }
  } else {
    for (const site of chapter.sites.slice(0, 8)) {
      lines.push(`- ${mdLink(site.title || site.url, site.url)}`);
      if (site.description) lines.push(`  - ${site.description.slice(0, 220)}`);
    }
    lines.push("");
  }

  if (chapter.evidence?.aiOverview) {
    lines.push("### Current answer (AI overview)", "");
    lines.push(chapter.evidence.aiOverview.slice(0, 1200), "");
    if (chapter.evidence.aiOverview.length > 1200) lines.push("…", "");
  }
  lines.push("---", "");
}

export function renderProductPlanMarkdown(plan: ProductPlan): string {
  const lines = [
    `# ${plan.product} master content plan`,
    "",
    `Generated: ${plan.generatedAt}`,
    "",
    "| Jobs | Phrases | Pillars | Sections | Skipped | Holes |",
    "| ---: | ---: | ---: | ---: | ---: | ---: |",
    `| ${plan.metrics.jobs} | ${plan.metrics.phrases} | ${plan.metrics.pillars} | ${plan.metrics.sections} | ${plan.metrics.skipped} | ${plan.metrics.holes} |`,
    "",
  ];

  if (!plan.chapters.length) {
    lines.push("_No active chapters in this plan._", "");
  } else {
    for (const chapter of plan.chapters) renderFeatureSection(lines, chapter);
  }

  if (plan.appendix.length) {
    lines.push("## Appendix (skip — no demonstrated demand)", "");
    for (const chapter of plan.appendix) {
      lines.push(`- **${featureTitle(chapter)}** — ${chapter.proof.join(", ")}`);
    }
    lines.push("");
  }

  if (plan.productHoles.length) {
    lines.push("## Product holes (demand with no job match)", "");
    for (const phrase of plan.productHoles) lines.push(`- ${phrase}`);
    lines.push("");
  }

  return `${lines.join("\n")}\n`;
}

export function defaultProductPlanDir(): string {
  return path.join(resolvedResultsDir(), "product-plan");
}

export async function readProductPlan(
  outDir = defaultProductPlanDir()
): Promise<{ plan: ProductPlan; markdown: string; outDir: string } | null> {
  try {
    const jsonPath = path.join(outDir, "product-plan.json");
    const mdPath = path.join(outDir, "product-plan.md");
    const [json, markdown] = await Promise.all([
      fs.readFile(jsonPath, "utf8"),
      fs.readFile(mdPath, "utf8").catch(() => ""),
    ]);
    return {
      plan: JSON.parse(json) as ProductPlan,
      markdown,
      outDir,
    };
  } catch {
    return null;
  }
}

export async function renderProductPlanFromDir(
  outDir: string
): Promise<{ json: string; markdown: string }> {
  const jsonPath = path.join(outDir, "product-plan.json");
  const plan = JSON.parse(await fs.readFile(jsonPath, "utf8")) as ProductPlan;
  return writeProductPlan(plan, outDir);
}

export async function writeProductPlan(
  plan: ProductPlan,
  outDir: string
): Promise<{ json: string; markdown: string }> {
  await fs.mkdir(outDir, { recursive: true });
  const json = path.join(outDir, "product-plan.json");
  const markdown = path.join(outDir, "product-plan.md");
  await Promise.all([
    fs.writeFile(json, `${JSON.stringify(plan, null, 2)}\n`, "utf8"),
    fs.writeFile(markdown, renderProductPlanMarkdown(plan), "utf8"),
  ]);
  return { json, markdown };
}

const PLAN_ARTIFACTS = [
  "product-plan.json",
  "product-plan.md",
  "product-plan.decide.in.json",
  "product-plan.decide.out.json",
  "product-plan.questions.json",
];

function recountPlan(plan: ProductPlan): ProductPlan {
  const rows = [...plan.chapters, ...plan.appendix];
  return {
    ...plan,
    generatedAt: new Date().toISOString(),
    metrics: {
      jobs: rows.length,
      phrases: rows.reduce((count, row) => count + row.phrases.length, 0),
      pillars: plan.chapters.filter((row) => row.action === "pillar").length,
      sections: plan.chapters.filter((row) => row.action === "section").length,
      skipped: plan.appendix.length,
      holes: plan.productHoles.length,
    },
  };
}

export async function clearProductPlan(
  outDir = defaultProductPlanDir()
): Promise<void> {
  await Promise.all(
    PLAN_ARTIFACTS.map((name) =>
      fs.unlink(path.join(outDir, name)).catch(() => undefined)
    )
  );
  await deletePlanCache(productPlanCacheDir(outDir));
  resetProductPlanRun(outDir);
}

export async function removeProductPlanJobs(
  jobIds: string[],
  outDir = defaultProductPlanDir()
): Promise<{ plan: ProductPlan; markdown: string; outDir: string } | null> {
  const ids = new Set(jobIds.filter(Boolean));
  if (!ids.size) return readProductPlan(outDir);
  const cacheDir = productPlanCacheDir(outDir);
  await Promise.all([
    ...[...ids].map((id) => deleteJobStageCache(cacheDir, id)),
    deleteDecideCache(cacheDir),
    ...["product-plan.decide.in.json", "product-plan.decide.out.json"].map(
      (name) => fs.unlink(path.join(outDir, name)).catch(() => undefined)
    ),
  ]);
  const saved = await readProductPlan(outDir);
  if (!saved) return null;
  const keep = (row: ProductPlan["chapters"][number]) => !ids.has(row.jobId);
  if (
    saved.plan.chapters.every(keep) &&
    saved.plan.appendix.every(keep)
  ) {
    return saved;
  }
  const next = recountPlan({
    ...saved.plan,
    chapters: saved.plan.chapters.filter(keep),
    appendix: saved.plan.appendix.filter(keep),
  });
  if (!next.chapters.length && !next.appendix.length) {
    await clearProductPlan(outDir);
    return null;
  }
  await writeProductPlan(next, outDir);
  return readProductPlan(outDir);
}

export async function runProductPlan(
  input: ProductPlanInput = {},
  deps: ProductPlanDependencies = {}
): Promise<ProductPlan> {
  const outDir = input.outDir;
  const [snapshot, settings] = await Promise.all([
    (deps.loadSnapshot ?? loadCapabilitySnapshot)(input.snapshotPath),
    (deps.loadSettings ?? loadAppConfig)(),
  ]);
  const jobs = selectJobs(harvestProductJobs(snapshot), input);
  beginProductPlanRun({ outDir, jobs: jobs.length });
  try {
    return await runProductPlanBody(input, deps, {
      snapshot,
      settings,
      jobs,
    });
  } catch (err) {
    endProductPlanRun("error", err);
    throw err;
  }
}

async function runProductPlanBody(
  input: ProductPlanInput,
  deps: ProductPlanDependencies,
  loaded: {
    snapshot: Awaited<ReturnType<typeof loadCapabilitySnapshot>>;
    settings: Awaited<ReturnType<typeof loadAppConfig>>;
    jobs: ProductJob[];
  }
): Promise<ProductPlan> {
  const { snapshot, settings, jobs } = loaded;
  if (!jobs.length) throw new Error("No product jobs matched the requested sample");
  const locale = { ...DEFAULT_LOCALE, ...input.locale };
  const calls = input.serpCallsPerJob ?? 2;
  const options = discoveryOptions(calls);
  const discover = deps.discover ?? defaultDiscovery;
  const useCache = input.useCache ?? Boolean(input.outDir);
  const cacheDir = input.outDir ? productPlanCacheDir(input.outDir) : "";
  noteProductPlan(
    "jobs",
    jobs.map((job) => job.label).join(", ")
  );

  const discoveries: ProductJobDiscovery[] = await Promise.all(
    jobs.map(async (job) => {
      const seeds = productJobSeeds(job);
      if (useCache && !input.forceDiscover) {
        const cached = await readDiscoveryCache(
          cacheDir,
          job,
          calls,
          locale,
          seeds
        );
        if (cached) {
          noteProductPlan("discover", "cache hit", {
            jobId: job.id,
            label: job.label,
          });
          return cached;
        }
      }
      noteProductPlan("discover", `searching ${seeds.join(" · ")}`, {
        jobId: job.id,
        label: job.label,
      });
      try {
        const result = await discover(job, seeds, locale, options);
        const row: ProductJobDiscovery = {
          job,
          phrases: result.phrases,
          landscape: result.landscape,
        };
        noteProductPlan("discover", `${result.phrases.length} phrases`, {
          jobId: job.id,
          label: job.label,
        });
        if (useCache) {
          await writeDiscoveryCache(cacheDir, row, calls, locale, seeds);
        }
        return row;
      } catch (err) {
        const message = describeSerpError(err);
        noteProductPlan("discover", message, {
          level: "warn",
          jobId: job.id,
          label: job.label,
        });
        return { job, phrases: [], landscape: [] };
      }
    })
  );

  const now = deps.now?.() ?? new Date();
  let plan = buildProductPlan(
    snapshot.product,
    jobs,
    discoveries,
    new Map(),
    now.toISOString(),
    settings.product
  );
  if (input.decide) {
    const decideFn =
      deps.decide ??
      ((chapters: ProductPlanChapter[]) =>
        decideProductPlanWithCli(
          chapters,
          input.decisionDir ?? input.outDir ?? path.join(process.cwd(), "data", "results")
        ));
    const digest = discoveryDigest(discoveries);
    let decisions: ReadonlyMap<string, ProductPlanDecision>;
    if (useCache && !input.forceDecide) {
      const cached = await readDecideCache(cacheDir, digest);
      if (cached) {
        noteProductPlan("decide", "cache hit");
        decisions = cached;
      } else {
        noteProductPlan("decide", `asking LLM for ${allChapters(plan).length} chapters`);
        decisions = await decideFn(allChapters(plan));
        if (useCache) await writeDecideCache(cacheDir, digest, decisions);
      }
    } else {
      noteProductPlan("decide", `asking LLM for ${allChapters(plan).length} chapters`);
      decisions = await decideFn(allChapters(plan));
      if (useCache) {
        await writeDecideCache(cacheDir, digest, decisions);
      }
    }
    plan = buildProductPlan(
      snapshot.product,
      jobs,
      discoveries,
      decisions,
      now.toISOString(),
      settings.product
    );
  }

  const pillars = () =>
    plan.chapters.filter((candidate) => candidate.action === "pillar");
  const evidence = new Map<string, ProductPlanEvidence>();

  if (input.qualify !== false) {
    const qualifyFn = deps.qualify ?? defaultQualification;
    const pillarChapters = pillars();
    noteProductPlan("qualify", `${pillarChapters.length} pillar${pillarChapters.length === 1 ? "" : "s"}`);
    for (const chapter of pillarChapters) {
      let row: ProductPlanEvidence | null = null;
      if (useCache && !input.forceQualify) {
        row = await readQualifyCache(
          cacheDir,
          chapter.jobId,
          chapter.canonicalQuery,
          locale
        );
        if (row) {
          noteProductPlan("qualify", "cache hit", {
            jobId: chapter.jobId,
            label: chapter.label,
          });
        }
      }
      if (!row) {
        noteProductPlan("qualify", `Google “${chapter.canonicalQuery}”`, {
          jobId: chapter.jobId,
          label: chapter.label,
        });
        try {
          row = serpOnlyEvidence(await qualifyFn(chapter, locale));
          noteProductPlan(
            "qualify",
            `${row.organics.length} organics${row.aiOverview ? " + AI overview" : ""}`,
            { jobId: chapter.jobId, label: chapter.label }
          );
          if (useCache) {
            await writeQualifyCache(
              cacheDir,
              chapter.jobId,
              chapter.canonicalQuery,
              locale,
              row
            );
          }
        } catch (err) {
          const message = describeSerpError(err);
          noteProductPlan("qualify", message, {
            level: "warn",
            jobId: chapter.jobId,
            label: chapter.label,
          });
          row = {
            query: chapter.canonicalQuery,
            organics: [],
            error: message,
          };
        }
      }
      evidence.set(chapter.jobId, row);
    }
  }

  if (input.enrich) {
    const enrichSpecs: EnricherSpec[] = Array.isArray(input.enrichers)
      ? input.enrichers
      : parseEnricherSpecs(input.enrichers || "meta");
    const names = enricherNames(enrichSpecs);
    const enrichFn =
      deps.enrich ??
      ((_: ProductPlanChapter, row: ProductPlanEvidence) =>
        defaultEnrichment(row, enrichSpecs));
    for (const chapter of pillars()) {
      let row = evidence.get(chapter.jobId) ?? null;
      if (!row && useCache) {
        row = await readQualifyCache(
          cacheDir,
          chapter.jobId,
          chapter.canonicalQuery,
          locale
        );
      }
      if (!row || row.error) continue;
      const urls = organicUrls(row);
      noteProductPlan("enrich", `${urls.length} ranking pages`, {
        jobId: chapter.jobId,
        label: chapter.label,
      });
      let sites: Record<string, SiteMeta> | null = null;
      if (useCache && !input.forceEnrich) {
        sites = await readEnrichCache(cacheDir, chapter.jobId, urls, names);
      }
      if (!sites) {
        try {
          sites = await enrichFn(chapter, row);
          if (useCache) {
            await writeEnrichCache(cacheDir, chapter.jobId, urls, names, sites);
          }
        } catch (err) {
          const message = describeSerpError(err);
          noteProductPlan("enrich", message, {
            level: "warn",
            jobId: chapter.jobId,
            label: chapter.label,
          });
          continue;
        }
      }
      evidence.set(chapter.jobId, { ...row, sites });
    }
  }

  if (evidence.size) plan = applyEvidence(plan, evidence);
  if (input.outDir) {
    await writeProductPlan(plan, input.outDir);
    noteProductPlan(
      "write",
      `${plan.metrics.pillars} pillars · ${plan.metrics.phrases} phrases`
    );
  }
  endProductPlanRun("ok");
  return plan;
}
