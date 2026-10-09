import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import fg from "fast-glob";
import { parse as parseYaml } from "yaml";
import {
  compileCapabilitySnapshot,
  type CapabilitySection,
  type ProductCapabilitySnapshot,
  type RawCapabilityDocument,
  type RawWorkflow,
} from "../shared/capabilities.js";
import { packageRoot } from "./env.js";
import { capabilitySnapshotPath, loadCapabilitySnapshot } from "./capabilities.js";

const exec = promisify(execFile);

export const repoRoot = path.resolve(packageRoot, "..", "..");
export const capabilityRawDir = path.join(
  repoRoot,
  "stemp",
  "lead-generator-capabilities"
);

function tanitCli(): string {
  return (
    process.env.PM_IMAGE_CLI?.trim() ||
    path.join(repoRoot, "dist", "win-x64", "tanit-cli.exe")
  );
}

async function capture(args: string[], output: string): Promise<void> {
  const result = await exec(tanitCli(), args, {
    cwd: repoRoot,
    maxBuffer: 100 * 1024 * 1024,
    windowsHide: true,
  });
  const body = result.stdout.trim();
  JSON.parse(body);
  await fs.writeFile(output, `${body}\n`, "utf8");
}

export interface CaptureResult {
  outDir: string;
  files: string[];
}

export async function captureCapabilities(): Promise<CaptureResult> {
  const outDir = capabilityRawDir;
  await fs.mkdir(outDir, { recursive: true });
  const files = [
    ["commands.raw.json", ["info", "commands", "--json", "--stdout"]],
    ["xblox.raw.json", ["xblox", "info", "--json"]],
    ["app-commands.raw.json", ["info", "app-commands", "--json", "--stdout"]],
    ["ui.raw.json", ["info", "ui", "--json", "--stdout"]],
  ] as const;
  const written: string[] = [];
  for (const [name, args] of files) {
    const output = path.join(outDir, name);
    await capture([...args], output);
    written.push(output);
  }
  return { outDir, files: written };
}

