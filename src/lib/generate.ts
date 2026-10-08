import fs from "fs/promises";
import path from "path";
import {
  buildArticlePackage,
  mergeGenerateOptions,
  renderReportMarkdown,
  type ArticlePackage,
  type GenerateOptions,
} from "../shared/brief.js";
import { resolvedResultsDir } from "./env.js";
import { loadAppConfig } from "./app-config.js";
import { getSearch } from "./run.js";
import type { SearchStore } from "./store.js";
import { loadCapabilitySnapshot } from "./capabilities.js";
import { adjudicateCapabilities } from "./capability-adjudication.js";
import { normalizePhrase } from "../shared/phrases.js";

export interface GenerateResult {
  dir: string;
  report: string;
  articles: string;
  markdown: string;
  package: ArticlePackage;
}

export function resultsParentDir(override?: string): string {
  return override?.trim() || resolvedResultsDir();
}

export async function generateResults(input: {
  id: string;
  outDir?: string;
  options?: Partial<GenerateOptions>;
  store?: SearchStore;
}): Promise<GenerateResult> {
  const doc = await getSearch(input.id, input.store);
  const settings = await loadAppConfig();
  const options = mergeGenerateOptions(input.options);
  const capabilitySnapshot = await loadCapabilitySnapshot();
  const dir = path.join(resultsParentDir(input.outDir), doc.id);
  await fs.mkdir(dir, { recursive: true });
  const preliminary = buildArticlePackage(
    doc,
    { ...options, llmGrounding: false },
    settings,
    process.env.SERPAPI_KEY?.trim(),
    capabilitySnapshot
  );
  const adjudicationPhrases = new Set(
    preliminary.hubs
      .filter((hub) => hub.fit === "editorial" || hub.fit === "composed")
      .flatMap((hub) => [hub.h1, ...hub.questions])
      .map(normalizePhrase)
  );
  const adjudications = await adjudicateCapabilities({
    doc,
    product: settings.product,
    snapshot: capabilitySnapshot,
    dir,
    enabled: options.llmGrounding,
    phrases: adjudicationPhrases,
  });
  const pkg = buildArticlePackage(
    doc,
    options,
    settings,
    process.env.SERPAPI_KEY?.trim(),
    capabilitySnapshot,
    adjudications
  );

  const articles = path.join(dir, "articles.json");
  const report = path.join(dir, "report.md");
  const markdown = renderReportMarkdown(pkg);
  await fs.writeFile(articles, `${JSON.stringify(pkg, null, 2)}\n`, "utf8");
  await fs.writeFile(report, markdown, "utf8");

  return { dir, report, articles, markdown, package: pkg };
}
