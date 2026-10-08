import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { compileCapabilitySnapshot } from "../shared/capabilities.js";
import type { ProductProfile } from "../shared/config.js";
import type { PhraseRecord } from "../shared/phrases.js";
import { OpportunityStore } from "../server/services/opportunity-store.js";
import { SearchStore } from "./store.js";
import {
  discoverOpportunity,
  normalizeOpportunityBudget,
  opportunityVariations,
  promoteOpportunity,
} from "./opportunity-discovery.js";
import { resolveCapability } from "../shared/capabilities.js";

const product: ProductProfile = {
  name: "Tanit",
  platforms: ["windows"],
  notPlatforms: ["mac", "ios", "android"],
  doesNot: ["mac app"],
};

const snapshot = compileCapabilitySnapshot({
  generatedAt: "2026-01-01T00:00:00.000Z",
  commands: {
    commands: [
      {
        id: "resize",
        label: "Resize image",
        description: "Resize and transform image files",
        available: true,
      },
    ],
  },
  xblox: { blocks: [] },
  documents: [],
  workflows: [],
});

function record(phrase: string, niche = 60): PhraseRecord {
  return {
    phrase,
    sources: ["autocomplete"],
    seeds: ["resize image"],
    scores: {
      niche,
      wordCount: phrase.split(" ").length,
      isQuestion: phrase.endsWith("?"),
      relevance: 800,
      sourceCount: 1,
    },
    addedAt: "2026-01-01T00:00:00.000Z",
    class: {
      intent: "informational",
      role: "write",
      reason: "test",
    },
    serp: {
      engine: "google_autocomplete",
      searchId: "serp-1",
      relevance: 800,
    },
  };
}

test("bounds budgets and capability-derived variations", () => {
  assert.equal(normalizeOpportunityBudget(1), 2);
  assert.equal(normalizeOpportunityBudget(7), 6);
  assert.equal(normalizeOpportunityBudget(99), 12);
  const match = resolveCapability("resize image", snapshot, product);
  const variations = opportunityVariations(
    "resize image",
    match,
    snapshot,
    2
  );
  assert.equal(variations.length, 2);
  assert.equal(variations[0], "resize image");
});

test("short-circuits unsupported queries before paid discovery", async () => {
  let called = false;
  const run = await discoverOpportunity(
    { query: "resize image for mac", serpBudget: 8 },
    {
      loadSettings: async () => ({ blacklist: [], product }),
      loadSnapshot: async () => snapshot,
      discover: async () => {
        called = true;
        throw new Error("should not run");
      },
      now: () => new Date("2026-01-01T00:00:00.000Z"),
      makeId: () => "opportunity-test",
    }
  );
  assert.equal(called, false);
  assert.equal(run.productMatch.fit, "unsupported");
  assert.equal(run.budget.planned, 0);
  assert.equal(run.candidates.length, 0);
});

test("keeps supported candidates inside the requested call budget", async () => {
  const run = await discoverOpportunity(
    { query: "resize image", serpBudget: 4 },
    {
      loadSettings: async () => ({ blacklist: [], product }),
      loadSnapshot: async () => snapshot,
      discover: async (seeds) => {
        assert.ok(seeds.length <= 2);
        return {
          phrases: [
            record("resize image", 70),
            record("resize image for mac", 90),
            record("quantum banana organizer", 99),
          ],
          landscape: [],
          meta: {
            calls: [
              {
                engine: "google",
                query: "resize image",
                status: "Success",
                searchId: "serp-1",
                createdAt: null,
                totalTimeTaken: 1,
                resultCount: 10,
              },
            ],
            errors: [
              {
                engine: "google_autocomplete",
                query: "resize image",
                message: "fixture failure",
              },
            ],
          },
        };
      },
      now: () => new Date("2026-01-01T00:00:00.000Z"),
      makeId: () => "opportunity-test",
    }
  );
  assert.deepEqual(run.candidates.map((item) => item.phrase), ["resize image"]);
  assert.equal(run.budget.requested, 4);
  assert.equal(run.budget.attempted, 2);
});

test("expires temporary runs without writing search files", () => {
  let now = Date.parse("2026-01-01T00:00:00.000Z");
  const store = new OpportunityStore(() => now, 60_000);
  const run = {
    id: "opportunity-expiry",
    status: "ready" as const,
    query: "resize image",
    createdAt: "2026-01-01T00:00:00.000Z",
    expiresAt: "2026-01-01T00:01:00.000Z",
    locale: { gl: "us", hl: "en", googleDomain: "google.com" },
    productMatch: resolveCapability("resize image", snapshot, product),
    variations: ["resize image"],
    candidates: [],
    landscape: [],
    calls: [],
    errors: [],
    budget: { requested: 2, planned: 2, attempted: 0 },
  };
  store.put(run);
  assert.equal(store.get(run.id).id, run.id);
  now += 61_000;
  assert.throws(() => store.get(run.id), /expired or not found/);
  store.stop();
});

test("promotes evidence without discovery and deduplicates existing phrases", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "opportunity-store-"));
  const store = new SearchStore(dir);
  try {
    const run = await discoverOpportunity(
      { query: "resize image", serpBudget: 2 },
      {
        loadSettings: async () => ({ blacklist: [], product }),
        loadSnapshot: async () => snapshot,
        discover: async () => ({
          phrases: [record("resize image", 70)],
          landscape: [],
          meta: { calls: [], errors: [] },
        }),
        now: () => new Date("2026-01-01T00:00:00.000Z"),
        makeId: () => "opportunity-promote",
      }
    );
    const created = await promoteOpportunity(
      run,
      { phrases: ["resize image"], name: "Image work" },
      store,
      new Date("2026-01-01T00:02:00.000Z")
    );
    assert.equal(created.phrases.length, 1);
    assert.equal(created.opportunity?.runId, run.id);
    assert.equal(
      created.opportunity?.matches["resize image"].fit,
      "direct"
    );

    const merged = await promoteOpportunity(
      run,
      { phrases: ["resize image"], targetSearchId: created.id },
      store,
      new Date("2026-01-01T00:03:00.000Z")
    );
    assert.equal(merged.phrases.length, 1);
    assert.deepEqual(merged.seeds, ["resize image"]);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
