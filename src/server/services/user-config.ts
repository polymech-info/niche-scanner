import fs from "fs";
import path from "path";

export const USER_CONFIG_FILENAME = "runny-config.json";

export interface FavouriteGroupConfig {
  id: string;
  name: string;
  scriptIds: string[];
  /** Scripts kept in the group but skipped on group run. */
  mutedScriptIds?: string[];
}

export interface UserConfig {
  version: 1;
  theme?: "light" | "dark";
  groupingEnabled?: boolean;
  sidebarWidth?: number;
  favouriteGroups?: FavouriteGroupConfig[];
  scriptDescriptions?: Record<string, string>;
  /** Expanded `package::prefix` script groups (colon grouping). Default: all collapsed. */
  expandedScriptGroups?: string[];
  /** Hidden script ids (`packageName:scriptName`) removed from the sidebar. */
  hiddenScripts?: string[];
}

const DEFAULT_CONFIG: UserConfig = {
  version: 1,
  groupingEnabled: true,
  sidebarWidth: 320,
  favouriteGroups: [{ id: "default", name: "Favourites", scriptIds: [] }],
  scriptDescriptions: {},
  expandedScriptGroups: [],
  hiddenScripts: [],
};

export function userConfigPath(targetDir: string): string {
  return path.join(targetDir, USER_CONFIG_FILENAME);
}

export function readUserConfig(targetDir: string): UserConfig {
  const filePath = userConfigPath(targetDir);
  if (!fs.existsSync(filePath)) {
    return structuredClone(DEFAULT_CONFIG);
  }
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, "utf-8")) as UserConfig;
    return normalizeUserConfig(raw);
  } catch {
    return structuredClone(DEFAULT_CONFIG);
  }
}

export function writeUserConfig(targetDir: string, config: UserConfig): UserConfig {
  const normalized = normalizeUserConfig(config);
  const filePath = userConfigPath(targetDir);
  fs.writeFileSync(filePath, `${JSON.stringify(normalized, null, 2)}\n`, "utf-8");
  return normalized;
}

function normalizeUserConfig(raw: Partial<UserConfig> | null | undefined): UserConfig {
  const groups = Array.isArray(raw?.favouriteGroups)
    ? raw!.favouriteGroups!
        .filter((g) => g && typeof g === "object")
        .map((g, i) => {
          const scriptIds = Array.isArray(g.scriptIds)
            ? g.scriptIds.filter((id): id is string => typeof id === "string")
            : [];
          const mutedScriptIds = Array.isArray(g.mutedScriptIds)
            ? g.mutedScriptIds.filter(
                (id): id is string =>
                  typeof id === "string" && scriptIds.includes(id)
              )
            : [];
          return {
            id: typeof g.id === "string" && g.id ? g.id : `g_${i}`,
            name: typeof g.name === "string" && g.name.trim() ? g.name : "Group",
            scriptIds,
            mutedScriptIds,
          };
        })
    : structuredClone(DEFAULT_CONFIG.favouriteGroups!);

  if (groups.length === 0) {
    groups.push({ id: "default", name: "Favourites", scriptIds: [] });
  }

  const descriptions =
    raw?.scriptDescriptions && typeof raw.scriptDescriptions === "object"
      ? Object.fromEntries(
          Object.entries(raw.scriptDescriptions).filter(
            ([k, v]) => typeof k === "string" && typeof v === "string"
          )
        )
      : {};

  const theme =
    raw?.theme === "light" || raw?.theme === "dark" ? raw.theme : undefined;

  const sidebarWidth =
    typeof raw?.sidebarWidth === "number" && Number.isFinite(raw.sidebarWidth)
      ? Math.min(640, Math.max(220, Math.round(raw.sidebarWidth)))
      : DEFAULT_CONFIG.sidebarWidth;

  const expandedScriptGroups = Array.isArray(raw?.expandedScriptGroups)
    ? raw!.expandedScriptGroups!.filter(
        (k): k is string => typeof k === "string" && k.length > 0
      )
    : [];

  const hiddenScripts = Array.isArray(raw?.hiddenScripts)
    ? raw!.hiddenScripts!.filter(
        (k): k is string => typeof k === "string" && k.length > 0
      )
    : [];

  return {
    version: 1,
    theme,
    groupingEnabled:
      typeof raw?.groupingEnabled === "boolean"
        ? raw.groupingEnabled
        : DEFAULT_CONFIG.groupingEnabled,
    sidebarWidth,
    favouriteGroups: groups,
    scriptDescriptions: descriptions,
    expandedScriptGroups,
    hiddenScripts,
  };
}
