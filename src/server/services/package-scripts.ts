import fs from "fs";
import path from "path";

export interface ScriptMutationResult {
  packagePath: string;
  scripts: Record<string, string>;
}

function readPackageJson(packagePath: string): {
  filePath: string;
  pkg: Record<string, unknown>;
} {
  const filePath = path.join(packagePath, "package.json");
  if (!fs.existsSync(filePath)) {
    throw new Error(`package.json not found at ${filePath}`);
  }
  const pkg = JSON.parse(fs.readFileSync(filePath, "utf-8")) as Record<
    string,
    unknown
  >;
  if (!pkg.scripts || typeof pkg.scripts !== "object") {
    pkg.scripts = {};
  }
  return { filePath, pkg };
}

function writePackageJson(
  filePath: string,
  pkg: Record<string, unknown>
): void {
  fs.writeFileSync(filePath, `${JSON.stringify(pkg, null, 2)}\n`, "utf-8");
}

function asScripts(pkg: Record<string, unknown>): Record<string, string> {
  const scripts = pkg.scripts as Record<string, string>;
  return { ...scripts };
}

/** Delete a script key from package.json (preserves key order of remaining scripts). */
export function removeScript(
  packagePath: string,
  scriptName: string
): ScriptMutationResult {
  const { filePath, pkg } = readPackageJson(packagePath);
  const scripts = pkg.scripts as Record<string, string>;
  if (!(scriptName in scripts)) {
    throw new Error(`Script "${scriptName}" not found`);
  }

  const next: Record<string, string> = {};
  for (const [key, value] of Object.entries(scripts)) {
    if (key === scriptName) continue;
    next[key] = value;
  }
  pkg.scripts = next;
  writePackageJson(filePath, pkg);
  return { packagePath, scripts: asScripts(pkg) };
}

/** Update script command and/or rename the script key in package.json. */
export function updateScript(
  packagePath: string,
  scriptName: string,
  patch: { name?: string; command?: string }
): ScriptMutationResult {
  const { filePath, pkg } = readPackageJson(packagePath);
  const scripts = pkg.scripts as Record<string, string>;
  if (!(scriptName in scripts)) {
    throw new Error(`Script "${scriptName}" not found`);
  }

  const newName = (patch.name ?? scriptName).trim();
  const newCommand =
    patch.command !== undefined ? patch.command : scripts[scriptName];

  if (!newName) {
    throw new Error("Script name cannot be empty");
  }
  if (newName.startsWith("---")) {
    throw new Error('Script name cannot start with "---"');
  }
  if (newName !== scriptName && newName in scripts) {
    throw new Error(`Script "${newName}" already exists`);
  }

  const next: Record<string, string> = {};
  for (const [key, value] of Object.entries(scripts)) {
    if (key === scriptName) {
      next[newName] = newCommand;
    } else {
      next[key] = value;
    }
  }
  pkg.scripts = next;
  writePackageJson(filePath, pkg);
  return { packagePath, scripts: asScripts(pkg) };
}
