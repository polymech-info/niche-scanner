import test from "node:test";
import assert from "node:assert/strict";
import { buildSearchSnapshot } from "./snapshot.js";
import type { SearchDocument } from "./phrases.js";

const base: SearchDocument = {
  id: "t",
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
      phrase: "does android have a built-in voice recorder?",
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
      serp: { engine: "google", searchId: "1", organics: [{ position: 1, title: "A", link: "https://a.com/how" }] },
    },
    {
      phrase: "voice recorder near me",
      sources: ["autocomplete"],
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
  landscape: [
    {
      query: "voice recorder",
      searchId: "x",
      features: ["organic", "ai_overview"],
      organics: [
        {
          position: 1,
          title: "Online Voice Recorder",
          link: "https://online-voice-recorder.com/",
        },
        {
          position: 2,
          title: "Voice Recorder - Apps on Google Play",
          link: "https://play.google.com/store/apps/details?id=x",
        },
      ],
    },
  ],
  meta: { calls: [], errors: [] },
};

test("snapshot flags a product-heavy crowded seed", () => {
  const snap = buildSearchSnapshot(base);
  assert.match(snap.headline, /product-heavy/i);
  assert.ok(snap.flags.includes("AI overview"));
  assert.equal(snap.write, 1);
  assert.equal(snap.skip, 1);
  assert.equal(snap.qualified, 1);
  assert.ok(snap.topHosts.includes("online-voice-recorder.com"));
});
