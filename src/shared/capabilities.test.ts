import test from "node:test";
import assert from "node:assert/strict";
import {
  compileCapabilitySnapshot,
  resolveCapability,
} from "./capabilities.js";
import { harvestProductJobs } from "./product-plan.js";
import type { ProductProfile } from "./config.js";

const product: ProductProfile = {
  name: "Tanit",
  platforms: ["windows"],
  notPlatforms: ["mac", "ios", "android", "browser"],
  doesNot: ["mac app"],
};

const snapshot = compileCapabilitySnapshot({
  generatedAt: "2026-01-01T00:00:00.000Z",
  commands: {
    commands: [
      {
        id: "resize",
        label: "Resize",
        description: "Resize and transform images",
        available: true,
        options: [
          { name: "--src", description: "Input image", type: "TEXT" },
          { name: "--help", description: "Help" },
        ],
      },
      { id: "service", label: "Internal service", available: true },
    ],
    custom_commands: [
      {
        id: "custom.product-photo",
        label: "Product",
        type: "button",
        group: "Create",
        action: "cli:transform",
        description: "Render current selection as a product photo using white studio background",
        command_name: "transform",
        args: ["--prompt", "studio", "${CURRENT_SELECTION}"],
        cwd: "${CURRENT_PATH}",
        source: {
          kind: "selection",
          files: ["shot.jpg"],
          folders: ["exports"],
          selectionMode: "perItem",
          includeSubfolders: true,
        },
        output: {
          directory: "${CURRENT_PATH}",
          filenamePattern: "{name}-product.{ext}",
          overwrite: true,
        },
        explorerFileTypes: ["image"],
        extension_maps: [{ accepts: ["jpg"], generates: ["jpg"] }],
        overlay: "Mapped from the current file in the viewer.",
      },
      {
        id: "custom.capture",
        label: "Capture",
        type: "dropdown",
        description: "Capture commands",
      },
      {
        id: "custom.open-output",
        label: "Open Output",
        type: "button",
        tooltip: "Open the command output folder",
        action: "path",
        source: { kind: "folders", folders: ["."] },
      },
    ],
  },
  xblox: {
    blocks: [
      {
        kind: "fsRead",
        label: "Read file",
        description: "Read Markdown text from a file",
      },
      {
        kind: "llmAgent",
        label: "LLM Agent",
        description: "Translate text into another language",
      },
      {
        kind: "fsWrite",
        label: "Write file",
        description: "Write translated text to a file",
      },
    ],
  },
  documents: [
    {
      id: "viewer:markdown",
      label: "Markdown",
      description: "Open and preview Markdown as a readable page.",
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
    {
      id: "translate-markdown",
      label: "Translate Markdown copy",
      source: "video/translate-markdown.xblox",
      kinds: ["fsRead", "llmAgent", "fsWrite"],
    },
  ],
});

test("normalizes and trims introspection metadata", () => {
  assert.equal(snapshot.schemaVersion, 1);
  assert.ok(snapshot.capabilities.some((node) => node.id === "command:resize"));
  assert.ok(!snapshot.capabilities.some((node) => node.id === "command:service"));
  const custom = snapshot.capabilities.find(
    (node) => node.id === "command:custom.product-photo"
  );
  assert.equal(custom?.kind, "command");
  assert.match(custom?.description ?? "", /product photo/i);
  assert.match(custom?.description ?? "", /CURRENT_SELECTION/);
  assert.match(custom?.description ?? "", /perItem/);
  assert.match(custom?.description ?? "", /\{name\}-product\.\{ext\}/);
  assert.match(custom?.description ?? "", /exports/);
  assert.ok(custom?.inputs.includes("jpg") || custom?.inputs.includes("image"));
  assert.ok(custom?.inputs.includes("shot.jpg") || custom?.inputs.includes("exports"));
  assert.ok(custom?.outputs.includes("jpg"));
  assert.ok(!snapshot.capabilities.some((node) => node.id === "command:custom.capture"));
  const tooltipOnly = snapshot.capabilities.find(
    (node) => node.id === "command:custom.open-output"
  );
  assert.match(tooltipOnly?.description ?? "", /output folder/i);
  assert.ok(tooltipOnly?.inputs.includes("."));
  const resize = snapshot.capabilities.find((node) => node.id === "command:resize");
  assert.deepEqual(resize?.options.map((option) => option.name), ["--src"]);
  assert.equal(
    snapshot.workflows.filter((flow) => flow.id === "workflow:translate-markdown")
      .length,
    1
  );
});

test("resolves direct documented and command capabilities", () => {
  const markdown = resolveCapability(
    "how can i view markdown files?",
    snapshot,
    product
  );
  assert.equal(markdown.fit, "direct");
  assert.match(markdown.nodeIds[0], /documentation:viewer:markdown/);

  const resize = resolveCapability("resize an image", snapshot, product);
  assert.equal(resize.fit, "direct");
  assert.equal(resize.nodeIds[0], "command:resize");

  const custom = resolveCapability(
    "product photo from current selection studio background",
    snapshot,
    product
  );
  assert.equal(custom.nodeIds[0], "command:custom.product-photo");
  assert.ok(
    harvestProductJobs(snapshot).some(
      (job) => job.id === "job:command:custom.product-photo"
    )
  );
});

test("requires a verified workflow for composed claims", () => {
  const match = resolveCapability(
    "translate markdown into french",
    snapshot,
    product
  );
  assert.equal(match.fit, "composed");
  assert.equal(match.workflowId, "workflow:translate-markdown");
  assert.equal(
    snapshot.workflows.filter((flow) => flow.id === "workflow:translate-markdown")
      .length,
    1
  );
  assert.deepEqual(match.nodeIds, [
    "block:fsRead",
    "block:llmAgent",
    "block:fsWrite",
  ]);
});

test("blocks denied platforms and keeps missing evidence unknown", () => {
  assert.equal(
    resolveCapability("markdown viewer for mac", snapshot, product).fit,
    "unsupported"
  );
  assert.equal(
    resolveCapability("quantum banana organizer", snapshot, product).fit,
    "unknown"
  );
});

test("does not confuse product-category browser terms with a browser platform", () => {
  assert.notEqual(
    resolveCapability("what is an s3 browser?", snapshot, product).fit,
    "unsupported"
  );
  assert.equal(
    resolveCapability("view markdown in a web browser", snapshot, product).fit,
    "unsupported"
  );
});

test("does not promote generic source and view overlap to a direct capability", () => {
  const match = resolveCapability(
    "what is an open source equivalent of s3?",
    snapshot,
    product
  );
  assert.equal(match.fit, "unknown");
  assert.deepEqual(match.nodeIds, []);
});
