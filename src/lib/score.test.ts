import test from "node:test";
import assert from "node:assert/strict";
import { isQuestion, scorePhrase, wordCount } from "./score.js";

test("wordCount and question detection", () => {
  assert.equal(wordCount("  How to water  a snake plant "), 6);
  assert.equal(isQuestion("how to water a snake plant"), true);
  assert.equal(isQuestion("snake plant soil"), false);
});

test("niche score prefers long-tail questions with overlap", () => {
  const generic = scorePhrase({
    phrase: "plants",
    sources: ["autocomplete"],
    relevance: 100,
  });
  const niche = scorePhrase({
    phrase: "how often should I water a snake plant",
    sources: ["autocomplete", "people_also_ask", "related_searches"],
    relevance: 820,
  });
  assert.ok(niche.niche > generic.niche);
  assert.equal(niche.isQuestion, true);
  assert.equal(niche.wordCount, 8);
});
