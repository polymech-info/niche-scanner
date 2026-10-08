import type {
  CapabilityKind,
  CapabilityWorkflow,
  ProductCapability,
  ProductCapabilitySnapshot,
} from "./capabilities.js";

function wordList(raw: unknown): string[] {
  const parts = Array.isArray(raw)
    ? raw.map((item) => String(item ?? ""))
    : typeof raw === "string"
      ? raw.split(/[,\n]/)
      : [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of parts) {
    const word = part.toLowerCase().replace(/\s+/g, " ").trim();
    if (!word || seen.has(word)) continue;
    seen.add(word);
    out.push(word);
  }
  return out;
}

export interface CapabilityOverlay {
  disabled: string[];
  disabledWorkflows: string[];
  custom: ProductCapability[];
}

export const EMPTY_CAPABILITY_OVERLAY: CapabilityOverlay = {
  disabled: [],
  disabledWorkflows: [],
  custom: [],
};

const KINDS = new Set<CapabilityKind>([
  "command",
  "block",
  "surface",
  "documentation",
]);

export function isCustomCapabilityId(id: string): boolean {
  return id.startsWith("custom:");
}

export function slugCapabilityId(label: string): string {
  const slug =
    label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "capability";
  return `custom:${slug}`;
}

function uniqueIds(values: unknown): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const parts = Array.isArray(values)
    ? values.map((item) => String(item ?? "").trim())
    : [];
  for (const id of parts) {
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

function asKind(raw: unknown): CapabilityKind {
  const kind = String(raw ?? "documentation").trim() as CapabilityKind;
  return KINDS.has(kind) ? kind : "documentation";
}

export function parseCustomCapability(
  raw: unknown,
  taken = new Set<string>()
): ProductCapability | null {
  if (!raw || typeof raw !== "object") return null;
  const data = raw as Record<string, unknown>;
  const label = String(data.label ?? "").trim();
  if (!label) return null;
  let id = String(data.id ?? "").trim();
  if (!id) id = slugCapabilityId(label);
  if (!isCustomCapabilityId(id)) id = slugCapabilityId(id);
  if (taken.has(id)) {
    let n = 2;
    while (taken.has(`${id}-${n}`)) n += 1;
    id = `${id}-${n}`;
  }
  const description = String(data.description ?? "").trim() || label;
  return {
    id,
    kind: asKind(data.kind),
    label,
    description,
    available: data.available !== false,
    terms: wordList(data.terms),
    options: [],
    inputs: wordList(data.inputs),
    outputs: wordList(data.outputs),
    source: "custom",
  };
}

export function parseCapabilityOverlay(raw: unknown): CapabilityOverlay {
  if (!raw || typeof raw !== "object") return { ...EMPTY_CAPABILITY_OVERLAY };
  const data = raw as Record<string, unknown>;
  const taken = new Set<string>();
  const custom: ProductCapability[] = [];
  const rows = Array.isArray(data.custom) ? data.custom : [];
  for (const row of rows) {
    const parsed = parseCustomCapability(row, taken);
    if (!parsed) continue;
    taken.add(parsed.id);
    custom.push(parsed);
  }
  return {
    disabled: uniqueIds(data.disabled),
    disabledWorkflows: uniqueIds(data.disabledWorkflows),
    custom,
  };
}

export function applyCapabilityOverlay(
  snapshot: ProductCapabilitySnapshot,
  overlay: CapabilityOverlay
): ProductCapabilitySnapshot {
  const disabled = new Set(overlay.disabled);
  const compiledIds = new Set(snapshot.capabilities.map((node) => node.id));
  const capabilities = [
    ...snapshot.capabilities.map((node) => ({
      ...node,
      available: node.available !== false && !disabled.has(node.id),
    })),
    ...overlay.custom
      .filter((node) => !compiledIds.has(node.id))
      .map((node) => ({
        ...node,
        available: node.available !== false && !disabled.has(node.id),
        source: "custom",
      })),
  ];
  const workflows: CapabilityWorkflow[] = snapshot.workflows.map((flow) => ({
    ...flow,
  }));
  return { ...snapshot, capabilities, workflows };
}

export function activeCapabilitySnapshot(
  snapshot: ProductCapabilitySnapshot,
  overlay: CapabilityOverlay
): ProductCapabilitySnapshot {
  const applied = applyCapabilityOverlay(snapshot, overlay);
  const disabledWorkflows = new Set(overlay.disabledWorkflows);
  return {
    ...applied,
    capabilities: applied.capabilities.filter((node) => node.available !== false),
    workflows: applied.workflows.filter((flow) => !disabledWorkflows.has(flow.id)),
  };
}
