import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fuzzyMatch, fuzzyScore, splitSearchWords } from "./fuzzy-search.js";

describe("splitSearchWords", () => {
  it("splits camelCase and separators", () => {
    assert.deepEqual(splitSearchWords("test:mediaApi"), [
      "test",
      "media",
      "api",
    ]);
  });
});

describe("fuzzyMatch", () => {
  it("matches exact and substring", () => {
    assert.equal(fuzzyMatch("build", "build:cpp"), true);
    assert.equal(fuzzyMatch("cpp", "build:cpp"), true);
  });

  it("matches camelCase / acronym style queries", () => {
    assert.equal(fuzzyMatch("tma", "test:mediaApi"), true);
    assert.equal(fuzzyMatch("media api", "test:mediaApi"), true);
  });

  it("rejects unrelated needles", () => {
    assert.equal(fuzzyMatch("zzz", "build:cpp"), false);
  });

  it("empty query matches everything", () => {
    assert.ok(fuzzyScore("", "anything") > 0);
  });
});
