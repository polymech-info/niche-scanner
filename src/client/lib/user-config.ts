import type { FavouriteGroup } from "../store/scripts";

export interface UserConfig {
  version: 1;
  theme?: "light" | "dark";
  groupingEnabled?: boolean;
  sidebarWidth?: number;
  favouriteGroups?: FavouriteGroup[];
  scriptDescriptions?: Record<string, string>;
  expandedScriptGroups?: string[];
  hiddenScripts?: string[];
}

const LEGACY_KEYS = [
  "runny-favourite-groups",
  "runny-favourites",
  "runny-script-descriptions",
  "runny-grouping",
  "runny-sidebar-width",
  "runny-theme",
] as const;

export async function fetchUserConfig(): Promise<UserConfig> {
  const res = await fetch("/api/user-config");
  if (!res.ok) throw new Error(`/api/user-config → ${res.status}`);
  return res.json();
}

export async function saveUserConfig(config: UserConfig): Promise<UserConfig> {
  const res = await fetch("/api/user-config", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(config),
  });
  if (!res.ok) throw new Error(`/api/user-config → ${res.status}`);
  return res.json();
}

/** One-time migrate from browser localStorage into the file-backed config. */
export function migrateLocalStorageUserConfig(
  fileConfig: UserConfig
): UserConfig | null {
  if (typeof window === "undefined") return null;

  const hasFileFavs =
    Array.isArray(fileConfig.favouriteGroups) &&
    fileConfig.favouriteGroups.some((g) => g.scriptIds.length > 0);
  const hasFileDesc =
    fileConfig.scriptDescriptions &&
    Object.keys(fileConfig.scriptDescriptions).length > 0;

  let changed = false;
  const next: UserConfig = {
    version: 1,
    theme: fileConfig.theme,
    groupingEnabled: fileConfig.groupingEnabled ?? true,
    sidebarWidth: fileConfig.sidebarWidth ?? 320,
    favouriteGroups: fileConfig.favouriteGroups ?? [
      { id: "default", name: "Favourites", scriptIds: [] },
    ],
    scriptDescriptions: { ...(fileConfig.scriptDescriptions ?? {}) },
    expandedScriptGroups: [...(fileConfig.expandedScriptGroups ?? [])],
    hiddenScripts: [...(fileConfig.hiddenScripts ?? [])],
  };

  if (!hasFileFavs) {
    try {
      const groupsRaw = localStorage.getItem("runny-favourite-groups");
      if (groupsRaw) {
        const groups = JSON.parse(groupsRaw) as FavouriteGroup[];
        if (Array.isArray(groups) && groups.length > 0) {
          next.favouriteGroups = groups;
          changed = true;
        }
      } else {
        const legacy = localStorage.getItem("runny-favourites");
        if (legacy) {
          const ids = JSON.parse(legacy) as string[];
          if (Array.isArray(ids) && ids.length > 0) {
            next.favouriteGroups = [
              { id: "default", name: "Favourites", scriptIds: ids },
            ];
            changed = true;
          }
        }
      }
    } catch {
      // ignore
    }
  }

  if (!hasFileDesc) {
    try {
      const descRaw = localStorage.getItem("runny-script-descriptions");
      if (descRaw) {
        const desc = JSON.parse(descRaw) as Record<string, string>;
        if (desc && typeof desc === "object" && Object.keys(desc).length) {
          next.scriptDescriptions = desc;
          changed = true;
        }
      }
    } catch {
      // ignore
    }
  }

  if (fileConfig.theme == null) {
    const theme = localStorage.getItem("runny-theme");
    if (theme === "light" || theme === "dark") {
      next.theme = theme;
      changed = true;
    }
  }

  if (fileConfig.groupingEnabled == null) {
    const grouping = localStorage.getItem("runny-grouping");
    if (grouping === "true" || grouping === "false") {
      next.groupingEnabled = grouping === "true";
      changed = true;
    }
  }

  if (fileConfig.sidebarWidth == null) {
    const width = Number(localStorage.getItem("runny-sidebar-width"));
    if (Number.isFinite(width) && width > 0) {
      next.sidebarWidth = width;
      changed = true;
    }
  }

  if (!changed) return null;

  for (const key of LEGACY_KEYS) {
    localStorage.removeItem(key);
  }
  return next;
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;
let pending: UserConfig | null = null;

export function scheduleSaveUserConfig(config: UserConfig) {
  pending = config;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const payload = pending;
    pending = null;
    saveTimer = null;
    if (!payload) return;
    void saveUserConfig(payload).catch((err) => {
      console.error("Failed to save runny-config.json", err);
    });
  }, 250);
}

export function buildUserConfigSnapshot(input: {
  theme: "light" | "dark";
  groupingEnabled: boolean;
  sidebarWidth: number;
  favouriteGroups: FavouriteGroup[];
  scriptDescriptions: Record<string, string>;
  expandedScriptGroups: string[];
  hiddenScripts: string[];
}): UserConfig {
  return {
    version: 1,
    theme: input.theme,
    groupingEnabled: input.groupingEnabled,
    sidebarWidth: input.sidebarWidth,
    favouriteGroups: input.favouriteGroups,
    scriptDescriptions: input.scriptDescriptions,
    expandedScriptGroups: input.expandedScriptGroups,
    hiddenScripts: input.hiddenScripts,
  };
}
