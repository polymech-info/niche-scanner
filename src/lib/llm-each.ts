import { log } from "./log.js";
import { runShell } from "./shell.js";

export interface LlmEachInput {
  source: string;
  dest: string;
  selector: string;
  prompt: string;
  force?: boolean;
  dryRun?: boolean;
  concurrency?: number;
}

export interface LlmEachResult {
  ok: boolean;
  cacheHits: number;
  transformed: number;
  matched: number;
  errors: number;
  output: unknown;
  raw: string;
}

function llmBin(): string {
  return process.env.PHRASES_LLM_BIN?.trim() || "tanit-cli";
}

export async function runLlmEach(input: LlmEachInput): Promise<LlmEachResult> {
  const args = [
    "llm",
    "agent",
    "each",
    "-i",
    input.source,
    "--selector",
    input.selector,
    "--merge-json",
    "-o",
    input.dest,
    "--json",
  ];
  if (input.dryRun) {
    args.push("--dry-run", "--transform", "json-stub");
  } else {
    args.push("-p", input.prompt);
  }
  if (input.force) args.push("--no-cache");
  if (input.concurrency) args.push("--concurrency", String(input.concurrency));
  const router = process.env.PHRASES_LLM_ROUTER?.trim();
  const model = process.env.PHRASES_LLM_MODEL?.trim();
  if (router) args.push("--router", router);
  if (model) args.push("--model", model);

  const bin = llmBin();
  log.info(
    { bin, source: input.source, dest: input.dest, dryRun: Boolean(input.dryRun) },
    "llm each"
  );
  const run = await runShell({
    bin,
    args,
    label: "tanit-cli-each",
    timeoutMs: 10 * 60 * 1000,
  });
  if (run.code !== 0) {
    throw new Error(
      `${bin} exited ${run.code}${run.stderr.trim() ? `: ${run.stderr.trim()}` : ""} (log ${run.transcript})`
    );
  }
  const parsed = JSON.parse(run.stdout) as LlmEachResult & { error?: string };
  if (!parsed.ok) {
    throw new Error(
      `${parsed.error || "tanit-cli llm agent each failed"} (log ${run.transcript})`
    );
  }
  return {
    ok: true,
    cacheHits: Number(parsed.cacheHits ?? 0),
    transformed: Number(parsed.transformed ?? 0),
    matched: Number(parsed.matched ?? 0),
    errors: Number(parsed.errors ?? 0),
    output: parsed.output,
    raw: run.stdout,
  };
}
