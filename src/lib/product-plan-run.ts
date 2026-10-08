import { log } from "./log.js";

export type ProductPlanLogLevel = "info" | "warn" | "error";

export interface ProductPlanLogEvent {
  at: string;
  level: ProductPlanLogLevel;
  stage: string;
  jobId?: string;
  message: string;
}

export interface ProductPlanRunState {
  status: "idle" | "running" | "ok" | "error";
  startedAt: string | null;
  finishedAt: string | null;
  outDir: string;
  jobs: number;
  current: { stage: string; jobId?: string; label?: string } | null;
  events: ProductPlanLogEvent[];
  error?: string;
}

const MAX_EVENTS = 200;
const quiet = Boolean(process.env.NODE_TEST_CONTEXT);

let state: ProductPlanRunState = emptyRun("");

function emptyRun(outDir: string): ProductPlanRunState {
  return {
    status: "idle",
    startedAt: null,
    finishedAt: null,
    outDir,
    jobs: 0,
    current: null,
    events: [],
  };
}

export function productPlanRunState(): ProductPlanRunState {
  return state;
}

export function resetProductPlanRun(outDir = ""): void {
  state = emptyRun(outDir);
}

export function beginProductPlanRun(input: {
  outDir?: string;
  jobs: number;
}): void {
  state = {
    ...emptyRun(input.outDir ?? ""),
    status: "running",
    startedAt: new Date().toISOString(),
    jobs: input.jobs,
  };
  noteProductPlan("start", `Starting ${input.jobs} job${input.jobs === 1 ? "" : "s"}`);
}

export function noteProductPlan(
  stage: string,
  message: string,
  extra: { level?: ProductPlanLogLevel; jobId?: string; label?: string } = {}
): void {
  const level = extra.level ?? "info";
  const event: ProductPlanLogEvent = {
    at: new Date().toISOString(),
    level,
    stage,
    jobId: extra.jobId,
    message,
  };
  state = {
    ...state,
    current: {
      stage,
      jobId: extra.jobId,
      label: extra.label,
    },
    events: [...state.events, event].slice(-MAX_EVENTS),
  };
  const line = extra.jobId
    ? `[product-plan] ${stage} ${extra.jobId} ${message}`
    : `[product-plan] ${stage} ${message}`;
  if (level === "error") log.error({ stage, jobId: extra.jobId }, message);
  else if (level === "warn") log.warn({ stage, jobId: extra.jobId }, message);
  else log.info({ stage, jobId: extra.jobId }, message);
  if (!quiet) process.stderr.write(`${line}\n`);
}

export function endProductPlanRun(
  status: "ok" | "error",
  error?: unknown
): void {
  const message =
    error instanceof Error ? error.message : error ? String(error) : undefined;
  if (status === "error" && message) {
    noteProductPlan("done", message, { level: "error" });
  } else {
    noteProductPlan("done", `Wrote ${state.outDir}`);
  }
  state = {
    ...state,
    status,
    finishedAt: new Date().toISOString(),
    current: null,
    error: message,
  };
}
