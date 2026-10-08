import { classifyPhrase } from "./classify.js";
import type { OrganicResult, SearchDocument } from "./phrases.js";

export interface SearchSnapshot {
  headline: string;
  flags: string[];
  write: number;
  faq: number;
  cluster: number;
  skip: number;
  qualified: number;
  questions: number;
  avgNiche: number | null;
  seedQuery: string | null;
  seedFeatures: string[];
  topHosts: string[];
  productShare: number | null;
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

function isProductResult(row: OrganicResult): boolean {
  const host = hostOf(row.link) ?? "";
  if (/play\.google|apps\.apple|amazon\.|bestbuy\.|ebay\./i.test(host)) {
    return true;
  }
  try {
    const path = new URL(row.link).pathname;
    if (path === "/" || path === "") return true;
  } catch {
    // ignore
  }
  return /\b(app|online|free|download|chrome web store)\b/i.test(row.title);
}

function collectOrganics(doc: SearchDocument): OrganicResult[] {
  const out: OrganicResult[] = [];
  const seed = doc.landscape?.[0];
  if (seed?.organics.length) out.push(...seed.organics);
  for (const phrase of doc.phrases) {
    if (phrase.serp?.organics?.length) out.push(...phrase.serp.organics);
  }
  return out;
}

export function buildSearchSnapshot(doc: SearchDocument): SearchSnapshot {
  let write = 0;
  let faq = 0;
  let cluster = 0;
  let skip = 0;
  let qualified = 0;
  let questions = 0;
  let nicheSum = 0;
  let nicheN = 0;

  for (const row of doc.phrases) {
    const role = (row.class ?? classifyPhrase(row.phrase)).role;
    if (role === "write") write += 1;
    else if (role === "faq") faq += 1;
    else if (role === "cluster") cluster += 1;
    else skip += 1;
    if (row.serp?.organics?.length) qualified += 1;
    if (row.scores.isQuestion) questions += 1;
    if (role !== "skip") {
      nicheSum += row.scores.niche;
      nicheN += 1;
    }
  }

  const seed = doc.landscape?.[0];
  const seedOrganics = seed?.organics ?? [];
  const productHits = seedOrganics.filter(isProductResult).length;
  const productShare =
    seedOrganics.length > 0 ? productHits / seedOrganics.length : null;

  const hostCounts = new Map<string, number>();
  for (const row of collectOrganics(doc)) {
    const host = hostOf(row.link);
    if (!host) continue;
    hostCounts.set(host, (hostCounts.get(host) ?? 0) + 1);
  }
  const topHosts = [...hostCounts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 4)
    .map(([host]) => host);

  const total = doc.phrases.length;
  const skipShare = total ? skip / total : 0;
  const avgNiche = nicheN ? Math.round(nicheSum / nicheN) : null;
  const features = seed?.features ?? [];

  const flags: string[] = [];
  if (!seedOrganics.length && !qualified) flags.push("no SERP yet");
  if (productShare != null && productShare >= 0.5) flags.push("product-heavy");
  if (features.includes("ai_overview")) flags.push("AI overview");
  if (features.includes("answer_box")) flags.push("answer box");
  if (write) flags.push(`${write} write`);
  if (faq) flags.push(`${faq} faq`);
  if (skipShare >= 0.45) flags.push(`${skip} skip`);
  if (qualified) flags.push(`${qualified} qualified`);
  else if (write + faq > 0) flags.push("qualify next");
  if (questions) flags.push(`${questions} questions`);
  if (avgNiche != null) flags.push(`niche ${avgNiche}`);

  let headline: string;
  if (!total) {
    headline = "Empty search.";
  } else if (!seedOrganics.length && !qualified) {
    headline = "Phrases only. Qualify the seed to see how crowded the SERP is.";
  } else if (productShare != null && productShare >= 0.6) {
    headline = "Seed SERP is product-heavy. Tools and stores own the keyword. Write the questions.";
  } else if (skipShare >= 0.55) {
    headline = "A lot of off-topic / generic noise. Filter skip and ship the questions.";
  } else if (features.includes("ai_overview") || features.includes("answer_box")) {
    headline = "Crowded SERP (Google already answers). Long-tail questions are the opening.";
  } else if (qualified >= 4 && write + faq >= 4) {
    headline = "Enough qualified titles to generate. Check who ranks before writing.";
  } else {
    headline = "Mixed landscape. Skim write / faq, then Qualify the best ones.";
  }

  return {
    headline,
    flags,
    write,
    faq,
    cluster,
    skip,
    qualified,
    questions,
    avgNiche,
    seedQuery: seed?.query ?? doc.seeds[0] ?? null,
    seedFeatures: features,
    topHosts,
    productShare,
  };
}
