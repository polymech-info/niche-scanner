import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { collectGroupScripts, groupScripts } from "./group-scripts.js";

describe("groupScripts", () => {
  it("keeps unrelated scripts as flat leaves", () => {
    const tree = groupScripts([
      ["dev", "vite"],
      ["build", "tsc"],
    ]);
    assert.equal(tree.length, 2);
    assert.deepEqual(
      tree.map((n) => n.path).sort(),
      ["build", "dev"]
    );
    assert.ok(tree.every((n) => n.children.length === 0 && n.script));
  });

  it("nests colon groups when 2+ scripts share a prefix", () => {
    const tree = groupScripts([
      ["test:unit", "vitest"],
      ["test:e2e", "playwright"],
      ["lint", "eslint"],
    ]);
    const testGroup = tree.find((n) => n.path === "test");
    assert.ok(testGroup);
    assert.equal(testGroup!.children.length, 2);
    assert.ok(tree.some((n) => n.path === "lint"));
  });

  it("flattens singleton colon paths", () => {
    const tree = groupScripts([["only:one:deep", "echo"]]);
    assert.equal(tree.length, 1);
    assert.equal(tree[0].path, "only:one:deep");
    assert.equal(tree[0].children.length, 0);
  });
});

describe("collectGroupScripts", () => {
  const scripts: [string, string][] = [
    ["test:unit", "u"],
    ["test:e2e", "e"],
    ["test:e2e:smoke", "s"],
    ["lint", "l"],
  ];

  it("collects scripts under a group path", () => {
    const got = collectGroupScripts(scripts, "test").map(([n]) => n);
    assert.deepEqual(got.sort(), [
      "test:e2e",
      "test:e2e:smoke",
      "test:unit",
    ]);
  });

  it("falls back for flat prefixes", () => {
    const got = collectGroupScripts(
      [
        ["build:app", "a"],
        ["build:lib", "b"],
      ],
      "build"
    ).map(([n]) => n);
    assert.deepEqual(got, ["build:app", "build:lib"]);
  });
});
