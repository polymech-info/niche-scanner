import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const exec = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..");
const tsx = path.join(root, "node_modules", "tsx", "dist", "cli.mjs");

async function run(bin, args) {
  const result = await exec(bin, args, {
    cwd: root,
    env: process.env,
    maxBuffer: 50 * 1024 * 1024,
    windowsHide: true,
  });
  if (result.stderr.trim()) process.stderr.write(result.stderr);
  return result.stdout.trim();
}

async function cli(args) {
  const stdout = await run(process.execPath, [tsx, "src/cli.ts", ...args]);
  return JSON.parse(stdout);
}

await run(process.execPath, [tsx, "scripts/capabilities/compile.ts"]);

const capabilityFile = path.join(root, "data", "product-capabilities.json");
const capabilitySnapshot = JSON.parse(await fs.readFile(capabilityFile, "utf8"));
assert.ok(
  capabilitySnapshot.sources.documentation.some((source) =>
    source.endsWith("releases/web-docs/features/feature-video.md")
  ),
  "feature-video.md must be present in capability provenance"
);

let search;
let qualified;
if (process.env.E2E_SEARCH_ID) {
  const saved = JSON.parse(
    await fs.readFile(
      path.join(root, "data", "searches", `${process.env.E2E_SEARCH_ID}.json`),
      "utf8"
    )
  );
  search = { id: saved.id, phraseCount: saved.phrases.length };
  qualified = {
    qualified: saved.phrases.filter((phrase) => phrase.serp?.organics?.length)
      .length,
  };
} else {
  search = await cli([
    "search",
    "video screen recorder",
    "--name",
    "E2E video screen recorder",
  ]);
  assert.ok(search.id, "search must return an id");
  assert.ok(search.phraseCount > 0, "search must discover phrases");

  qualified = await cli(["qualify", search.id, "--limit", "6"]);
  await cli([
    "enrich",
    search.id,
    "--enrichers",
    "meta,ai",
    "--limit",
    "12",
  ]);
}
assert.ok(qualified.qualified > 0, "at least one phrase must have ranking links");

const generated = await cli(["generate", search.id, "--no-llm"]);
const articlePackage = JSON.parse(await fs.readFile(generated.articles, "utf8"));
const report = await fs.readFile(generated.report, "utf8");

assert.equal(articlePackage.searchId, search.id);
assert.ok(articlePackage.hubs.length > 0, "generate must select at least one hub");
assert.ok(
  articlePackage.hubs.some((hub) =>
    hub.productMatch.nodeIds.some(
      (id) =>
        id === "command:video" ||
        id === "block:videoCapture" ||
        id.includes("video-record")
    )
  ),
  "a selected hub must cite video-record capability evidence"
);
assert.ok(
  articlePackage.hubs.every((hub) =>
    ["direct", "composed", "editorial"].includes(hub.fit)
  ),
  "selected hubs must have defensible product fit"
);
assert.ok(
  articlePackage.hubs.every(
    (hub) => !/\b(online|phone|android|iphone|mac)\b/i.test(hub.h1)
  ),
  "unsupported platform-only questions must be filtered"
);
assert.ok(
  articlePackage.generate.every(
    (brief) =>
      brief.productMatch &&
      brief.outline?.length &&
      Array.isArray(brief.contentGaps)
  ),
  "writer handoff must include grounding, outline, and content gaps"
);
assert.match(report, /Product evidence:/);
assert.match(report, /video/i);
assert.doesNotMatch(report, /articleBody|finished article/i);

process.stdout.write(
  `${JSON.stringify(
    {
      ok: true,
      searchId: search.id,
      phrases: search.phraseCount,
      qualified: qualified.qualified,
      hubs: articlePackage.hubs.map((hub) => ({
        h1: hub.h1,
        fit: hub.fit,
        outcome: hub.outcome,
        evidence: hub.productMatch.nodeIds,
      })),
      articles: generated.articles,
      report: generated.report,
    },
    null,
    2
  )}\n`
);
