import { normalizePhrase } from "./phrases.js";
import type { ProductProfile } from "./config.js";

export type CapabilityKind = "command" | "block" | "surface" | "documentation";
export type CapabilityFit =
  | "direct"
  | "composed"
  | "editorial"
  | "unsupported"
  | "unknown";

export interface CapabilityOption {
  name: string;
  description?: string;
  type?: string;
  required?: boolean;
  default?: string;
}

export interface CapabilitySection {
  id: string;
  label: string;
  summary: string;
  command?: string;
}

export interface ProductCapability {
  id: string;
  kind: CapabilityKind;
  label: string;
  description: string;
  available: boolean;
  terms: string[];
  options: CapabilityOption[];
  inputs: string[];
  outputs: string[];
  source: string;
  sections?: CapabilitySection[];
}

export interface CapabilityWorkflow {
  id: string;
  label: string;
  nodeIds: string[];
  source: string;
}

export interface ProductCapabilitySnapshot {
  schemaVersion: 1;
  generatedAt: string;
  product: string;
  sources: {
    commands: string;
    xblox: string;
    examples: string[];
    documentation: string[];
  };
  capabilities: ProductCapability[];
  workflows: CapabilityWorkflow[];
}

export interface CapabilityEvidence {
  nodeId: string;
  label: string;
  kind: CapabilityKind;
  score: number;
  source: string;
}

export interface ProductMatch {
  fit: CapabilityFit;
  confidence: number;
  outcome: string;
  input?: string;
  output?: string;
  platforms: string[];
  nodeIds: string[];
  workflowId?: string;
  evidence: CapabilityEvidence[];
  constraints: string[];
  followUps: string[];
  rationale: string;
}

interface RawCommandOption {
  name?: unknown;
  description?: unknown;
  type?: unknown;
  required?: unknown;
  default?: unknown;
}

interface RawCapability {
  id?: unknown;
  name?: unknown;
  kind?: unknown;
  label?: unknown;
  group?: unknown;
  description?: unknown;
  overlay?: unknown;
  available?: unknown;
  paletteVisible?: unknown;
  params?: unknown;
  options?: unknown;
  outputs?: unknown;
}

interface RawCustomCommand {
  id?: unknown;
  label?: unknown;
  group?: unknown;
  type?: unknown;
  action?: unknown;
  description?: unknown;
  tooltip?: unknown;
  overlay?: unknown;
  command_name?: unknown;
  args?: unknown;
  cwd?: unknown;
  returns?: unknown;
  source?: {
    kind?: unknown;
    files?: unknown;
    folders?: unknown;
    selectionMode?: unknown;
    includeSubfolders?: unknown;
  };
  output?: {
    directory?: unknown;
    filenamePattern?: unknown;
    overwrite?: unknown;
  };
  explorerFileTypes?: unknown;
  extension_maps?: Array<{ accepts?: unknown; generates?: unknown }>;
  voiceCommand?: unknown;
}

export interface RawWorkflow {
  id: string;
  label?: string;
  source: string;
  kinds: string[];
}

export interface RawCapabilityDocument {
  id: string;
  label: string;
  description: string;
  source: string;
  sections?: CapabilitySection[];
}

