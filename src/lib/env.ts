import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

const here = path.dirname(fileURLToPath(import.meta.url));

/** Package root whether running from `src/lib` or `dist/lib`. */
export const packageRoot = path.resolve(here, "..", "..");

/** Default data root for a global CLI: `./data` in the current working directory. */
export function defaultDataRoot(): string {
  return path.resolve(process.cwd(), "data");
}

export const defaultDataDir = path.join(defaultDataRoot(), "searches");

export const defaultResultsDir = path.join(defaultDataRoot(), "results");

export const defaultLogDir = path.join(defaultDataRoot(), "logs");

let loaded = false;

export function dataDirFromArgv(argv: string[] = process.argv): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--data-dir" || arg === "--dataDir") {
      const next = argv[i + 1];
      if (next && !next.startsWith("-")) return next;
    }
    if (arg.startsWith("--data-dir=")) return arg.slice("--data-dir=".length);
    if (arg.startsWith("--dataDir=")) return arg.slice("--dataDir=".length);
  }
  return undefined;
}

/** Scope searches, results, logs, and config under one root. */
export function applyDataRoot(root: string, overwrite = false): string {
  const resolved = path.resolve(root);
  process.env.PHRASES_DATA_ROOT = resolved;
  const set = (key: string, value: string) => {
    if (overwrite || !process.env[key]?.trim()) process.env[key] = value;
  };
  set("PHRASES_DATA_DIR", path.join(resolved, "searches"));
  set("PHRASES_RESULTS_DIR", path.join(resolved, "results"));
  set("PHRASES_LOG_DIR", path.join(resolved, "logs"));
  set("PHRASES_CONFIG", path.join(resolved, "config.json"));
  return resolved;
}

export function resolvedDataRoot(): string {
  return process.env.PHRASES_DATA_ROOT?.trim() || defaultDataRoot();
}

export function resolvedSearchesDir(): string {
  return process.env.PHRASES_DATA_DIR?.trim() || path.join(resolvedDataRoot(), "searches");
}

export function resolvedResultsDir(): string {
  return process.env.PHRASES_RESULTS_DIR?.trim() || path.join(resolvedDataRoot(), "results");
}

export function loadEnv(): void {
  if (loaded) return;
  loaded = true;
  const candidates = [
    path.join(process.cwd(), ".env"),
    path.join(packageRoot, ".env"),
  ];
  for (const file of candidates) {
    if (fs.existsSync(file)) {
      dotenv.config({ path: file });
      break;
    }
  }
  const fromArgv = dataDirFromArgv();
  const root =
    fromArgv ||
    process.env.PHRASES_DATA?.trim() ||
    process.env.PHRASES_DATA_ROOT?.trim() ||
    defaultDataRoot();
  applyDataRoot(root, Boolean(fromArgv));
}

export function requireSerpapiKey(): string {
  loadEnv();
  const key = process.env.SERPAPI_KEY?.trim();
  if (!key) {
    throw new Error(
      `SERPAPI_KEY missing. Put it in ${path.join(process.cwd(), ".env")}`
    );
  }
  return key;
}
