import fs from "fs";
import path from "path";
import type { PackageManager } from "../types.js";

export function detectPackageManager(rootDir: string): PackageManager {
  if (fs.existsSync(path.join(rootDir, "pnpm-lock.yaml"))) return "pnpm";
  if (fs.existsSync(path.join(rootDir, "yarn.lock"))) return "yarn";
  if (fs.existsSync(path.join(rootDir, "package-lock.json"))) return "npm";

  // Fallback: check packageManager field
  const pkgPath = path.join(rootDir, "package.json");
  if (fs.existsSync(pkgPath)) {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
    if (typeof pkg.packageManager === "string") {
      if (pkg.packageManager.startsWith("pnpm")) return "pnpm";
      if (pkg.packageManager.startsWith("yarn")) return "yarn";
    }
  }

  return "npm";
}

export function getRunCommand(pm: PackageManager): string {
  if (pm === "yarn") return "yarn";
  return `${pm} run`;
}
