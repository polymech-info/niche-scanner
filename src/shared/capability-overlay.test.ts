import assert from "node:assert/strict";
import test from "node:test";
import {
  applyCapabilityOverlay,
  activeCapabilitySnapshot,
  parseCapabilityOverlay,
  parseCustomCapability,
} from "./capability-overlay.js";
import { compileCapabilitySnapshot, resolveCapability } from "./capabilities.js";
import { harvestProductJobs } from "./product-plan.js";
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
  const match = resolveCapability("how to stamp a pdf overlay", active, null);
  assert.equal(match.nodeIds[0], "custom:pdf-stamp");
  const ignored = resolveCapability(
    "how can i view markdown files?",
    active,
    null
  );
  assert.notEqual(ignored.fit, "direct");
});
