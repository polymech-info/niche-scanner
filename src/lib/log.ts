import fs from "fs";
import path from "path";
import pino from "pino";
import { loadEnv, resolvedDataRoot } from "./env.js";

loadEnv();

export function resolvedLogDir(): string {
  return process.env.PHRASES_LOG_DIR?.trim() || path.join(resolvedDataRoot(), "logs");
}

export const logFile = path.join(resolvedLogDir(), "phrases.log");
export const shellLogDir = path.join(resolvedLogDir(), "shell");

export function ensureLogDirs(): void {
  fs.mkdirSync(shellLogDir, { recursive: true });
}

ensureLogDirs();

export const log = pino(
  {
    name: "phrases",
    level: process.env.PHRASES_LOG_LEVEL?.trim() || "info",
    timestamp: pino.stdTimeFunctions.isoTime,
    base: { pid: process.pid },
  },
  pino.multistream([
    {
      stream: pino.destination({ dest: logFile, mkdir: true, sync: false }),
    },
    { level: "warn", stream: process.stderr },
  ])
);

export function shellTranscriptPath(label: string): string {
  ensureLogDirs();
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const slug = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "run";
  return path.join(shellLogDir, `${stamp}-${slug}.log`);
}
