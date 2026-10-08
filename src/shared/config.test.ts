import test from "node:test";
import assert from "node:assert/strict";
import {
  blacklistHits,
  isBlacklisted,
  normalizeBlacklistWord,
  parseSettings,
  topWords,
} from "./config.js";

test("normalizes and dedupes blacklist words", () => {
  assert.equal(normalizeBlacklistWord("  Near  ME "), "near me");
  const parsed = parseSettings({ blacklist: ["App", "app", "  ", "near me"] });
  assert.deepEqual(parsed.blacklist, ["app", "near me"]);
  assert.equal(parsed.product, null);
});

test("parses product platforms and keeps them when blacklist-only objects omit them", () => {
  const parsed = parseSettings({
    blacklist: ["iphone"],
    product: {
      name: "Tanit",
      platforms: ["Windows", "windows"],
      notPlatforms: "mac, ios, android",
      doesNot: ["mac app"],
    },
  });
  assert.equal(parsed.product?.name, "Tanit");
  assert.deepEqual(parsed.product?.platforms, ["windows"]);
  assert.deepEqual(parsed.product?.notPlatforms, ["mac", "ios", "android"]);
  assert.deepEqual(parsed.product?.doesNot, ["mac app"]);
});

test("matches whole words, not substrings", () => {
  assert.equal(isBlacklisted("voice recorder app", ["app"]), true);
  assert.equal(isBlacklisted("apple voice recorder", ["app"]), false);
  assert.equal(isBlacklisted("voice recorder near me", ["near me"]), true);
});

test("top words count this search and skip stopwords", () => {
  const words = topWords([
    "voice recorder app",
    "best voice recorder",
    "voice memo recorder",
  ]);
  const voice = words.find((row) => row.word === "voice");
  const recorder = words.find((row) => row.word === "recorder");
  assert.equal(voice?.count, 3);
  assert.equal(voice?.phrases, 3);
  assert.equal(recorder?.count, 3);
  assert.ok(words.some((row) => row.word === "best"));
  assert.equal(words.some((row) => row.word === "the"), false);
  assert.equal(blacklistHits(["voice recorder app", "apple"], "app"), 1);
});
