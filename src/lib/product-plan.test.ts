import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type {
  ProductCapability,
  ProductCapabilitySnapshot,
} from "../shared/capabilities.js";
import type { PhraseRecord, PhraseSource } from "../shared/phrases.js";
import { harvestProductJobs } from "../shared/product-plan.js";
import {
  clearProductPlan,
  productJobSeeds,
  readProductPlan,
  removeProductPlanJobs,
  renderProductPlanMarkdown,
  runProductPlan,
} from "./product-plan.js";

function capability(
  id: string,
  kind: ProductCapability["kind"],
  label: string,
  terms: string[]
): ProductCapability {
  return {
    id,
    kind,
    label,
    description: label,
    available: true,
    terms,
    options: [],
    inputs: [],
    outputs: [],
    source: `${id}.json`,
  };
}

const snapshot: ProductCapabilitySnapshot = {
  schemaVersion: 1,
  generatedAt: "2026-01-01T00:00:00.000Z",
  product: "Tanit",
  sources: {
    commands: "commands.json",
    xblox: "xblox.json",
    examples: [],
    documentation: ["releases/web-docs/features/feature-markdown.md"],
  },
  capabilities: [
    capability("block:videoCapture", "block", "Capture screen video", [
      "capture",
      "screen",
      "video",
      "record",
    ]),
    capability("block:videoEncode", "block", "Encode video", [
      "encode",
      "video",
    ]),
    capability("command:video", "command", "Video Capture", [
      "capture",
      "screen",
      "video",
    ]),
    capability("command:test", "command", "Internal test", ["test"]),
    capability("documentation:feature-markdown", "documentation", "Markdown", [
      "markdown",
      "view",
      "diagram",
      "screen",
      "record",
    ]),
  ],
  workflows: [
    {
      id: "workflow:video-recorder",
      label: "video-recorder",
      nodeIds: ["block:videoCapture", "block:videoEncode"],
      source: "video-recorder.xblox",
    },
    {
      id: "workflow:video-recorder-16-9-pip",
      label: "video-recorder-16-9-pip",
      nodeIds: ["block:videoCapture", "block:videoEncode"],
      source: "video-recorder-16-9-pip.xblox",
    },
    {
      id: "workflow:video-recorder-pipe",
      label: "video-recorder-pipe",
      nodeIds: ["block:videoCapture", "block:videoEncode"],
      source: "video-recorder-pipe.xblox",
    },
    {
      id: "workflow:video-recorder-fixed - Copy",
      label: "video-recorder-fixed - Copy",
      nodeIds: ["block:videoCapture", "block:videoEncode"],
      source: "video-recorder-fixed - Copy.xblox",
    },
  ],
};

function phrase(
  text: string,
  niche: number,
  sources: PhraseSource[] = ["autocomplete"]
): PhraseRecord {
  return {
    phrase: text,
    sources,
    seeds: [],
    scores: {
      niche,
      wordCount: text.split(/\s+/).length,
      isQuestion: /^(how|what|why|can|is)\b/i.test(text),
      relevance: null,
      sourceCount: sources.length,
    },
    addedAt: "2026-01-01T00:00:00.000Z",
    serp: null,
  };
}

