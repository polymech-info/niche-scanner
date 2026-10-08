import fs from "node:fs/promises";
import path from "node:path";
import { packageRoot } from "./env.js";
import type { ProductCapabilitySnapshot } from "../shared/capabilities.js";
import {
  EMPTY_CAPABILITY_OVERLAY,
  activeCapabilitySnapshot,
  type CapabilityOverlay,
} from "../shared/capability-overlay.js";
import { loadAppConfig } from "./app-config.js";

export function capabilitySnapshotPath(override?: string): string {
  return (
    override?.trim() ||
    process.env.PHRASES_CAPABILITIES_JSON?.trim() ||
    path.join(packageRoot, "data", "product-capabilities.json")
  );
}

export async function loadRawCapabilitySnapshot(
  override?: string
): Promise<ProductCapabilitySnapshot> {
  const file = capabilitySnapshotPath(override);
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch {
    throw new Error(
      `Capability snapshot missing at ${file}. Run npm run capabilities:refresh.`
    );
  }
  const parsed = JSON.parse(raw) as ProductCapabilitySnapshot;
  if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.capabilities)) {
    throw new Error(
      `Capability snapshot ${file} has an unsupported schema. Refresh it.`
    );
  }
  return parsed;
}

export async function loadCapabilityOverlay(): Promise<CapabilityOverlay> {
  try {
    const settings = await loadAppConfig();
    return settings.capabilities ?? { ...EMPTY_CAPABILITY_OVERLAY };
  } catch {
    return { ...EMPTY_CAPABILITY_OVERLAY };
  }
}

export async function loadCapabilitySnapshot(
  override?: string
): Promise<ProductCapabilitySnapshot> {
  const [parsed, overlay] = await Promise.all([
    loadRawCapabilitySnapshot(override),
    loadCapabilityOverlay(),
  ]);
  return activeCapabilitySnapshot(parsed, overlay);
}
