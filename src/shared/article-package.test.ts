import test from "node:test";
import assert from "node:assert/strict";
import {
  buildArticlePackage,
  isSeedRelevant,
  renderReportMarkdown,
} from "./brief.js";
import { compileCapabilitySnapshot } from "./capabilities.js";
import type { SearchDocument } from "./phrases.js";
import type { AppSettings } from "./config.js";

const settings: AppSettings = {
  blacklist: [],
  product: {
    name: "Tanit",
    summary: "Windows desktop app.",
    platforms: ["windows"],
    notPlatforms: ["mac", "ios", "android", "browser"],
    doesNot: ["mac app"],
  },
};

const capabilities = compileCapabilitySnapshot({
  generatedAt: "2026-01-01T00:00:00.000Z",
  commands: { commands: [] },
  xblox: { blocks: [] },
  documents: [
    {
      id: "viewer:markdown",
      label: "Markdown viewer",
      description: "Open and preview Markdown files as rendered pages.",
      source: "viewer.md",
    },
  ],
});

test("requires candidate phrases to retain the original seed job", () => {
  const seed = ["s3 browser filemanager"];
  assert.equal(isSeedRelevant("how to connect to s3 browser?", seed), true);
  assert.equal(isSeedRelevant("what is an s3 browser?", seed), true);
  assert.equal(
    isSeedRelevant("what is an open source equivalent of s3?", seed),
    false
  );
  assert.equal(isSeedRelevant("does google have an s3 equivalent?", seed), false);
});

function phrase(
  value: string,
  niche: number,
  serp: SearchDocument["phrases"][number]["serp"] = null
): SearchDocument["phrases"][number] {
  return {
    phrase: value,
    sources: ["people_also_ask"],
    seeds: ["markdown viewer"],
    scores: {
      niche,
      wordCount: value.split(/\s+/).length,
      isQuestion: value.endsWith("?"),
      relevance: null,
      sourceCount: 1,
    },
    addedAt: "2026-01-01T00:00:00.000Z",
    serp,
  };
}

const doc: SearchDocument = {
  id: "markdown-viewer-test",
  name: "markdown viewer",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  locale: { gl: "us", hl: "en", googleDomain: "google.com" },
  seeds: ["markdown viewer"],
  options: {
    engines: ["autocomplete"],
    paaDepth: 0,
    alphabet: false,
    questionPrefixes: false,
  },
  phrases: [
    phrase("how can i view markdown files?", 80, {
      engine: "google",
      searchId: "1",
      organics: [
        {
          position: 1,
          title: "Markdown guide",
          link: "https://example.com/markdown",
          snippet: "Open Markdown in an editor.",
        },
        {
          position: 2,
          title: "Reddit thread",
          link: "https://reddit.com/r/markdown/x",
        },
      ],
    }),
    phrase("what is the best markdown viewer?", 70),
    phrase("how do i organize quantum bananas?", 65),
  ],
  meta: { calls: [], errors: [] },
};

test("generate emits grounded intelligence rather than article prose", () => {
  const pkg = buildArticlePackage(
    doc,
    { minWords: 3, llmGrounding: false },
    settings,
    undefined,
    capabilities
  );
  assert.equal(pkg.generate.length, 1);
  assert.equal(pkg.hubs.length, 1);
  assert.equal(pkg.hubs[0].fit, "direct");
  assert.equal(pkg.hubs[0].questions.length, 1);
  assert.ok(pkg.generate[0].productMatch);
  assert.ok(pkg.generate[0].outline?.length);
  assert.ok(pkg.generate[0].contentGaps?.length);
  assert.equal(pkg.grounding.capabilityCount, 1);
  assert.ok(
    pkg.skip.some((row) => /drifted from the original seed/.test(row.filterReason ?? ""))
  );
  const report = renderReportMarkdown(pkg);
  assert.match(report, /generate` stops here/);
  assert.match(report, /Product evidence/);
  assert.doesNotMatch(report, /Transcribe/);
});

test("keeps social evidence as supporting intelligence", () => {
  const pkg = buildArticlePackage(
    doc,
    { minWords: 3, llmGrounding: false },
    settings,
    undefined,
    capabilities
  );
  assert.equal(pkg.social[0]?.network, "reddit");
  assert.match(renderReportMarkdown(pkg), /## Extra leaves/);
});

test("platform policy blocks incompatible product claims", () => {
  const macDoc = {
    ...doc,
    phrases: [phrase("how can i view markdown files on mac?", 80)],
  };
  const pkg = buildArticlePackage(
    macDoc,
    { minWords: 3, llmGrounding: false },
    settings,
    undefined,
    capabilities
  );
  assert.equal(pkg.hubs.length, 0);
  assert.equal(pkg.skip[0].productMatch?.fit, "unsupported");
  assert.match(pkg.skip[0].filterReason ?? "", /unsupported/);
});

test("SEO thresholds run before capability planning", () => {
  const pkg = buildArticlePackage(
    doc,
    { minNiche: 95, qualifiedOnly: true, llmGrounding: false },
    settings,
    undefined,
    capabilities
  );
  assert.equal(pkg.generate.length, 0);
  assert.ok(pkg.skip.some((row) => row.filterReason?.includes("niche")));
});
