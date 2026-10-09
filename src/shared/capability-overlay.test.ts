import assert from "node:assert/strict";
import test from "node:test";
import {
  applyCapabilityOverlay,
  activeCapabilitySnapshot,
  parseCapabilityOverlay,
  parseCustomCapability,
} from "./capability-overlay.js";
import { compileCapabilitySnapshot, resolveCapability } from "./capabilities.js";
import { harvestProductJobs, isCustomProductJob } from "./product-plan.js";
import { parseSettings } from "./config.js";

const snapshot = compileCapabilitySnapshot({
  generatedAt: "2026-01-01T00:00:00.000Z",
  commands: {
    commands: [
      {
        id: "resize",
        label: "Resize",
        description: "Resize and transform images",
        available: true,
      },
    ],
  },
  xblox: { blocks: [] },
  documents: [
    {
      id: "feature-markdown",
      label: "Markdown",
      description: "Open and preview Markdown as a readable page.",
      source: "feature-markdown.md",
    },
  ],
});

test("parses overlay and custom capabilities from settings", () => {
  const parsed = parseSettings({
    capabilities: {
      disabled: ["command:resize", "command:resize"],
      disabledWorkflows: ["workflow:video-recorder"],
      custom: [{ label: "Local PDF stamp", terms: "pdf, stamp" }],
    },
  });
  assert.deepEqual(parsed.capabilities?.disabled, ["command:resize"]);
  assert.equal(parsed.capabilities?.custom[0]?.id, "custom:local-pdf-stamp");
  assert.equal(parsed.capabilities?.custom[0]?.kind, "documentation");
});

test("applyCapabilityOverlay disables compiled rows and appends custom ones", () => {
  const custom = parseCustomCapability({ label: "Watermark", terms: "watermark" });
  assert.ok(custom);
  const applied = applyCapabilityOverlay(snapshot, {
    disabled: ["command:resize"],
    disabledWorkflows: [],
    custom: [custom],
  });
  assert.equal(
    applied.capabilities.find((row) => row.id === "command:resize")?.available,
    false
  );
  assert.ok(applied.capabilities.some((row) => row.id === "custom:watermark"));
  const active = activeCapabilitySnapshot(snapshot, {
    disabled: ["command:resize"],
    disabledWorkflows: [],
    custom: [custom],
  });
  assert.ok(!active.capabilities.some((row) => row.id === "command:resize"));
  assert.ok(active.capabilities.some((row) => row.id === "custom:watermark"));
});

test("disabled and custom capabilities change harvest and matching", () => {
  const custom = parseCustomCapability({
    label: "PDF stamp",
    description: "Stamp a PDF with a local overlay.",
    terms: "pdf, stamp, overlay",
  });
  assert.ok(custom);
  const overlay = {
    disabled: ["documentation:feature-markdown"],
    disabledWorkflows: [],
    custom: [custom],
  };
  const active = activeCapabilitySnapshot(snapshot, overlay);
  const jobs = harvestProductJobs(active);
  assert.ok(!jobs.some((job) => job.id.includes("feature-markdown")));
  assert.ok(jobs.some((job) => job.id === "job:custom:pdf-stamp"));
  assert.ok(
    jobs.some((job) => job.id === "job:custom:pdf-stamp" && isCustomProductJob(job))
  );
  const match = resolveCapability("how to stamp a pdf overlay", active, null);
  assert.equal(match.nodeIds[0], "custom:pdf-stamp");
  const ignored = resolveCapability(
    "how can i view markdown files?",
    active,
    null
  );
  assert.notEqual(ignored.fit, "direct");
});

test("harvests overlay custom caps that are not documentation or command", () => {
  const custom = parseCustomCapability({
    label: "Fast player",
    kind: "block",
    terms: "player, video",
  });
  assert.ok(custom);
  const active = activeCapabilitySnapshot(snapshot, {
    disabled: [],
    disabledWorkflows: [],
    custom: [custom],
  });
  const jobs = harvestProductJobs(active);
  const job = jobs.find((row) => row.id === "job:custom:fast-player");
  assert.ok(job);
  assert.equal(job?.proofKind, "documentation");
  assert.ok(job && isCustomProductJob(job));
});

test("overlay can override compiled feature description and terms", () => {
  const applied = applyCapabilityOverlay(snapshot, {
    disabled: [],
    disabledWorkflows: [],
    custom: [],
    overrides: {
      "documentation:feature-markdown": {
        description: "Read notes as a page, not a raw file.",
        terms: ["notes", "preview"],
      },
    },
  });
  const doc = applied.capabilities.find(
    (row) => row.id === "documentation:feature-markdown"
  );
  assert.equal(doc?.description, "Read notes as a page, not a raw file.");
  assert.deepEqual(doc?.terms, ["notes", "preview"]);
  const parsed = parseCapabilityOverlay({
    overrides: {
      "documentation:feature-markdown": {
        description: "Pinned copy",
        terms: "markdown, notes",
      },
    },
  });
  assert.equal(
    parsed.overrides?.["documentation:feature-markdown"]?.description,
    "Pinned copy"
  );
  assert.deepEqual(parsed.overrides?.["documentation:feature-markdown"]?.terms, [
    "markdown",
    "notes",
  ]);
  const jobs = harvestProductJobs(
    activeCapabilitySnapshot(snapshot, {
      disabled: [],
      disabledWorkflows: [],
      custom: [],
      overrides: {
        "documentation:feature-markdown": { terms: ["notes", "preview"] },
      },
    })
  );
  assert.ok(
    jobs
      .find((job) => job.id === "job:documentation:feature-markdown")
      ?.terms.includes("notes")
  );
});
