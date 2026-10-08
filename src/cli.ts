#!/usr/bin/env node

import path from "path";
import { fileURLToPath } from "url";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import { startServer } from "./server/index.js";
import {
  DEFAULT_LOCALE,
  addManualPhrase,
  removePhrase,
  createSearch,
  deleteSearch,
  expandSearch,
  getSearch,
  listSearches,
  applyDataRoot,
  loadEnv,
  parseEngines,
  qualifySearch,
  enrichSearch,
  discoverMore,
  generateResults,
  parseGenerateOptions,
  parseEnricherSpecs,
  openNeighbor,
  runPipeline,
  runProductPlan,
  renderProductPlanFromDir,
  clearProductPlan,
  removeProductPlanJobs,
} from "./lib/index.js";
import { resolvedResultsDir } from "./lib/env.js";

loadEnv();

const here = path.dirname(fileURLToPath(import.meta.url));
const runningFromSource = path.basename(here) === "src";

function localeFrom(argv: {
  gl?: string;
  hl?: string;
  domain?: string;
}) {
  return {
    gl: argv.gl || DEFAULT_LOCALE.gl,
    hl: argv.hl || DEFAULT_LOCALE.hl,
    googleDomain: argv.domain || DEFAULT_LOCALE.googleDomain,
  };
}

function optionsFrom(argv: {
  engines?: string;
  paaDepth?: number;
  alphabet?: boolean;
  questions?: boolean;
}) {
  return {
    engines: parseEngines(argv.engines),
    paaDepth: argv.paaDepth ?? 0,
    alphabet: Boolean(argv.alphabet),
    questionPrefixes: Boolean(argv.questions),
  };
}

function printJson(value: unknown) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

async function serveCommand(argv: {
  port?: number;
  browser?: boolean;
}) {
  const preferredPort = argv.port ?? 3780;
  const noBrowser =
    argv.browser === false ||
    process.env.PHRASES_NO_BROWSER === "1" ||
    runningFromSource;

  const { port } = await startServer(preferredPort, {
    allowPortFallback: !runningFromSource,
  });

  if (noBrowser) return;
  const { default: open } = await import("open");
  const url = runningFromSource
    ? "http://127.0.0.1:5175"
    : `http://127.0.0.1:${port}`;
  await open(url);
}

const discoverFlags = {
  engines: {
    type: "string" as const,
    default: "ac,rs,rq",
    describe: "Comma list: ac, rs, rq",
  },
  paaDepth: {
    alias: "paa-depth",
    type: "number" as const,
    default: 0,
    describe: "People Also Ask expansion depth (0–4)",
  },
  alphabet: {
    type: "boolean" as const,
    default: false,
    describe: "Alphabet-soup autocomplete (26 extra calls per seed)",
  },
  questions: {
    type: "boolean" as const,
    default: false,
    describe: "Prefix seeds with how/what/why/...",
  },
  gl: { type: "string" as const, default: DEFAULT_LOCALE.gl },
  hl: { type: "string" as const, default: DEFAULT_LOCALE.hl },
  domain: { type: "string" as const, default: DEFAULT_LOCALE.googleDomain },
};

