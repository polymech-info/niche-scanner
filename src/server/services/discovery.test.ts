import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { discoverPackages } from "./discovery.js";

describe("discoverPackages", () => {
  let root: string;

  before(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "runny-discover-"));
    fs.writeFileSync(
      path.join(root, "package.json"),
      JSON.stringify({
        name: "root-app",
        workspaces: ["packages/*"],
        scripts: {
          "--- section ---": "echo",
          dev: "node -e \"console.log('dev')\"",
          "build:app": "tsc",
        },
      })
    );
    fs.mkdirSync(path.join(root, "packages", "alpha"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "packages", "alpha", "package.json"),
      JSON.stringify({
        name: "@demo/alpha",
        scripts: { test: "node -e \"process.exit(0)\"" },
      })
    );
    fs.mkdirSync(path.join(root, "packages", "beta"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "packages", "beta", "package.json"),
      JSON.stringify({ name: "@demo/beta", scripts: {} })
    );
  });

  after(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("includes root scripts and filters section markers", async () => {
    const pkgs = await discoverPackages(root, "npm");
    const rootPkg = pkgs.find((p) => p.isRoot);
    assert.ok(rootPkg);
    assert.equal(rootPkg!.name, "root-app");
    assert.ok(rootPkg!.scripts.dev);
    assert.ok(rootPkg!.scripts["build:app"]);
    assert.equal(rootPkg!.scripts["--- section ---"], undefined);
  });

  it("discovers workspace packages with scripts", async () => {
    const pkgs = await discoverPackages(root, "npm");
    const names = pkgs.map((p) => p.name).sort();
    assert.ok(names.includes("@demo/alpha"));
    // beta has empty scripts — still discovered (filter only drops --- keys)
    assert.ok(names.includes("@demo/beta"));
  });
});
