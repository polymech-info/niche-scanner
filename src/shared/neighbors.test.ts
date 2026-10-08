import test from "node:test";
import assert from "node:assert/strict";
import {
  NEIGHBOR_PROMPT,
  flattenNeighbors,
  hubText,
  pickNeighborHubs,
  uniqueNeighbors,
} from "./neighbors.js";
import type { SearchDocument } from "./phrases.js";

const doc: SearchDocument = {
  id: "voice-recorder-test",
  name: "voice recorder",
  createdAt: "",
  updatedAt: "",
  locale: { gl: "us", hl: "en", googleDomain: "google.com" },
  seeds: ["voice recorder"],
  options: {
    engines: ["autocomplete"],
    paaDepth: 0,
    alphabet: false,
    questionPrefixes: false,
  },
  phrases: [
    {
      phrase: "is there a voice recorder on my phone?",
      sources: ["people_also_ask"],
      seeds: ["voice recorder"],
      scores: {
        niche: 58,
        wordCount: 8,
        isQuestion: true,
        relevance: null,
        sourceCount: 1,
      },
      class: { intent: "informational", role: "write", reason: "q" },
      addedAt: "",
      serp: null,
    },
    {
      phrase: "call recorder",
      sources: ["related_searches"],
      seeds: ["voice recorder"],
      scores: {
        niche: 28,
        wordCount: 2,
        isQuestion: false,
        relevance: null,
        sourceCount: 1,
      },
      class: { intent: "commercial", role: "cluster", reason: "related" },
      addedAt: "",
      serp: null,
    },
    {
      phrase: "voice recorder near me",
      sources: ["related_searches"],
      seeds: ["voice recorder"],
      scores: {
        niche: 20,
        wordCount: 4,
        isQuestion: false,
        relevance: null,
        sourceCount: 1,
      },
      class: { intent: "local", role: "skip", reason: "local" },
      addedAt: "",
      serp: null,
    },
  ],
  meta: { calls: [], errors: [] },
};

test("hubs prefer seed, then related topics that change the job", () => {
  const hubs = pickNeighborHubs(doc, 8);
  assert.equal(hubs[0]?.phrase, "voice recorder");
  assert.equal(hubs[0]?.kind, "seed");
  assert.ok(hubs.some((hub) => hub.phrase === "call recorder"));
  assert.equal(
    hubs.some((hub) => hub.phrase.includes("near me")),
    false
  );
});

test("flatten drops known phrases and junk", () => {
  const hints = flattenNeighbors(
    [
      {
        phrase: "voice recorder",
        kind: "seed",
        neighbors: [
          { seed: "call recorder", why: "phone calls vs memos" },
          { seed: "voice recorder", why: "same" },
          { seed: "apk", why: "junk" },
          { seed: "https://evil.example", why: "url" },
        ],
      },
    ],
    new Set(["voice recorder"])
  );
  assert.equal(hints.length, 1);
  assert.equal(hints[0].seed, "call recorder");
  assert.equal(hints[0].via, "voice recorder");
});

test("flatten reads n1/w1 merge-json keys", () => {
  const hints = flattenNeighbors(
    [
      {
        phrase: "voice recorder",
        kind: "seed",
        n1: "call recorder",
        w1: "phone calls",
        n2: "voice memo",
        w2: "ios built-in",
        n3: "",
        w3: "",
      },
    ],
    new Set(["voice recorder"])
  );
  assert.deepEqual(
    hints.map((row) => row.seed),
    ["call recorder", "voice memo"]
  );
});

test("keeps job-shift neighbors and drops form-factor synonyms", () => {
  const hints = uniqueNeighbors(
    [
      { seed: "digital voice recorder", why: "audio recording devices", via: "voice recorder", kind: "seed" },
      { seed: "portable voice recorder", why: "sound recording equipment", via: "voice recorder", kind: "seed" },
      { seed: "voice recorder microphone", why: "audio transcription tools", via: "voice recorder", kind: "seed" },
      { seed: "audio recording software", why: "record audio on phone", via: "app", kind: "related" },
      { seed: "background voice recording", why: "improve audio recording quality", via: "app", kind: "related" },
      { seed: "portable audio recorder", why: "interview recording tools", via: "device", kind: "related" },
      { seed: "handheld recording device", why: "meeting transcription equipment", via: "device", kind: "related" },
    ],
    ["voice recorder"]
  );
  assert.deepEqual(
    hints.map((row) => row.seed),
    [
      "audio transcription tools",
      "improve audio recording quality",
      "interview recording tools",
    ]
  );
});

test("prompt does not name example jobs", () => {
  assert.equal(/\b(transcription|interview|voice memo|recording quality)\b/i.test(NEIGHBOR_PROMPT), false);
});

test("hub text distinguishes seed from article", () => {
  assert.match(hubText({ phrase: "voice recorder", kind: "seed" }), /kind=seed/);
  assert.match(
    hubText({ phrase: "is there a voice recorder on my phone?", kind: "survivor" }),
    /kind=article/
  );
});
