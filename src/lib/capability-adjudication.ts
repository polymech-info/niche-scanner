import fs from "node:fs/promises";
import path from "node:path";
import { normalizePhrase, type SearchDocument } from "../shared/phrases.js";
import {
  resolveCapability,
  type CapabilityFit,
  type ProductCapabilitySnapshot,
  type ProductMatch,
} from "../shared/capabilities.js";
import type { ProductProfile } from "../shared/config.js";
import { runLlmEach } from "./llm-each.js";

const PROMPT = `You classify product capability evidence for article research. Reply ONLY with a JSON object:
{"fit":"direct|composed|editorial|unsupported|unknown","confidence":0.0,"outcome":"short user outcome","nodeIds":["supplied id"],"workflowId":"supplied workflow id or omit","rationale":"one sentence","constraints":["claim limit"],"questions":["useful follow-up"]}
Rules: use only IDs present in allowedNodeIds/allowedWorkflowIds. direct requires one supplied capability. composed requires one supplied verified workflow. editorial means adjacent evidence can support an honest comparison, not the requested job. Never invent product behavior. This creates research intelligence, not article prose.`;

interface AdjudicationItem {
  phrase: string;
  evidence: {
    snapshot: string;
    deterministic: ProductMatch;
    allowedNodeIds: string[];
    allowedWorkflowIds: string[];
  };
  fit?: unknown;
  confidence?: unknown;
  outcome?: unknown;
  nodeIds?: unknown;
  workflowId?: unknown;
  rationale?: unknown;
  constraints?: unknown;
  questions?: unknown;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map(String).map((item) => item.trim()).filter(Boolean)
    : [];
}

function validate(
  item: AdjudicationItem,
  snapshot: ProductCapabilitySnapshot
): ProductMatch | null {
  const base = item.evidence.deterministic;
  const fits: CapabilityFit[] = [
    "direct",
    "composed",
    "editorial",
    "unsupported",
    "unknown",
  ];
  const fit = fits.includes(item.fit as CapabilityFit)
    ? (item.fit as CapabilityFit)
    : base.fit;
  const allowedNodes = new Set(item.evidence.allowedNodeIds);
  const nodeIds = stringArray(item.nodeIds).filter((id) => allowedNodes.has(id));
  const allowedWorkflows = new Set(item.evidence.allowedWorkflowIds);
  const workflowId =
    typeof item.workflowId === "string" && allowedWorkflows.has(item.workflowId)
      ? item.workflowId
      : undefined;
  if (fit === "direct" && !nodeIds.length) return null;
  if (fit === "composed" && !workflowId) return null;
  const workflow = workflowId
    ? snapshot.workflows.find((row) => row.id === workflowId)
    : undefined;
  const confidence = Number(item.confidence);
  return {
    ...base,
    fit,
    confidence: Number.isFinite(confidence)
      ? Math.max(0, Math.min(1, confidence))
      : base.confidence,
    outcome:
      typeof item.outcome === "string" && item.outcome.trim()
        ? item.outcome.trim()
        : base.outcome,
    nodeIds: workflow?.nodeIds ?? (nodeIds.length ? nodeIds : base.nodeIds),
    workflowId,
    constraints: stringArray(item.constraints),
    followUps: stringArray(item.questions),
    rationale:
      typeof item.rationale === "string" && item.rationale.trim()
        ? item.rationale.trim()
        : base.rationale,
  };
}

export async function adjudicateCapabilities(input: {
  doc: SearchDocument;
  product: ProductProfile | null;
  snapshot: ProductCapabilitySnapshot;
  dir: string;
  enabled: boolean;
  phrases?: ReadonlySet<string>;
}): Promise<ReadonlyMap<string, ProductMatch>> {
  if (!input.enabled) return new Map();
  const items: AdjudicationItem[] = [];
  for (const row of input.doc.phrases) {
    if (
      input.phrases &&
      !input.phrases.has(normalizePhrase(row.phrase))
    ) {
      continue;
    }
    const match = resolveCapability(row.phrase, input.snapshot, input.product);
    if (!["editorial", "composed"].includes(match.fit)) continue;
    const allowedNodeIds = [
      ...new Set([
        ...match.nodeIds,
        ...match.evidence.map((evidence) => evidence.nodeId),
      ]),
    ];
    const allowedWorkflowIds = input.snapshot.workflows
      .filter((flow) => flow.nodeIds.some((id) => allowedNodeIds.includes(id)))
      .map((flow) => flow.id);
    items.push({
      phrase: row.phrase,
      evidence: {
        snapshot: `${input.snapshot.schemaVersion}:${input.snapshot.generatedAt}`,
        deterministic: match,
        allowedNodeIds,
        allowedWorkflowIds,
      },
    });
  }
  if (!items.length) return new Map();
  const source = path.join(input.dir, "capability-adjudication.in.json");
  const dest = path.join(input.dir, "capability-adjudication.out.json");
  await fs.writeFile(source, `${JSON.stringify({ items }, null, 2)}\n`, "utf8");
  const result = await runLlmEach({
    source,
    dest,
    selector: ".items[].evidence",
    prompt: PROMPT,
    concurrency: 4,
  });
  const output = result.output as { items?: AdjudicationItem[] };
  const matches = new Map<string, ProductMatch>();
  for (const item of output.items ?? []) {
    const match = validate(item, input.snapshot);
    if (match) matches.set(normalizePhrase(item.phrase), match);
  }
  return matches;
}
