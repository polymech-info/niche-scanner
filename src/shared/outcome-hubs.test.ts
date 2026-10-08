import test from "node:test";
import assert from "node:assert/strict";
import { compileCapabilitySnapshot } from "./capabilities.js";
import { applyProduct, clusterHubs } from "./outcome-hubs.js";
import type { ProductProfile } from "./config.js";

const product: ProductProfile = {
  name: "Tanit",
  platforms: ["windows"],
  notPlatforms: ["mac", "ios", "android", "browser"],
  doesNot: [],
};

const snapshot = compileCapabilitySnapshot({
  commands: {
    commands: [
      {
        id: "resize",
        label: "Resize",
        description: "Resize images",
        available: true,
      },
    ],
  },
  xblox: {
    blocks: [
      { kind: "fsRead", label: "Read file", description: "Read Markdown text" },
      {
        kind: "llmAgent",
        label: "Translate",
        description: "Translate text into another language",
      },
      { kind: "fsWrite", label: "Write file", description: "Write text" },
    ],
  },
  documents: [
    {
      id: "viewer:markdown",
      label: "Markdown viewer",
      description: "Open and preview Markdown files.",
      source: "viewer.md",
    },
  ],
  workflows: [
    {
      id: "translate-markdown",
      label: "Translate Markdown",
      source: "translate-markdown.xblox",
      kinds: ["fsRead", "llmAgent", "fsWrite"],
    },
  ],
});

function member(title: string, niche = 70) {
  return {
    title,
    niche,
    qualified: true,
    competitors: [],
    googleUrl: `https://google.test/?q=${encodeURIComponent(title)}`,
  };
}

test("groups questions by verified outcome and keeps follow-ups", () => {
  const { hubs } = clusterHubs(
    [
      member("how can i view markdown files?", 80),
      member("what is the best markdown viewer?", 70),
      member("translate markdown into french", 75),
    ],
    ["markdown viewer"],
    12,
    product,
    snapshot
  );
  assert.equal(hubs.length, 2);
  const viewer = hubs.find((hub) => hub.productMatch.fit === "direct");
  assert.ok(viewer);
  assert.ok(viewer.questions.includes("what is the best markdown viewer?"));
  assert.ok(viewer.outline.some((section) => section.startsWith("Directly answer")));
  const translation = hubs.find((hub) => hub.productMatch.fit === "composed");
  assert.equal(translation?.productMatch.workflowId, "workflow:translate-markdown");
});

test("splits materially different requested outputs", () => {
  const { hubs } = clusterHubs(
    [
      member("translate markdown into french"),
      member("translate markdown into german"),
    ],
    [],
    12,
    product,
    snapshot
  );
  assert.equal(hubs.length, 2);
});

test("filters unsupported and unknown outcomes before max pages", () => {
  const clustered = clusterHubs(
    [
      member("markdown viewer for mac", 90),
      member("quantum banana organizer", 80),
      member("resize an image", 70),
    ],
    [],
    12,
    product,
    snapshot
  );
  const grounded = applyProduct(clustered.hubs, product);
  assert.equal(grounded.hubs.length, 1);
  assert.equal(grounded.hubs[0].productMatch.fit, "direct");
  assert.deepEqual(
    grounded.blocked.map((hub) => hub.productMatch.fit).sort(),
    ["unknown", "unsupported"]
  );
});
