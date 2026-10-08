import fs from "fs";
import path from "path";
import fg from "fast-glob";
import YAML from "yaml";
import type { PackageInfo, PackageManager } from "../types.js";

const IGNORE_DIRS = [
  "**/node_modules/**",
  "**/.next/**",
  "**/.turbo/**",
  "**/dist/**",
  "**/build/**",
  "**/.git/**",
  "**/coverage/**",
];

/** Section markers in package.json, e.g. `"--- features ---": "echo ''"`. */
function filterScripts(
  scripts: Record<string, string> | undefined
): Record<string, string> {
  if (!scripts) return {};
  const out: Record<string, string> = {};
  for (const [name, command] of Object.entries(scripts)) {
    if (name.startsWith("---")) continue;
    out[name] = command;
  }
  return out;
}

async function getWorkspaceGlobs(
  rootDir: string,
  pm: PackageManager
): Promise<string[]> {
  // pnpm: read pnpm-workspace.yaml
  if (pm === "pnpm") {
    const wsPath = path.join(rootDir, "pnpm-workspace.yaml");
    if (fs.existsSync(wsPath)) {
      const content = fs.readFileSync(wsPath, "utf-8");
      const parsed = YAML.parse(content);
      if (parsed?.packages && Array.isArray(parsed.packages)) {
        return parsed.packages;
      }
    }
  }

  // npm/yarn: read workspaces from package.json
  const pkgPath = path.join(rootDir, "package.json");
  if (fs.existsSync(pkgPath)) {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
    if (Array.isArray(pkg.workspaces)) {
      return pkg.workspaces;
    }
    if (pkg.workspaces?.packages && Array.isArray(pkg.workspaces.packages)) {
      return pkg.workspaces.packages;
    }
  }

  return [];
}

export async function discoverPackages(
  rootDir: string,
  pm: PackageManager
): Promise<PackageInfo[]> {
  const packages: PackageInfo[] = [];

  // Always include root package.json
  const rootPkgPath = path.join(rootDir, "package.json");
  if (fs.existsSync(rootPkgPath)) {
    const rootPkg = JSON.parse(fs.readFileSync(rootPkgPath, "utf-8"));
    const scripts = filterScripts(rootPkg.scripts);
    if (Object.keys(scripts).length > 0) {
      packages.push({
        name: rootPkg.name || path.basename(rootDir),
        path: rootDir,
        relativePath: ".",
        scripts,
        isRoot: true,
      });
    }
  }

  // Discover workspace packages
  const globs = await getWorkspaceGlobs(rootDir, pm);
  if (globs.length > 0) {
    const packageJsonGlobs = globs.map((g) => {
      // Ensure glob ends with /package.json
      const clean = g.replace(/\/?\*?$/, "");
      return `${clean}/*/package.json`;
    });

    const matches = await fg(packageJsonGlobs, {
      cwd: rootDir,
      absolute: true,
      ignore: IGNORE_DIRS,
    });

    for (const match of matches) {
      try {
        const pkg = JSON.parse(fs.readFileSync(match, "utf-8"));
        const pkgDir = path.dirname(match);
        packages.push({
          name: pkg.name || path.basename(pkgDir),
          path: pkgDir,
          relativePath: path.relative(rootDir, pkgDir),
          scripts: filterScripts(pkg.scripts),
          isRoot: false,
        });
      } catch {
        // Skip invalid package.json files
      }
    }
  }

  // Sort: root first, then alphabetically
  packages.sort((a, b) => {
    if (a.isRoot) return -1;
    if (b.isRoot) return 1;
    return a.name.localeCompare(b.name);
  });

  return packages;
}