const INTERNAL_COMMANDS = new Set(["commands", "info", "service"]);
const FORMAT_WORDS = new Set([
  "audio",
  "avif",
  "csv",
  "doc",
  "docx",
  "excel",
  "gif",
  "html",
  "image",
  "jpeg",
  "jpg",
  "json",
  "markdown",
  "md",
  "mp3",
  "mp4",
  "pdf",
  "png",
  "speech",
  "text",
  "video",
  "wav",
  "webp",
  "xlsx",
]);
const QUERY_STOP = new Set([
  "a",
  "an",
  "and",
  "app",
  "best",
  "can",
  "do",
  "file",
  "files",
  "for",
  "free",
  "how",
  "i",
  "in",
  "is",
  "my",
  "of",
  "on",
  "online",
  "the",
  "to",
  "using",
  "way",
  "what",
  "with",
  "you",
]);
const WEAK_MATCH_TERMS = new Set([
  "create",
  "data",
  "file",
  "input",
  "manage",
  "open",
  "output",
  "source",
  "support",
  "use",
  "view",
]);

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function words(value: string): string[] {
  return normalizePhrase(value)
    .split(/[^a-z0-9+]+/)
    .map((part) => part.replace(/^[.-]+|[.-]+$/g, ""))
    .filter((part) => part.length > 1 && !QUERY_STOP.has(part))
    .map((part) => {
      if (/^(md|markdown)$/.test(part)) return "markdown";
      if (/^(open|opens|opening|preview|previews|viewer|viewing)$/.test(part)) {
        return "view";
      }
      if (/^(translate|translated|translation|translations)$/.test(part)) {
        return "translate";
      }
      if (/^(record|recorded|recorder|recorders|recording|recordings)$/.test(part)) {
        return "record";
      }
      if (/^(spreadsheet|spreadsheets|xlsx)$/.test(part)) return "excel";
      if (part.endsWith("s") && part.length > 4) return part.slice(0, -1);
      return part;
    });
}

function unique(values: Iterable<string>): string[] {
  return [...new Set([...values].filter(Boolean))];
}

function compactOptions(raw: unknown): CapabilityOption[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item) => item as RawCommandOption)
    .filter((item) => {
      const name = text(item.name);
      if (!name || ["-h", "--help", "--json", "--log-level"].includes(name)) {
        return false;
      }
      return (
        Boolean(item.required) ||
        /(^|[-_])(src|dst|input|output|file|path|format|provider|model|language|prompt|text|mode|quality|width|height|command|url|type|storeas)($|[-_])/i.test(
          name
        )
      );
    })
    .map((item) => ({
      name: text(item.name),
      description: text(item.description).slice(0, 220) || undefined,
      type: text(item.type) || undefined,
      required: Boolean(item.required),
      default: text(item.default) || undefined,
    }));
}

function ioTerms(value: unknown): string[] {
  const serialized = JSON.stringify(value ?? "").toLowerCase();
  return [...FORMAT_WORDS].filter((format) =>
    new RegExp(`(^|[^a-z0-9])${format}([^a-z0-9]|$)`).test(serialized)
  );
}

function usefulProse(value: string, label: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  if (/^(description|tooltip)$/i.test(trimmed)) return "";
  if (trimmed.toLowerCase() === label.toLowerCase()) return trimmed;
  return trimmed;
}