test("markdown groups output by feature with questions and social", async () => {
  const plan = await runProductPlan(
    { maxJobs: 1, serpCallsPerJob: 2, decide: false, qualify: false },
    {
      loadSnapshot: async () => snapshot,
      loadSettings: async () => ({ blacklist: [], product: null }),
      discover: async (job) => ({
        phrases: [
          phrase("how to view markdown?", 70),
          phrase("what is markdown viewer?", 65),
          phrase("can i view md files?", 60),
          phrase("why use markdown?", 55),
          phrase("is markdown hard?", 50),
          phrase("markdown viewer", 40, ["autocomplete"]),
        ],
        landscape: [],
        meta: { calls: [], errors: [] },
      }),
    }
  );
  const md = renderProductPlanMarkdown(plan);
  assert.match(md, /## Feature: Markdown/);
  assert.match(md, /### Questions \(5/);
  assert.match(md, /### Phrases by source/);
});

test("harvests jobs and collapses sibling workflows before search", () => {
  const jobs = harvestProductJobs(snapshot);
  assert.deepEqual(
    jobs.map((job) => job.id),
    [
      "job:documentation:feature-markdown",
      "job:workflow:video-recorder",
    ]
  );
  const recording = jobs.find((job) => job.id === "job:workflow:video-recorder");
  assert.equal(recording?.label, "screen recording");
  assert.deepEqual(recording?.proofIds, [
    "workflow:video-recorder",
    "workflow:video-recorder-16-9-pip",
    "workflow:video-recorder-pipe",
  ]);
  assert.ok(!jobs.some((job) => job.id === "job:command:video"));
  assert.ok(!jobs.some((job) => job.id === "job:command:test"));
});

test("runs two jobs as one testable plan and qualifies only the pillar", async () => {
  let decisionCalls = 0;
  const qualified: string[] = [];
  const plan = await runProductPlan(
    {
      maxJobs: 2,
      serpCallsPerJob: 2,
      decide: true,
      qualify: true,
    },
    {
      loadSnapshot: async () => snapshot,
      loadSettings: async () => ({ blacklist: [], product: null }),
      discover: async (job, seeds, _locale, options) => {
        assert.deepEqual(seeds, productJobSeeds(job));
        assert.deepEqual(options.engines, ["autocomplete"]);
        const phrases =
          job.id === "job:workflow:video-recorder"
            ? [
                phrase("screen recording", 10, ["seed"]),
                phrase("how to record screen", 72),
                phrase("best free screen recorder", 61),
                phrase("record screen markdown", 55),
                phrase("banana accountant", 80),
              ]
            : [
                phrase("markdown", 10, ["seed"]),
                phrase("how to view markdown files", 68),
                phrase("what is a markdown viewer", 56, ["people_also_ask"]),
                phrase("record screen markdown", 55),
              ];
        return {
          phrases,
          landscape:
            job.id === "job:documentation:feature-markdown"
              ? [
                  {
                    query: "markdown",
                    searchId: "sample",
                    features: ["organic"],
                    organics: [
                      {
                        position: 1,
                        title: "Markdown discussion",
                        link: "https://www.reddit.com/r/markdown/sample",
                      },
                      {
                        position: 2,
                        title: "Markdown application",
                        link: "https://apps.microsoft.com/detail/sample",
                      },
                    ],
                  },
                ]
              : [],
          meta: { calls: [], errors: [] },
        };
      },
      decide: async (chapters) => {
        decisionCalls += 1;
        assert.equal(chapters.length, 2);
        return new Map([
          [
            "job:workflow:video-recorder",
            { action: "pillar" as const, demand: 0.9 },
          ],
          [
            "job:documentation:feature-markdown",
            { action: "section" as const, demand: 0.7 },
          ],
        ]);
      },
      qualify: async (chapter) => {
        qualified.push(chapter.jobId);
        return {
          query: chapter.canonicalQuery,
          aiOverview: "A concise current answer.",
          organics: [
            {
              position: 1,
              title: "Generic screen recording guide",
              link: "https://example.com/screen-recording",
            },
          ],
        };
      },
      now: () => new Date("2026-01-02T00:00:00.000Z"),
    }
  );

  assert.equal(decisionCalls, 1);
  assert.deepEqual(qualified, ["job:workflow:video-recorder"]);
  assert.equal(plan.metrics.jobs, 2);
  assert.equal(plan.metrics.pillars, 1);
  assert.equal(plan.metrics.sections, 1);
  assert.equal(plan.metrics.skipped, 0);
  assert.deepEqual(plan.productHoles, ["banana accountant"]);

  const recording = plan.chapters.find(
    (chapter) => chapter.jobId === "job:workflow:video-recorder"
  );
  const markdown = plan.chapters.find(
    (chapter) => chapter.jobId === "job:documentation:feature-markdown"
  );
  assert.equal(recording?.canonicalQuery, "how to record screen");
  assert.equal(recording?.qualified, true);
  assert.equal(recording?.evidence?.aiOverview, "A concise current answer.");
  assert.equal(
    recording?.gap,
    "Ranking pages do not document the verified product path."
  );
  assert.equal(markdown?.action, "section");
  assert.equal(markdown?.qualified, false);
  assert.ok(markdown?.phrases.some((row) => row.phrase === "record screen markdown"));
  assert.ok(!recording?.phrases.some((row) => row.phrase === "record screen markdown"));
  assert.equal(markdown?.social[0]?.network, "reddit");
  assert.equal(markdown?.apps[0]?.network, "microsoft");
});

test("runProductPlan reuses discovery cache when outDir is set", async () => {
  const outDir = await fs.mkdtemp(path.join(os.tmpdir(), "product-plan-cache-"));
  let discoverCalls = 0;
  const loadSnapshot = async () => snapshot;

  await runProductPlan(
    {
      jobIds: [
        "job:workflow:video-recorder",
        "job:documentation:feature-markdown",
      ],
      serpCallsPerJob: 2,
      decide: false,
      qualify: false,
      outDir,
    },
    {
      loadSnapshot,
      discover: async (job) => {
        discoverCalls += 1;
        return {
          phrases: [
            job.id === "job:workflow:video-recorder"
              ? phrase("how to record screen", 72)
              : phrase("markdown viewer", 40),
          ],
          landscape: [],
          meta: { calls: [], errors: [] },
        };
      },
      now: () => new Date("2026-01-02T00:00:00.000Z"),
    }
  );
  assert.equal(discoverCalls, 2);

  await runProductPlan(
    {
      jobIds: [
        "job:workflow:video-recorder",
        "job:documentation:feature-markdown",
      ],
      serpCallsPerJob: 2,
      decide: true,
      qualify: false,
      outDir,
    },
    {
      loadSnapshot,
      discover: async () => {
        discoverCalls += 1;
        throw new Error("discovery should be cached");
      },
      decide: async () =>
        new Map([
          [
            "job:workflow:video-recorder",
            { action: "pillar" as const, demand: 0.9 },
          ],
          [
            "job:documentation:feature-markdown",
            { action: "section" as const, demand: 0.7 },
          ],
        ]),
      now: () => new Date("2026-01-02T00:00:00.000Z"),
    }
  );
  assert.equal(discoverCalls, 2);
});

test("runProductPlan caches qualify and enrich as separate stages", async () => {
  const outDir = await fs.mkdtemp(path.join(os.tmpdir(), "product-plan-enrich-"));
  let qualifyCalls = 0;
  let enrichCalls = 0;
  const loadSnapshot = async () => snapshot;
  const loadSettings = async () => ({ blacklist: [], product: null });
  const discover = async (job: { id: string }) => ({
    phrases: [
      job.id === "job:workflow:video-recorder"
        ? phrase("how to record screen", 72)
        : phrase("markdown viewer", 40),
    ],
    landscape: [],
    meta: { calls: [], errors: [] },
  });
  const decide = async () =>
    new Map([
      [
        "job:workflow:video-recorder",
        { action: "pillar" as const, demand: 0.9 },
      ],
      [
        "job:documentation:feature-markdown",
        { action: "section" as const, demand: 0.7 },
      ],
    ]);
  const qualify = async (chapter: { canonicalQuery: string }) => {
    qualifyCalls += 1;
    return {
      query: chapter.canonicalQuery,
      organics: [
        {
          position: 1,
          title: "Generic screen recording guide",
          link: "https://example.com/screen-recording",
        },
      ],
    };
  };
  const enrich = async () => {
    enrichCalls += 1;
    return {
      "https://example.com/screen-recording": {
        url: "https://example.com/screen-recording",
        title: "Screen recording guide",
        description: "How to record a screen.",
        enricher: "meta",
        fetchedAt: "2026-01-02T00:00:00.000Z",
        ms: 1,
      },
    };
  };
  const now = () => new Date("2026-01-02T00:00:00.000Z");
  const sample = {
    jobIds: [
      "job:workflow:video-recorder",
      "job:documentation:feature-markdown",
    ],
    serpCallsPerJob: 2 as const,
    decide: true,
    outDir,
  };

  await runProductPlan(
    { ...sample, qualify: true, enrich: false },
    { loadSnapshot, loadSettings, discover, decide, qualify, enrich, now }
  );
  assert.equal(qualifyCalls, 1);
  assert.equal(enrichCalls, 0);

  const enriched = await runProductPlan(
    { ...sample, qualify: false, enrich: true },
    { loadSnapshot, loadSettings, discover, decide, qualify, enrich, now }
  );
  assert.equal(qualifyCalls, 1);
  assert.equal(enrichCalls, 1);
  const recording = enriched.chapters.find(
    (chapter) => chapter.jobId === "job:workflow:video-recorder"
  );
  assert.equal(recording?.sites[0]?.title, "Screen recording guide");

  await runProductPlan(
    { ...sample, qualify: false, enrich: true },
    { loadSnapshot, loadSettings, discover, decide, qualify, enrich, now }
  );
  assert.equal(qualifyCalls, 1);
  assert.equal(enrichCalls, 1);
});

test("runProductPlan keeps going when a pillar qualify times out", async () => {
  const outDir = await fs.mkdtemp(path.join(os.tmpdir(), "product-plan-timeout-"));
  const plan = await runProductPlan(
    {
      outDir,
      jobIds: [
        "job:workflow:video-recorder",
        "job:documentation:feature-markdown",
      ],
      serpCallsPerJob: 2,
      decide: true,
      qualify: true,
      useCache: false,
    },
    {
      loadSnapshot: async () => snapshot,
      loadSettings: async () => ({ blacklist: [], product: null }),
      discover: async (job) => ({
        phrases: [
          job.id === "job:workflow:video-recorder"
            ? phrase("how to record screen", 72)
            : phrase("markdown viewer", 40),
        ],
        landscape: [],
        meta: { calls: [], errors: [] },
      }),
      decide: async () =>
        new Map([
          [
            "job:workflow:video-recorder",
            { action: "pillar" as const, demand: 0.9 },
          ],
          [
            "job:documentation:feature-markdown",
            { action: "section" as const, demand: 0.7 },
          ],
        ]),
      qualify: async () => {
        throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
      },
      now: () => new Date("2026-01-02T00:00:00.000Z"),
    }
  );
  const recording = plan.chapters.find(
    (chapter) => chapter.jobId === "job:workflow:video-recorder"
  );
  assert.equal(recording?.qualified, false);
  assert.match(recording?.gap ?? "", /timed out/i);
  assert.equal(plan.metrics.pillars, 1);
});

test("removeProductPlanJobs and clearProductPlan drop saved parts", async () => {
  const outDir = await fs.mkdtemp(path.join(os.tmpdir(), "product-plan-delete-"));
  await runProductPlan(
    {
      outDir,
      jobIds: [
        "job:workflow:video-recorder",
        "job:documentation:feature-markdown",
      ],
      serpCallsPerJob: 2,
      decide: false,
      qualify: false,
    },
    {
      loadSnapshot: async () => snapshot,
      loadSettings: async () => ({ blacklist: [], product: null }),
      discover: async (job) => ({
        phrases: [
          job.id === "job:workflow:video-recorder"
            ? phrase("how to record screen", 72)
            : phrase("markdown viewer", 40),
        ],
        landscape: [],
        meta: { calls: [], errors: [] },
      }),
      now: () => new Date("2026-01-02T00:00:00.000Z"),
    }
  );
  const kept = await removeProductPlanJobs(
    ["job:documentation:feature-markdown"],
    outDir
  );
  assert.ok(kept);
  assert.deepEqual(
    [...kept.plan.chapters, ...kept.plan.appendix].map((row) => row.jobId),
    ["job:workflow:video-recorder"]
  );
  const discoverFiles = await fs.readdir(path.join(outDir, ".cache", "discover"));
  assert.equal(
    discoverFiles.some((name) => name.includes("markdown")),
    false
  );
  await clearProductPlan(outDir);
  assert.equal(await readProductPlan(outDir), null);
});