const BOILERPLATE_HEADING =
  /^(who it'?s for|who this is for|related docs|references|illustration prompts|learn more|app,\s*cli,\s*xblox)$/i;

interface FeatureFrontmatter {
  title?: string;
  description?: string;
  tags: string[];
}

interface FeatureSection {
  label: string;
  body: string;
}

function frontmatter(raw: string): FeatureFrontmatter {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(raw);
  if (!match) return { tags: [] };
  const doc = parseYaml(match[1]) as Record<string, unknown> | null;
  if (!doc || typeof doc !== "object") return { tags: [] };
  return {
    title: typeof doc.title === "string" ? doc.title.trim() : undefined,
    description:
      typeof doc.description === "string" ? doc.description.trim() : undefined,
    tags: Array.isArray(doc.tags) ? doc.tags.map((tag) => String(tag).trim()) : [],
  };
}

function cleanLabel(value: string): string {
  return value
    .replace(/\{#[^}]+\}/g, "")
    .replace(/[*`]/g, "")
    .trim();
}

function prose(value: string): string {
  return value
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[*_>|`]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function featureSections(body: string): FeatureSection[] {
  const sections: FeatureSection[] = [];
  let current: FeatureSection | null = null;
  let fence: string | null = null;
  for (const line of body.split(/\r?\n/)) {
    const fenceMark = /^\s*(`{3,}|~{3,})/.exec(line);
    if (fenceMark) {
      const mark = fenceMark[1][0];
      fence = fence === mark ? null : (fence ?? mark);
      continue;
    }
    if (fence) continue;
    const heading = /^(#{1,2})\s+(.+)/.exec(line);
    if (heading) {
      if (current?.label) sections.push(current);
      current = { label: cleanLabel(heading[2]), body: "" };
      continue;
    }
    if (current) current.body += `${line}\n`;
  }
  if (current?.label) sections.push(current);
  return sections.filter(
    (section) => section.label && !BOILERPLATE_HEADING.test(section.label)
  );
}

function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function firstFence(body: string): string | undefined {
  const match = /```[^\n]*\n([\s\S]*?)```/.exec(body);
  const text = match?.[1]?.trim();
  return text ? text.slice(0, 400) : undefined;
}

function featureSectionsAsJobs(jobs: FeatureSection[]): CapabilitySection[] {
  const taken = new Set<string>();
  const out: CapabilitySection[] = [];
  for (const section of jobs) {
    const summary = prose(section.body).slice(0, 400);
    const command = firstFence(section.body);
    if (summary.length < 20 && !command) continue;
    let id = slug(section.label) || "section";
    if (taken.has(id)) {
      let n = 2;
      while (taken.has(`${id}-${n}`)) n += 1;
      id = `${id}-${n}`;
    }
    taken.add(id);
    out.push({
      id,
      label: section.label,
      summary,
      ...(command ? { command } : {}),
    });
  }
  return out;
}

function featureDocument(
  relative: string,
  raw: string
): RawCapabilityDocument | null {
  const meta = frontmatter(raw);
  const body = raw.replace(/^---[\s\S]*?---\s*/, "");
  const sections = featureSections(body);
  const [lead, ...jobs] = sections;
  const label = meta.title || lead?.label || "";
  if (!label) return null;
  const lede = prose(lead?.body ?? "").slice(0, 360);
  const parsed = featureSectionsAsJobs(jobs);
  const jobLine = parsed.length
    ? `Jobs: ${parsed.map((job) => job.label).join("; ")}`
    : "";
  const description = [meta.description, meta.tags.join(", "), lede, jobLine]
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 1200);
  if (description.length < 30) return null;
  return {
    id: slug(path.basename(relative, ".md")),
    label,
    description,
    source: relative,
    ...(parsed.length ? { sections: parsed } : {}),
  };
}

async function jsonFile(file: string): Promise<unknown> {
  return JSON.parse(await fs.readFile(file, "utf8"));
}

function overlayStem(commandId: string): string {
  return commandId.replace(/[ .:]+/g, "_").replace(/^_+|_+$/g, "");
}

function overlayStems(commandId: string): string[] {
  const raw = commandId.trim();
  if (!raw) return [];
  return [...new Set([overlayStem(raw), overlayStem(raw.replace(/[.:]/g, " "))])].filter(
    Boolean
  );
}

async function cliCommandOverlay(stem: string): Promise<string> {
  if (!stem) return "";
  const dir = path.join(repoRoot, "releases", "web-docs", "cli");
  const chunks: string[] = [];
  for (const suffix of ["_examples.md", "_more.md"]) {
    try {
      const raw = await fs.readFile(path.join(dir, `${stem}${suffix}`), "utf8");
      const prose = raw
        .replace(/^---[\s\S]*?---\s*/, "")
        .replace(/```[\s\S]*?```/g, " ")
        .replace(/[#>*`_\[\]]/g, " ")
        .replace(/\s+/g, " ")
        .trim();
      if (prose) chunks.push(prose.slice(0, 600));
    } catch {
      // Overlay sidecars are optional, same as tanit-cli info merge.
    }
  }
  return chunks.join(" ").trim();
}

async function overlayFor(...ids: string[]): Promise<string> {
  const seen = new Set<string>();
  const chunks: string[] = [];
  for (const id of ids) {
    for (const stem of overlayStems(id)) {
      if (seen.has(stem)) continue;
      seen.add(stem);
      const prose = await cliCommandOverlay(stem);
      if (prose) chunks.push(prose);
    }
  }
  return chunks.join(" ").trim();
}

async function withCommandOverlays(row: unknown): Promise<unknown> {
  if (!row || typeof row !== "object") return row;
  const item = row as Record<string, unknown>;
  const overlay = await overlayFor(
    String(item.id ?? ""),
    String(item.command_name ?? "")
  );
  return overlay ? { ...item, overlay } : item;
}

async function withCliOverlays(commands: unknown): Promise<unknown> {
  if (!commands || typeof commands !== "object") return commands;
  const data = commands as Record<string, unknown>;
  const commandRows = Array.isArray(data.commands) ? data.commands : null;
  const customRows = Array.isArray(data.custom_commands)
    ? data.custom_commands
    : null;
  const [rows, custom_commands] = await Promise.all([
    commandRows
      ? Promise.all(commandRows.map(withCommandOverlays))
      : Promise.resolve(undefined),
    customRows
      ? Promise.all(customRows.map(withCommandOverlays))
      : Promise.resolve(undefined),
  ]);
  return {
    ...data,
    ...(rows ? { commands: rows } : {}),
    ...(custom_commands ? { custom_commands } : {}),
  };
}

function collectKinds(value: unknown, out: string[]): void {
  if (Array.isArray(value)) {
    for (const item of value) collectKinds(item, out);
    return;
  }
  if (!value || typeof value !== "object") return;
  const data = value as Record<string, unknown>;
  if (typeof data.kind === "string") out.push(data.kind);
  for (const child of Object.values(data)) {
    if (child && typeof child === "object") collectKinds(child, out);
  }
}

async function workflows(): Promise<RawWorkflow[]> {
  const files = await fg("dist/shared/xblox/**/*.xblox", {
    cwd: repoRoot,
    absolute: true,
    onlyFiles: true,
  });
  const out: RawWorkflow[] = [];
  const seen = new Set<string>();
  for (const file of files) {
    try {
      const id = path.basename(file, ".xblox");
      if (seen.has(id)) continue;
      const doc = JSON.parse(await fs.readFile(file, "utf8")) as {
        description?: string;
        roots?: unknown[];
      };
      const kinds: string[] = [];
      collectKinds(doc.roots ?? [], kinds);
      if (kinds.length < 2) continue;
      seen.add(id);
      const relative = path.relative(repoRoot, file).replaceAll("\\", "/");
      out.push({
        id,
        label: doc.description || id,
        source: relative,
        kinds,
      });
    } catch {
      // A malformed example must not invalidate runtime introspection.
    }
  }
  return out;
}

async function documents(): Promise<RawCapabilityDocument[]> {
  const files = await fg("releases/web-docs/features/feature-*.md", {
    cwd: repoRoot,
    absolute: true,
    onlyFiles: true,
  });
  const out: RawCapabilityDocument[] = [];
  for (const file of files) {
    const relative = path.relative(repoRoot, file).replaceAll("\\", "/");
    const raw = await fs.readFile(file, "utf8");
    const doc = featureDocument(relative, raw);
    if (doc) out.push(doc);
  }
  return out;
}

export interface CompileResult {
  outputPath: string;
  snapshot: ProductCapabilitySnapshot;
}

export async function compileCapabilities(): Promise<CompileResult> {
  const rawDir = capabilityRawDir;
  const commandsPath =
    process.env.PHRASES_COMMANDS_JSON ||
    path.join(rawDir, "commands.raw.json");
  const xbloxPath =
    process.env.PHRASES_XBLOX_JSON || path.join(rawDir, "xblox.raw.json");
  const appCommandsPath = path.join(rawDir, "app-commands.raw.json");
  const uiPath = path.join(rawDir, "ui.raw.json");
  const outputPath = capabilitySnapshotPath();
  const snapshot = compileCapabilitySnapshot({
    commands: await withCliOverlays(await jsonFile(commandsPath)),
    xblox: await jsonFile(xbloxPath),
    appCommands: await jsonFile(appCommandsPath),
    ui: await jsonFile(uiPath),
    documents: await documents(),
    workflows: await workflows(),
  });
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
  return { outputPath, snapshot };
}

export interface RefreshResult {
  captured?: CaptureResult;
  compiled?: CompileResult;
}

export async function refreshCapabilities(
  stage: "capture" | "compile" | "refresh" = "refresh"
): Promise<RefreshResult> {
  if (stage === "compile") {
    return { compiled: await compileCapabilities() };
  }
  const captured = await captureCapabilities();
  if (stage === "capture") {
    try {
      return {
        captured,
        compiled: {
          outputPath: capabilitySnapshotPath(),
          snapshot: await loadCapabilitySnapshot(),
        },
      };
    } catch {
      return { captured };
    }
  }
  return { captured, compiled: await compileCapabilities() };
}