function commandNode(raw: RawCapability): ProductCapability | null {
  const id = text(raw.id);
  if (!id || INTERNAL_COMMANDS.has(id) || raw.available === false) return null;
  const label = text(raw.label) || id;
  const description = [
    text(raw.description),
    usefulProse(text(raw.overlay), label),
  ]
    .filter(Boolean)
    .join(". ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 1200);
  const options = compactOptions(raw.options);
  const searchable = `${id} ${label} ${description} ${options
    .map((option) => `${option.name} ${option.description ?? ""}`)
    .join(" ")}`;
  return {
    id: `command:${id}`,
    kind: "command",
    label,
    description,
    available: true,
    terms: unique(words(searchable)).slice(0, 48),
    options,
    inputs: ioTerms(
      options.filter((option) => /input|source|src|from/i.test(option.name))
    ),
    outputs: ioTerms(
      options.filter((option) => /output|destination|dst|format|to/i.test(option.name))
    ),
    source: "tanit-cli info commands --json",
  };
}

function stringList(raw: unknown): string[] {
  if (Array.isArray(raw)) {
    return unique(raw.map((item) => text(item)).filter(Boolean));
  }
  const value = text(raw);
  return value ? value.split(/[,\n]/).map((part) => part.trim()).filter(Boolean) : [];
}

function customCommandNode(raw: RawCustomCommand): ProductCapability | null {
  const id = text(raw.id);
  const type = text(raw.type).toLowerCase();
  if (!id || type === "dropdown" || type === "separator") return null;
  const label = text(raw.label) || id;
  const args = stringList(raw.args);
  const accepts = unique(
    (raw.extension_maps ?? []).flatMap((row) => stringList(row.accepts))
  );
  const generates = unique(
    (raw.extension_maps ?? []).flatMap((row) => stringList(row.generates))
  );
  const sourceFiles = stringList(raw.source?.files);
  const sourceFolders = stringList(raw.source?.folders);
  const explorerTypes = stringList(raw.explorerFileTypes);
  const description = [
    usefulProse(text(raw.description) || text(raw.tooltip), label),
    text(raw.group) ? `Group: ${text(raw.group)}` : "",
    text(raw.action) ? `Action ${text(raw.action)}` : "",
    text(raw.command_name) ? `Runs ${text(raw.command_name)}` : "",
    args.length ? `Args: ${args.join(" ")}` : "",
    text(raw.cwd) ? `cwd ${text(raw.cwd)}` : "",
    text(raw.returns) ? `Returns ${text(raw.returns)}` : "",
    text(raw.source?.kind) ? `Source ${text(raw.source?.kind)}` : "",
    text(raw.source?.selectionMode)
      ? `Selection ${text(raw.source?.selectionMode)}`
      : "",
    sourceFiles.length ? `Files ${sourceFiles.join(" ")}` : "",
    sourceFolders.length ? `Folders ${sourceFolders.join(" ")}` : "",
    raw.source?.includeSubfolders ? "Includes subfolders" : "",
    text(raw.output?.directory) ? `Output ${text(raw.output?.directory)}` : "",
    text(raw.output?.filenamePattern)
      ? `Pattern ${text(raw.output?.filenamePattern)}`
      : "",
    raw.output?.overwrite ? "Overwrite" : "",
    explorerTypes.length ? `Explorer ${explorerTypes.join(" ")}` : "",
    accepts.length || generates.length
      ? `Maps ${accepts.join(", ") || "*"} → ${generates.join(", ") || "*"}`
      : "",
    usefulProse(text(raw.overlay), label),
    text(raw.voiceCommand) ? `Voice: ${text(raw.voiceCommand)}` : "",
  ]
    .filter(Boolean)
    .join(". ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 1200);
  const options: CapabilityOption[] = [
    ...args.map((arg) => ({
      name: arg,
      description: /\$\{CURRENT_(FILE|PATH|SELECTION)\}/.test(arg)
        ? "Bound to the current file, folder, or selection"
        : undefined,
    })),
    ...accepts.map((ext) => ({ name: `accepts:${ext}`, type: "format" })),
    ...generates.map((ext) => ({ name: `generates:${ext}`, type: "format" })),
  ];
  const searchable = `${id} ${label} ${description} ${text(raw.command_name)} ${explorerTypes.join(" ")}`;
  return {
    id: `command:${id}`,
    kind: "command",
    label,
    description,
    available: true,
    terms: unique(words(searchable)).slice(0, 64),
    options,
    inputs: unique([
      ...ioTerms(searchable),
      ...accepts,
      ...explorerTypes,
      ...sourceFiles,
      ...sourceFolders,
    ]),
    outputs: unique([...ioTerms(text(raw.output?.filenamePattern)), ...generates]),
    source: "tanit-cli info commands --json custom",
  };
}

function rawCustomCommands(value: unknown): RawCustomCommand[] {
  if (!value || typeof value !== "object") return [];
  const rows = (value as Record<string, unknown>).custom_commands;
  return Array.isArray(rows) ? (rows as RawCustomCommand[]) : [];
}

function blockNode(raw: RawCapability): ProductCapability | null {
  const id = text(raw.kind) || text(raw.id);
  if (!id || raw.paletteVisible === false) return null;
  const label = text(raw.label) || id;
  const description = text(raw.description);
  const options = compactOptions(raw.params);
  const searchable = `${id} ${label} ${description} ${options
    .map((option) => `${option.name} ${option.description ?? ""}`)
    .join(" ")}`;
  return {
    id: `block:${id}`,
    kind: "block",
    label,
    description,
    available: true,
    terms: unique(words(searchable)).slice(0, 48),
    options,
    inputs: ioTerms(raw.params),
    outputs: ioTerms(raw.outputs),
    source: "tanit-cli xblox info --json",
  };
}

function surfaceNodes(
  appCommands: unknown,
  ui: unknown
): ProductCapability[] {
  const app = (
    (appCommands as Record<string, unknown> | null)?.app_commands ?? []
  ) as RawCapability[];
  const appNodes = Array.isArray(app)
    ? app
        .filter((row) => row.available !== false && text(row.name))
        .map((row) => {
          const id = text(row.name);
          const label = text(row.label) || id;
          const description = `${text(row.group)} ${label}`.trim();
          return {
            id: `surface:app:${id}`,
            kind: "surface" as const,
            label,
            description,
            available: true,
            terms: unique(words(`${id} ${description}`)).slice(0, 48),
            options: [],
            inputs: ioTerms(description),
            outputs: [],
            source: "tanit-cli info app-commands --json",
          };
        })
    : [];
  const launch = (
    (ui as Record<string, unknown> | null)?.ui_launch ?? []
  ) as RawCommandOption[];
  const launchOptions = compactOptions(launch).filter(
    (option) => !/dev|debug|console|settings/i.test(option.name)
  );
  if (!launchOptions.length) return appNodes;
  const description = launchOptions
    .map((option) => option.description ?? "")
    .filter(Boolean)
    .join(" ");
  return [
    ...appNodes,
    {
      id: "surface:ui-launch",
      kind: "surface",
      label: "Open files in the Tanit viewer",
      description,
      available: true,
      terms: unique(words(`viewer open files ${description}`)).slice(0, 48),
      options: launchOptions,
      inputs: ioTerms(description),
      outputs: [],
      source: "tanit-cli info ui --json",
    },
  ];
}

function documentNode(raw: RawCapabilityDocument): ProductCapability {
  return {
    id: `documentation:${raw.id}`,
    kind: "documentation",
    label: raw.label,
    description: raw.description.slice(0, 1200),
    available: true,
    terms: unique(words(`${raw.label} ${raw.description}`)).slice(0, 64),
    options: [],
    inputs: ioTerms(`${raw.label} ${raw.description}`),
    outputs: ioTerms(raw.description),
    source: raw.source,
    ...(raw.sections?.length ? { sections: raw.sections } : {}),
  };
}

function rawCommands(value: unknown): RawCapability[] {
  if (!value || typeof value !== "object") return [];
  const data = value as Record<string, unknown>;
  if (Array.isArray(data.commands)) return data.commands as RawCapability[];
  const nested = data.document;
  if (nested && typeof nested === "object") return rawCommands(nested);
  return [];
}

function rawBlocks(value: unknown): RawCapability[] {
  if (!value || typeof value !== "object") return [];
  const blocks = (value as Record<string, unknown>).blocks;
  return Array.isArray(blocks) ? (blocks as RawCapability[]) : [];
}

export function compileCapabilitySnapshot(input: {
  commands: unknown;
  xblox: unknown;
  appCommands?: unknown;
  ui?: unknown;
  documents?: RawCapabilityDocument[];
  workflows?: RawWorkflow[];
  generatedAt?: string;
  product?: string;
}): ProductCapabilitySnapshot {
  const xbloxData =
    input.xblox && typeof input.xblox === "object"
      ? (input.xblox as Record<string, unknown>)
      : {};
  const commandPayload =
    rawCommands(input.commands).length > 0
      ? input.commands
      : (xbloxData.commands as Record<string, unknown> | undefined)?.document;
  const capabilities = [
    ...rawCommands(commandPayload).map(commandNode),
    ...rawCustomCommands(commandPayload).map(customCommandNode),
    ...rawBlocks(input.xblox).map(blockNode),
    ...surfaceNodes(input.appCommands, input.ui),
    ...(input.documents ?? []).map(documentNode),
  ].filter((node): node is ProductCapability => Boolean(node));
  const nodeIds = new Set(capabilities.map((node) => node.id));
  const seenWorkflows = new Set<string>();
  const workflows = (input.workflows ?? [])
    .map((flow) => ({
      id: `workflow:${flow.id}`,
      label: flow.label?.trim() || flow.id,
      nodeIds: flow.kinds
        .map((kind) => `block:${kind}`)
        .filter((id) => nodeIds.has(id)),
      source: flow.source,
    }))
    .filter((flow) => {
      if (flow.nodeIds.length < 2) return false;
      if (seenWorkflows.has(flow.id)) return false;
      seenWorkflows.add(flow.id);
      return true;
    });
  return {
    schemaVersion: 1,
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    product: input.product ?? "Tanit",
    sources: {
      commands: "tanit-cli info commands --json",
      xblox: "tanit-cli xblox info --json",
      examples: unique(workflows.map((flow) => flow.source)),
      documentation: unique((input.documents ?? []).map((doc) => doc.source)),
    },
    capabilities,
    workflows,
  };
}

function platformTokens(phrase: string, product: ProductProfile | null): string[] {
  if (!product) return [];
  const query = new Set(
    normalizePhrase(phrase)
      .split(/[^a-z0-9]+/)
      .filter(Boolean)
      .map((token) => {
        if (/^phones?$/.test(token)) return "mobile";
        if (token === "macos") return "mac";
        return token;
      })
  );
  const normalized = normalizePhrase(phrase);
  return unique([...product.platforms, ...product.notPlatforms]).filter((item) => {
    if (!query.has(item)) return false;
    if (item !== "browser") return true;
    return (
      /\b(web|internet) browser\b/.test(normalized) ||
      /\bbrowser[- ]?(based|extension|app)\b/.test(normalized) ||
      /\bin (a|the|your|my) browser\b/.test(normalized)
    );
  });
}

function capabilityScore(query: Set<string>, node: ProductCapability): number {
  const terms = new Set(node.terms);
  let score = 0;
  for (const token of query) {
    if (terms.has(token)) score += 2;
    if (node.label.toLowerCase() === token || node.id.endsWith(`:${token}`)) score += 2;
  }
  const label = normalizePhrase(node.label);
  if (label.length > 2 && normalizePhrase([...query].join(" ")).includes(label)) {
    score += 3;
  }
  return score;
}

function capabilityCoverage(
  query: ReadonlySet<string>,
  node: ProductCapability
): number {
  const terms = new Set(node.terms);
  return [...query].filter(
    (token) =>
      terms.has(token) ||
      node.id.endsWith(`:${token}`) ||
      words(node.label).includes(token)
  ).length;
}

function strongCapabilityCoverage(
  query: ReadonlySet<string>,
  node: ProductCapability
): number {
  const terms = new Set(node.terms);
  return [...query].filter(
    (token) =>
      !WEAK_MATCH_TERMS.has(token) &&
      (terms.has(token) ||
        node.id.endsWith(`:${token}`) ||
        words(node.label).includes(token))
  ).length;
}

function requestedFormat(tokens: Set<string>, candidates: string[]): string | undefined {
  return candidates.find((format) => tokens.has(format));
}

export function resolveCapability(
  phrase: string,
  snapshot: ProductCapabilitySnapshot | null,
  product: ProductProfile | null
): ProductMatch {
  const queryTokens = new Set(words(phrase));
  const platforms = platformTokens(phrase, product);
  const denied = new Set(product?.notPlatforms ?? []);
  const deniedPlatform = platforms.find((platform) => denied.has(platform));
  const input = requestedFormat(queryTokens, [
    "markdown",
    "md",
    "excel",
    "xlsx",
    "pdf",
    "audio",
    "video",
    "image",
  ]);
  const outputCandidate =
    /\b(to|into|as)\s+([a-z0-9]+)/i.exec(phrase)?.[2]?.toLowerCase();
  const output =
    outputCandidate &&
    (FORMAT_WORDS.has(outputCandidate) || /\b(translate|convert)\b/i.test(phrase))
      ? outputCandidate
      : undefined;
  if (deniedPlatform) {
    return {
      fit: "unsupported",
      confidence: 1,
      outcome: normalizePhrase(phrase),
      input,
      output,
      platforms,
      nodeIds: [],
      evidence: [],
      constraints: [`${product?.name ?? "Product"} is not available on ${deniedPlatform}`],
      followUps: [],
      rationale: `Requested platform ${deniedPlatform} is explicitly unsupported.`,
    };
  }
  if (!snapshot) {
    return {
      fit: "unknown",
      confidence: 0,
      outcome: normalizePhrase(phrase),
      input,
      output,
      platforms,
      nodeIds: [],
      evidence: [],
      constraints: ["Capability snapshot unavailable"],
      followUps: [],
      rationale: "No product capability evidence was available.",
    };
  }
  const ranked = snapshot.capabilities
    .filter((node) => node.available !== false)
    .map((node) => ({
      node,
      score: capabilityScore(queryTokens, node),
      coverage: capabilityCoverage(queryTokens, node),
      strongCoverage: strongCapabilityCoverage(queryTokens, node),
    }))
    .filter((item) => item.score > 0 && item.strongCoverage > 0)
    .sort(
      (a, b) =>
        b.coverage - a.coverage ||
        b.score - a.score ||
        Number(b.node.kind === "command") - Number(a.node.kind === "command") ||
        a.node.id.localeCompare(b.node.id)
    )
    .slice(0, 6);
  const evidence = ranked.map(({ node, score }) => ({
    nodeId: node.id,
    label: node.label,
    kind: node.kind,
    score,
    source: node.source,
  }));
  const top = ranked[0];
  const workflow = snapshot.workflows
    .map((flow) => {
      const workflowTerms = unique(words(`${flow.label} ${flow.source}`));
      return {
        flow,
        hits: flow.nodeIds.filter((id) =>
          evidence.some((item) => item.nodeId === id && item.score >= 2)
        ),
        semanticScore: workflowTerms.reduce(
        (score, token) => score + (queryTokens.has(token) ? 2 : 0),
        0
      ),
        unmatched: workflowTerms.filter((token) => !queryTokens.has(token)).length,
      };
    })
    .filter((item) => item.hits.length >= 2 && item.semanticScore >= 3)
    .sort(
      (a, b) =>
        b.semanticScore - a.semanticScore ||
        a.unmatched - b.unmatched ||
        b.hits.length - a.hits.length
    )[0]?.flow;
  if (
    !workflow &&
    (!top || top.strongCoverage < 1 || (top.coverage < 2 && top.score < 7))
  ) {
    const editorial = Boolean(
      top && (top.strongCoverage >= 2 || input || output)
    );
    return {
      fit: editorial ? "editorial" : "unknown",
      confidence: editorial ? 0.35 : 0,
      outcome: normalizePhrase(phrase),
      input,
      output,
      platforms,
      nodeIds: editorial ? evidence.map((item) => item.nodeId) : [],
      evidence: editorial ? evidence : [],
      constraints: [],
      followUps: [],
      rationale: editorial
        ? "Product evidence is adjacent, but does not directly prove the requested job."
        : "No capability matched the requested job.",
    };
  }
  const fit: CapabilityFit = workflow ? "composed" : "direct";
  const nodeIds = workflow?.nodeIds ?? [top!.node.id];
  return {
    fit,
    confidence: Math.min(
      0.98,
      0.45 + (top?.score ?? 0) / 20 + (workflow ? 0.15 : 0)
    ),
    outcome: unique([
      normalizePhrase(workflow?.label ?? top!.node.label),
      input ?? "",
      output ? `to ${output}` : "",
    ]).join(" "),
    input,
    output,
    platforms,
    nodeIds,
    workflowId: workflow?.id,
    evidence,
    constraints: [],
    followUps: [],
    rationale: workflow
      ? `Verified example workflow ${workflow.label} connects the matched blocks.`
      : `Direct product capability matched ${top!.node.label}.`,
  };
}

export function capabilityOutcomeKey(match: ProductMatch): string {
  const base =
    match.workflowId ??
    match.nodeIds[0] ??
    match.outcome.replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return [base, match.input, match.output].filter(Boolean).join(":");
}