await yargs(hideBin(process.argv))
  .scriptName("phrases")
  .usage("$0 <command>")
  .command(
    ["$0", "serve"],
    "Start the local GUI + REST server",
    (y) =>
      y
        .option("port", { type: "number", default: 3780 })
        .option("browser", { type: "boolean", default: true }),
    (argv) => serveCommand(argv)
  )
  .command(
    "run [keywords..]",
    "One shot: search → qualify → enrich → discover-more → generate",
    (y) =>
      y
        .positional("keywords", { type: "string", array: true })
        .option("id", {
          type: "string",
          describe: "Resume an existing search (skip seed)",
        })
        .option("name", { type: "string", describe: "Search display name" })
        .options(discoverFlags)
        .option("qualify-limit", { type: "number", default: 6 })
        .option("questions-only", { type: "boolean", default: false })
        .option("enrichers", {
          type: "string",
          default: "meta,ai",
          describe: "Comma list of enrichers (meta, ai)",
        })
        .option("enrich-limit", {
          type: "number",
          default: 20,
          describe: "Max unique ranking URLs to fetch",
        })
        .option("force", {
          type: "boolean",
          default: false,
          describe: "Re-fetch enrich + ignore discover cache",
        })
        .option("max-hubs", { type: "number", default: 8 })
        .option("dry-run", {
          type: "boolean",
          default: false,
          describe: "discover-more: tanit-cli json-stub (no live LLM)",
        })
        .option("out", {
          type: "string",
          describe: "Parent output directory (writes <out>/<search-id>/)",
        })
        .option("min-niche", { type: "number", default: 40 })
        .option("min-words", { type: "number", default: 4 })
        .option("max", { type: "number", default: 12, describe: "Max articles" })
        .option("roles", { type: "string", default: "write,faq" })
        .option("qualified-only", { type: "boolean", default: false })
        .option("skip-qualify", { type: "boolean", default: false })
        .option("skip-enrich", { type: "boolean", default: false })
        .option("skip-discover", { type: "boolean", default: false })
        .option("skip-generate", { type: "boolean", default: false }),
    async (argv) => {
      const result = await runPipeline({
        seeds: (argv.keywords as string[] | undefined) ?? [],
        id: argv.id,
        name: argv.name,
        locale: localeFrom(argv),
        options: optionsFrom(argv),
        qualifyLimit: argv.qualifyLimit,
        questionsOnly: Boolean(argv.questionsOnly),
        enrichers: argv.enrichers,
        enrichLimit: argv.enrichLimit,
        force: Boolean(argv.force),
        maxHubs: argv.maxHubs,
        dryRun: Boolean(argv.dryRun),
        outDir: argv.out,
        generate: parseGenerateOptions({
          minNiche: argv.minNiche,
          minWords: argv.minWords,
          maxGenerate: argv.max,
          roles: argv.roles,
          questionsOnly: argv.questionsOnly,
          qualifiedOnly: argv.qualifiedOnly,
        }),
        skipQualify: Boolean(argv.skipQualify),
        skipEnrich: Boolean(argv.skipEnrich),
        skipDiscover: Boolean(argv.skipDiscover),
        skipGenerate: Boolean(argv.skipGenerate),
      });
      printJson({
        id: result.id,
        name: result.name,
        phraseCount: result.phraseCount,
        steps: result.steps,
        enrich: result.enrich,
        discover: result.discover
          ? {
              fromCache: result.discover.fromCache,
              cacheHits: result.discover.cacheHits,
              transformed: result.discover.transformed,
              neighbors: result.discover.neighbors.map((row) => row.seed),
            }
          : undefined,
        generate: result.generate,
        errors: result.errors,
      });
      if (result.steps.some((step) => !step.ok)) process.exitCode = 1;
    }
  )
  .command(
    "search <keywords..>",
    "Discover niche phrases and write a JSON search file",
    (y) =>
      y
        .positional("keywords", {
          type: "string",
          array: true,
          demandOption: true,
        })
        .option("name", { type: "string", describe: "Search display name" })
        .options(discoverFlags),
    async (argv) => {
      const doc = await createSearch({
        seeds: argv.keywords as string[],
        name: argv.name,
        locale: localeFrom(argv),
        options: optionsFrom(argv),
      });
      printJson({
        id: doc.id,
        name: doc.name,
        file: `${doc.id}.json`,
        phraseCount: doc.phrases.length,
        calls: doc.meta.calls.length,
        errors: doc.meta.errors,
        phrases: doc.phrases.slice(0, 20).map((p) => ({
          phrase: p.phrase,
          niche: p.scores.niche,
          sources: p.sources,
        })),
      });
      if (!doc.phrases.length && doc.meta.errors.length) process.exitCode = 1;
    }
  )
  .command(
    "list",
    "List saved searches",
    () => undefined,
    async () => {
      printJson(await listSearches());
    }
  )
  .command(
    "show <id>",
    "Print a saved search JSON document",
    (y) => y.positional("id", { type: "string", demandOption: true }),
    async (argv) => {
      printJson(await getSearch(argv.id as string));
    }
  )
  .command(
    "expand <id> [keywords..]",
    "Run more discovery into an existing search",
    (y) =>
      y
        .positional("id", { type: "string", demandOption: true })
        .positional("keywords", { type: "string", array: true })
        .options(discoverFlags),
    async (argv) => {
      const doc = await expandSearch({
        id: argv.id as string,
        seeds: (argv.keywords as string[] | undefined) ?? [],
        options: optionsFrom(argv),
      });
      printJson({
        id: doc.id,
        phraseCount: doc.phrases.length,
        calls: doc.meta.calls.length,
        errors: doc.meta.errors,
      });
    }
  )
  .command(
    "qualify <id>",
    "Pull answers + ranking links for the best phrases in a search",
    (y) =>
      y
        .positional("id", { type: "string", demandOption: true })
        .option("limit", { type: "number", default: 6 })
        .option("questions-only", { type: "boolean", default: false }),
    async (argv) => {
      const doc = await qualifySearch({
        id: argv.id as string,
        limit: argv.limit,
        questionsOnly: Boolean(argv.questionsOnly),
      });
      printJson({
        id: doc.id,
        phraseCount: doc.phrases.length,
        qualified: doc.phrases.filter((p) => p.serp?.organics?.length).length,
        questions: doc.phrases.filter((p) => p.serp?.answer?.snippet).length,
        landscape: (doc.landscape ?? []).map((row) => ({
          query: row.query,
          results: row.organics.length,
          features: row.features,
        })),
        errors: doc.meta.errors,
      });
    }
  )
  .command(
    "enrich <id>",
    "Fetch site meta and Google AI overview text",
    (y) =>
      y
        .positional("id", { type: "string", demandOption: true })
        .option("enrichers", {
          type: "string",
          default: "meta,ai",
          describe: "Comma list of enrichers (meta, ai)",
        })
        .option("limit", {
          type: "number",
          default: 20,
          describe: "Max unique ranking URLs to fetch",
        })
        .option("force", {
          type: "boolean",
          default: false,
          describe: "Re-fetch URLs that already have meta",
        }),
    async (argv) => {
      const result = await enrichSearch({
        id: argv.id as string,
        enrichers: parseEnricherSpecs(argv.enrichers),
        limit: argv.limit,
        force: Boolean(argv.force),
      });
      const sites = Object.values(result.doc.sites ?? {});
      printJson({
        id: result.doc.id,
        fetched: result.fetched,
        cached: result.cached,
        failed: result.failed,
        skipped: result.skipped,
        aiFetched: result.aiFetched,
        aiCached: result.aiCached,
        aiFailed: result.aiFailed,
        aiSkipped: result.aiSkipped,
        sites: sites.slice(0, 20).map((site) => ({
          url: site.url,
          title: site.title,
          description: site.description,
          error: site.error,
          ms: site.ms,
        })),
      });
    }
  )
  .command(
    "discover-more <id>",
    "LLM: suggest linked next searches (tanit-cli each, cached)",
    (y) =>
      y
        .positional("id", { type: "string", demandOption: true })
        .option("force", {
          type: "boolean",
          default: false,
          describe: "Ignore local neighbors and the CLI string cache",
        })
        .option("max-hubs", {
          type: "number",
          default: 8,
          describe: "Max seed / survivor / related phrases sent to the LLM",
        })
        .option("dry-run", {
          type: "boolean",
          default: false,
          describe: "Write hubs JSON and run tanit-cli json-stub (no live LLM)",
        }),
    async (argv) => {
      const result = await discoverMore({
        id: argv.id as string,
        force: Boolean(argv.force),
        maxHubs: argv.maxHubs,
        dryRun: Boolean(argv.dryRun),
      });
      printJson({
        id: result.doc.id,
        fromCache: result.fromCache,
        cacheHits: result.cacheHits,
        transformed: result.transformed,
        hubs: result.hubs.map((hub) => hub.phrase),
        neighbors: result.neighbors,
      });
    }
  )
  .command(
    "open-neighbor <id> <seed..>",
    "Open a neighbor as a linked search (or jump if it already exists)",
    (y) =>
      y
        .positional("id", { type: "string", demandOption: true })
        .positional("seed", { type: "string", array: true, demandOption: true }),
    async (argv) => {
      const result = await openNeighbor({
        id: argv.id as string,
        seed: (argv.seed as string[]).join(" "),
      });
      printJson({
        parent: result.parent.id,
        child: result.child.id,
        seed: result.child.seeds[0],
        phrases: result.child.phrases.length,
      });
    }
  )
  .command(
    "add <id> <phrase..>",
    "Manually add a phrase to a saved search",
    (y) =>
      y
        .positional("id", { type: "string", demandOption: true })
        .positional("phrase", { type: "string", array: true, demandOption: true }),
    async (argv) => {
      const doc = await addManualPhrase(
        argv.id as string,
        (argv.phrase as string[]).join(" ")
      );
      printJson({ id: doc.id, phraseCount: doc.phrases.length });
    }
  )
  .command(
    "remove <id> <phrase..>",
    "Remove a phrase from a saved search",
    (y) =>
      y
        .positional("id", { type: "string", demandOption: true })
        .positional("phrase", { type: "string", array: true, demandOption: true }),
    async (argv) => {
      const doc = await removePhrase(
        argv.id as string,
        (argv.phrase as string[]).join(" ")
      );
      printJson({ id: doc.id, phraseCount: doc.phrases.length });
    }
  )
  .command(
    "generate <id>",
    "Write LLM handoff files: articles.json + report.md",
    (y) =>
      y
        .positional("id", { type: "string", demandOption: true })
        .option("out", {
          type: "string",
          describe: "Parent output directory (writes <out>/<search-id>/)",
        })
        .option("min-niche", { type: "number", default: 40 })
        .option("min-words", { type: "number", default: 4 })
        .option("max", { type: "number", default: 12, describe: "Max articles to generate" })
        .option("roles", { type: "string", default: "write,faq" })
        .option("questions-only", { type: "boolean", default: false })
        .option("qualified-only", { type: "boolean", default: false })
        .option("llm", {
          type: "boolean",
          default: true,
          describe: "Adjudicate ambiguous capability matches (use --no-llm offline)",
        }),
    async (argv) => {
      const result = await generateResults({
        id: argv.id as string,
        outDir: argv.out,
        options: parseGenerateOptions({
          minNiche: argv.minNiche,
          minWords: argv.minWords,
          maxGenerate: argv.max,
          roles: argv.roles,
          questionsOnly: argv.questionsOnly,
          qualifiedOnly: argv.qualifiedOnly,
          llmGrounding: argv.llm,
        }),
      });
      printJson({
        dir: result.dir,
        report: result.report,
        articles: result.articles,
        options: result.package.options,
        generate: result.package.metrics.generateCount,
        hubs: result.package.metrics.hubCount,
        absorbed: result.package.metrics.absorbedCount,
        skip: result.package.metrics.skipCount,
      });
    }
  )
  .command(
    "product-plan",
    "Build a product-wide master plan from the capability snapshot",
    (y) =>
      y
        .option("out", {
          type: "string",
          describe: "Output directory (default: <data>/results/product-plan)",
        })
        .option("snapshot", {
          type: "string",
          describe: "Capability snapshot JSON (default: compiled snapshot)",
        })
        .option("jobs", {
          type: "string",
          describe: "Comma-separated job ids for a small sample",
        })
        .option("max-jobs", { type: "number", describe: "Cap how many jobs to run" })
        .option("serp-budget", {
          type: "number",
          choices: [2, 4] as const,
          default: 2,
          describe: "SerpAPI budget per job: 2 = autocomplete only, 4 = + landscape",
        })
        .option("decide", {
          type: "boolean",
          default: false,
          describe: "Run tanit-cli llm agent decide on ambiguous chapters",
        })
        .option("qualify", {
          type: "boolean",
          default: true,
          describe: "Qualify pillar chapters with a Google + AI overview pass",
        })
        .option("enrich", {
          type: "boolean",
          default: false,
          describe: "Fetch ranking-page meta for pillar chapters",
        })
        .option("enrichers", {
          type: "string",
          default: "meta",
          describe: "Comma list of enrichers (meta). AI overview is part of --qualify",
        })
        .option("no-cache", {
          type: "boolean",
          default: false,
          describe: "Disable disk cache under <out>/.cache",
        })
        .option("force-discover", { type: "boolean", default: false })
        .option("force-decide", { type: "boolean", default: false })
        .option("force-qualify", { type: "boolean", default: false })
        .option("force-enrich", { type: "boolean", default: false })
        .option("force", {
          type: "boolean",
          default: false,
          describe: "Ignore all stage caches (same as all --force-* flags)",
        })
        .option("render-only", {
          type: "boolean",
          default: false,
          describe: "Regenerate product-plan.md from existing product-plan.json",
        })
        .option("clear", {
          type: "boolean",
          default: false,
          describe: "Delete product-plan artifacts and .cache",
        })
        .option("remove-jobs", {
          type: "string",
          describe: "Drop these comma-separated job ids from the saved plan",
        })
        .options({
          gl: discoverFlags.gl,
          hl: discoverFlags.hl,
          domain: discoverFlags.domain,
        }),
    async (argv) => {
      const outDir =
        (argv.out as string | undefined)?.trim() ||
        path.join(resolvedResultsDir(), "product-plan");
      if (argv.clear) {
        await clearProductPlan(outDir);
        printJson({ ok: true, cleared: true, outDir });
        return;
      }
      const removeIds = (argv.removeJobs as string | undefined)
        ?.split(",")
        .map((id) => id.trim())
        .filter(Boolean);
      if (removeIds?.length) {
        const saved = await removeProductPlanJobs(removeIds, outDir);
        printJson({
          ok: true,
          outDir,
          removed: removeIds,
          remaining: saved
            ? [...saved.plan.chapters, ...saved.plan.appendix].map(
                (chapter) => chapter.jobId
              )
            : [],
        });
        return;
      }
      if (argv.renderOnly) {
        const files = await renderProductPlanFromDir(outDir);
        printJson({ ok: true, outDir, ...files });
        return;
      }
      const jobIds = (argv.jobs as string | undefined)
        ?.split(",")
        .map((id) => id.trim())
        .filter(Boolean);
      const force = Boolean(argv.force);
      const plan = await runProductPlan({
        outDir,
        snapshotPath: argv.snapshot as string | undefined,
        locale: localeFrom(argv),
        serpCallsPerJob: (argv.serpBudget as 2 | 4) ?? 2,
        jobIds: jobIds?.length ? jobIds : undefined,
        maxJobs: argv.maxJobs as number | undefined,
        decide: Boolean(argv.decide),
        qualify: Boolean(argv.qualify),
        enrich: Boolean(argv.enrich),
        enrichers: parseEnricherSpecs(argv.enrichers as string | undefined),
        useCache: !argv.noCache,
        forceDiscover: force || Boolean(argv.forceDiscover),
        forceDecide: force || Boolean(argv.forceDecide),
        forceQualify: force || Boolean(argv.forceQualify),
        forceEnrich: force || Boolean(argv.forceEnrich),
      });
      process.stderr.write(
        `[product-plan] open Plan in the GUI — ${path.join(outDir, "product-plan.md")}\n`
      );
      printJson({
        outDir,
        metrics: plan.metrics,
        chapters: plan.chapters.map((chapter) => ({
          jobId: chapter.jobId,
          action: chapter.action,
          canonicalQuery: chapter.canonicalQuery,
          qualified: chapter.qualified,
          gap: chapter.gap || undefined,
        })),
        appendix: plan.appendix.length,
        productHoles: plan.productHoles.length,
      });
    }
  )
  .command(
    "delete <id>",
    "Delete a saved search JSON file",
    (y) => y.positional("id", { type: "string", demandOption: true }),
    async (argv) => {
      await deleteSearch(argv.id as string);
      printJson({ ok: true, id: argv.id });
    }
  )
  .option("data-dir", {
    type: "string",
    global: true,
    describe: "Data root: searches, results, logs, config (default: ./data)",
  })
  .middleware((argv) => {
    if (argv.dataDir) applyDataRoot(String(argv.dataDir), true);
  })
  .demandCommand(0)
  .strict()
  .help()
  .parseAsync();
