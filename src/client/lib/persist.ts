import {
  buildUserConfigSnapshot,
  scheduleSaveUserConfig,
} from "./user-config";
import type { FavouriteGroup } from "../store/scripts";

/** Snapshot fields that live in the scripts store (theme included). */
export function persistUserSettings(input: {
  theme: "light" | "dark";
  groupingEnabled: boolean;
  sidebarWidth: number;
  favouriteGroups: FavouriteGroup[];
  scriptDescriptions: Record<string, string>;
  expandedScriptGroups: string[];
  hiddenScripts: string[];
  ready: boolean;
}) {
  if (!input.ready) return;
  scheduleSaveUserConfig(
    buildUserConfigSnapshot({
      theme: input.theme,
      groupingEnabled: input.groupingEnabled,
      sidebarWidth: input.sidebarWidth,
      favouriteGroups: input.favouriteGroups,
      scriptDescriptions: input.scriptDescriptions,
      expandedScriptGroups: input.expandedScriptGroups,
      hiddenScripts: input.hiddenScripts,
    })
  );
}
