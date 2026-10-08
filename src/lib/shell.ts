import { execFileSync, spawn } from "node:child_process";
import fs from "fs/promises";
import path from "node:path";
import { ensureLogDirs, log, shellTranscriptPath } from "./log.js";

export interface ShellRunInput {
  bin: string;
  args: string[];
  cwd?: string;
  label?: string;
  timeoutMs?: number;
}

export interface ShellRunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  ms: number;
  transcript: string;
}

const resolvedBins = new Map<string, string>();

function resolveBin(bin: string): string {
  if (process.platform !== "win32") return bin;
  if (/\.(exe|cmd|bat)$/i.test(bin) || /[\\/]/.test(bin)) return bin;
  const cached = resolvedBins.get(bin);
  if (cached) return cached;
  try {
    const found = execFileSync("where.exe", [bin], { encoding: "utf8" })
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean);
    if (found) {
      resolvedBins.set(bin, found);
      return found;
    }
  } catch {
    // fall through
  }
  return bin;
}

function quoteCmd(value: string): string {
  if (!/[\s"&<>()^|%!]/.test(value)) return value;
  return `"${value.replace(/"/g, '""')}"`;
}

function redactArgs(args: string[]): string[] {
  const out = [...args];
  for (let i = 0; i < out.length; i += 1) {
    const flag = out[i];
    if (
      (flag === "--api-key" || flag === "--token" || flag === "--key") &&
      out[i + 1]
    ) {
      out[i + 1] = "***";
    }
  }
  return out;
}

export async function runShell(input: ShellRunInput): Promise<ShellRunResult> {
  const label = input.label || input.bin;
  const transcript = shellTranscriptPath(label);
  const args = input.args;
  const bin = resolveBin(input.bin);
  const started = Date.now();
  const childLog = log.child({ component: "shell", label });

  childLog.info(
    { bin, args: redactArgs(args), cwd: input.cwd, transcript },
    "shell start"
  );

  const result = await new Promise<Omit<ShellRunResult, "transcript" | "ms">>(
    (resolve, reject) => {
      const child = spawn(bin, args, { cwd: input.cwd, env: process.env });
      let stdout = "";
      let stderr = "";
      let settled = false;

      const timer =
        input.timeoutMs && input.timeoutMs > 0
          ? setTimeout(() => {
              child.kill();
              if (settled) return;
              settled = true;
              reject(new Error(`${input.bin} timed out after ${input.timeoutMs}ms`));
            }, input.timeoutMs)
          : null;

      child.stdout.on("data", (chunk) => {
        stdout += String(chunk);
      });
      child.stderr.on("data", (chunk) => {
        stderr += String(chunk);
      });
      child.on("error", (err) => {
        if (timer) clearTimeout(timer);
        if (settled) return;
        settled = true;
        reject(
          new Error(`Cannot run ${input.bin}. Is it on PATH? ${err.message}`)
        );
      });
      child.on("close", (code) => {
        if (timer) clearTimeout(timer);
        if (settled) return;
        settled = true;
        resolve({ code, stdout, stderr });
      });
    }
  );

  const ms = Date.now() - started;
  const body = [
    `$ ${bin} ${redactArgs(args).map(quoteCmd).join(" ")}`,
    `cwd ${input.cwd ?? process.cwd()}`,
    `exit ${result.code} in ${ms}ms`,
    "",
    "--- stdout ---",
    result.stdout || "(empty)",
    "",
    "--- stderr ---",
    result.stderr || "(empty)",
    "",
  ].join("\n");
  ensureLogDirs();
  await fs.mkdir(path.dirname(transcript), { recursive: true });
  await fs.writeFile(transcript, body, "utf8");

  const payload = {
    code: result.code,
    ms,
    transcript,
    stdoutBytes: Buffer.byteLength(result.stdout),
    stderrBytes: Buffer.byteLength(result.stderr),
    stderr: result.stderr.trim() || undefined,
  };

  if (result.code === 0) {
    childLog.info(payload, "shell ok");
  } else {
    childLog.error(payload, "shell failed");
  }

  return { ...result, ms, transcript };
}
