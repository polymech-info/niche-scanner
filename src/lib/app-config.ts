import { randomBytes } from "node:crypto";
import fs from "fs/promises";
import path from "path";
import {
  EMPTY_SETTINGS,
  normalizeBlacklistWord,
  parseSettings,
  type AppSettings,
} from "../shared/config.js";
import {
  isCustomCapabilityId,
  parseCapabilityOverlay,
  parseCapabilityTextOverride,
  parseCustomCapability,
  type CapabilityOverlay,
  type CapabilityTextOverride,
} from "../shared/capability-overlay.js";
import { resolvedDataRoot } from "./env.js";

export function defaultConfigPath(): string {
  return path.join(resolvedDataRoot(), "config.json");
}

export function configPath(): string {
  return process.env.PHRASES_CONFIG || defaultConfigPath();
}

async function ensureParent(file: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
}

function parseConfigJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const match = /position (\d+)/i.exec(message);
    if (!match) throw err;
    return JSON.parse(raw.slice(0, Number(match[1])).trimEnd());
  }
}

let writeQueue: Promise<unknown> = Promise.resolve();

function withAppConfig(
  fn: (current: AppSettings) => AppSettings | Promise<AppSettings>
): Promise<AppSettings> {
  const run = writeQueue.then(async () => {
    const current = await loadAppConfig();
    const next = parseSettings(await fn(current));
    await writeAppConfigFile(next);
    return next;
  });
  writeQueue = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

async function writeAppConfigFile(settings: AppSettings): Promise<void> {
  const file = configPath();
  await ensureParent(file);
  const tmp = `${file}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
  await fs.rename(tmp, file);
}

export async function loadAppConfig(): Promise<AppSettings> {
  const file = configPath();
  try {
    const raw = await fs.readFile(file, "utf8");
    return parseSettings(parseConfigJson(raw));
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { ...EMPTY_SETTINGS };
    throw err;
  }
}

export async function saveAppConfig(next: AppSettings): Promise<AppSettings> {
  return withAppConfig((current) => {
    const settings = parseSettings(next);
    if (next.capabilities === undefined) {
      settings.capabilities = current.capabilities;
    }
    return settings;
  });
}

export async function addBlacklistWord(raw: string): Promise<AppSettings> {
  const word = normalizeBlacklistWord(raw);
  if (!word) throw new Error("Word is empty");
  const current = await loadAppConfig();
  if (current.blacklist.includes(word)) {
    throw new Error(`Already blacklisted: ${word}`);
  }
  return saveAppConfig({
    ...current,
    blacklist: [...current.blacklist, word],
  });
}

export async function updateBlacklistWord(
  fromRaw: string,
  toRaw: string
): Promise<AppSettings> {
  const from = normalizeBlacklistWord(fromRaw);
  const to = normalizeBlacklistWord(toRaw);
  if (!from) throw new Error("Current word is empty");
  if (!to) throw new Error("New word is empty");
  const current = await loadAppConfig();
  const index = current.blacklist.indexOf(from);
  if (index < 0) throw new Error(`Not on the blacklist: ${from}`);
  if (to !== from && current.blacklist.includes(to)) {
    throw new Error(`Already blacklisted: ${to}`);
  }
  const blacklist = [...current.blacklist];
  blacklist[index] = to;
  return saveAppConfig({ ...current, blacklist });
}

export async function removeBlacklistWord(raw: string): Promise<AppSettings> {
  const word = normalizeBlacklistWord(raw);
  if (!word) throw new Error("Word is empty");
  const current = await loadAppConfig();
  if (!current.blacklist.includes(word)) {
    throw new Error(`Not on the blacklist: ${word}`);
  }
  return saveAppConfig({
    ...current,
    blacklist: current.blacklist.filter((item) => item !== word),
  });
}

function overlayOf(settings: AppSettings): CapabilityOverlay {
  return parseCapabilityOverlay(settings.capabilities);
}

export async function saveCapabilityOverlay(
  overlay: CapabilityOverlay
): Promise<AppSettings> {
  return withAppConfig((current) => ({
    ...current,
    capabilities: parseCapabilityOverlay(overlay),
  }));
}

function applyDisabled(
  list: string[],
  ids: string[],
  enabled: boolean
): string[] {
  const drop = new Set(ids.map((id) => id.trim()).filter(Boolean));
  const next = list.filter((id) => !drop.has(id));
  if (enabled) return next;
  return [...next, ...drop];
}

export async function setCapabilityAvailability(input: {
  enabled: boolean;
  capabilityIds?: string[];
  workflowIds?: string[];
}): Promise<AppSettings> {
  const capabilityIds = (input.capabilityIds ?? []).map((id) => id.trim()).filter(Boolean);
  const workflowIds = (input.workflowIds ?? []).map((id) => id.trim()).filter(Boolean);
  if (!capabilityIds.length && !workflowIds.length) {
    throw new Error("Capability id is empty");
  }
  return withAppConfig((current) => {
    const overlay = overlayOf(current);
    return {
      ...current,
      capabilities: {
        ...overlay,
        disabled: applyDisabled(overlay.disabled, capabilityIds, input.enabled),
        disabledWorkflows: applyDisabled(
          overlay.disabledWorkflows,
          workflowIds,
          input.enabled
        ),
      },
    };
  });
}

export async function setCapabilityEnabled(
  id: string,
  enabled: boolean
): Promise<AppSettings> {
  return setCapabilityAvailability({ enabled, capabilityIds: [id] });
}

export async function setWorkflowEnabled(
  id: string,
  enabled: boolean
): Promise<AppSettings> {
  return setCapabilityAvailability({ enabled, workflowIds: [id] });
}

export async function upsertCustomCapability(
  raw: unknown
): Promise<AppSettings> {
  return withAppConfig((current) => {
    const overlay = overlayOf(current);
    const incomingId = String((raw as { id?: unknown } | null)?.id ?? "").trim();
    const existing = incomingId
      ? overlay.custom.find((row) => row.id === incomingId)
      : undefined;
    const taken = new Set(
      overlay.custom.filter((row) => row.id !== incomingId).map((row) => row.id)
    );
    const parsed = parseCustomCapability(
      existing ? { ...existing, ...(raw as object) } : raw,
      taken
    );
    if (!parsed) throw new Error("Custom capability needs a label");
    const custom = existing
      ? overlay.custom.map((row) => (row.id === existing.id ? parsed : row))
      : [...overlay.custom, parsed];
    return {
      ...current,
      capabilities: { ...overlay, custom },
    };
  });
}

export async function upsertCapabilityOverride(
  id: string,
  raw: unknown
): Promise<AppSettings> {
  const trimmed = id.trim();
  if (!trimmed) throw new Error("Capability id is empty");
  if (isCustomCapabilityId(trimmed)) {
    throw new Error("Edit custom capabilities from the custom form");
  }
  const patch = parseCapabilityTextOverride(raw);
  if (!patch) throw new Error("Override needs description or terms");
  return withAppConfig((current) => {
    const overlay = overlayOf(current);
    const previous = overlay.overrides?.[trimmed] ?? {};
    const merged: CapabilityTextOverride = { ...previous };
    if ("description" in patch) merged.description = patch.description;
    if ("terms" in patch) merged.terms = patch.terms;
    return {
      ...current,
      capabilities: {
        ...overlay,
        overrides: { ...overlay.overrides, [trimmed]: merged },
      },
    };
  });
}

export async function removeCapabilityOverride(
  id: string
): Promise<AppSettings> {
  const trimmed = id.trim();
  if (!trimmed) throw new Error("Capability id is empty");
  return withAppConfig((current) => {
    const overlay = overlayOf(current);
    if (!overlay.overrides || !(trimmed in overlay.overrides)) return current;
    const overrides = { ...overlay.overrides };
    delete overrides[trimmed];
    return {
      ...current,
      capabilities: { ...overlay, overrides },
    };
  });
}

export async function removeCustomCapability(id: string): Promise<AppSettings> {
  const trimmed = id.trim();
  if (!trimmed || !isCustomCapabilityId(trimmed)) {
    throw new Error("Not a custom capability");
  }
  return withAppConfig((current) => {
    const overlay = overlayOf(current);
    if (!overlay.custom.some((row) => row.id === trimmed)) {
      throw new Error(`No custom capability ${trimmed}`);
    }
    return {
      ...current,
      capabilities: {
        ...overlay,
        custom: overlay.custom.filter((row) => row.id !== trimmed),
        disabled: overlay.disabled.filter((item) => item !== trimmed),
      },
    };
  });
}

