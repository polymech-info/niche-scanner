import React from "react";
import { ChevronDown, Package } from "lucide-react";
import { ScriptGroupBlock } from "./ScriptGroup";
import { ScriptRow } from "./ScriptRow";
import { useStore } from "../store/scripts";
import { fuzzyScore } from "../lib/fuzzy-search";
import { groupScripts, type ScriptTreeNode } from "../lib/group-scripts";
import type { PackageInfo } from "../lib/api";

interface PackageCardProps {
  pkg: PackageInfo;
}

export function PackageCard({ pkg }: PackageCardProps) {
  const searchQuery = useStore((s) => s.searchQuery);
  const isCollapsed = useStore((s) => s.sidebarCollapsed.get(pkg.name));
  const toggleCollapsed = useStore((s) => s.togglePackageCollapsed);
  const scriptStates = useStore((s) => s.scriptStates);
  const packageCount = useStore((s) => s.packages.length);

  const groupingEnabled = useStore((s) => s.groupingEnabled);
  const hiddenScripts = useStore((s) => s.hiddenScripts);
  // Single-package projects: flat list, no package-name chrome.
  const flat = packageCount <= 1;

  const scriptDescriptions = useStore((s) => s.scriptDescriptions);
  const scripts = Object.entries(pkg.scripts).filter(
    ([name]) => !hiddenScripts.includes(`${pkg.name}:${name}`)
  );
  const filteredScripts = searchQuery
    ? scripts
        .map(([name, command]) => ({
          entry: [name, command] as [string, string],
          score: fuzzyScore(
            searchQuery,
            name,
            command,
            scriptDescriptions[`${pkg.name}:${name}`]
          ),
        }))
        .filter((x) => x.score > 0)
        .sort((a, b) => b.score - a.score || a.entry[0].localeCompare(b.entry[0]))
        .map((x) => x.entry)
    : scripts;

  if (filteredScripts.length === 0) return null;

  const nodes: ScriptTreeNode[] = groupingEnabled
    ? groupScripts(filteredScripts)
    : filteredScripts.map(([name, command]) => ({
        path: name,
        label: name,
        script: [name, command] as [string, string],
        children: [],
      }));

  const runningCount = scripts.filter(([name]) => {
    const id = `${pkg.name}:${name}`;
    return scriptStates.get(id)?.status === "running";
  }).length;

  const searching = searchQuery.trim().length > 0;

  const scriptList = (
    <div className="pb-1" key={searching ? `search:${searchQuery}` : "browse"}>
      {nodes.map((node, i) => (
        <div key={node.path}>
          {i > 0 && (
            <div
              className="mx-3 my-1"
              style={{
                borderTop: "1px solid var(--color-border)",
                opacity: 0.5,
              }}
            />
          )}
          {groupingEnabled ? (
            <ScriptGroupBlock
              packageName={pkg.name}
              node={node}
              searchMode={searching}
            />
          ) : (
            node.script && (
              <ScriptRow
                packageName={pkg.name}
                scriptName={node.script[0]}
                command={node.script[1]}
              />
            )
          )}
        </div>
      ))}
    </div>
  );

  if (flat) {
    return (
      <div style={{ borderBottom: "1px solid var(--color-border)" }}>
        {scriptList}
      </div>
    );
  }

  return (
    <div style={{ borderBottom: "1px solid var(--color-border)" }}>
      <button
        onClick={() => toggleCollapsed(pkg.name)}
        className="w-full flex items-center gap-2 px-3 py-2 transition-colors"
        style={{ color: "var(--color-text)" }}
        onMouseEnter={(e) =>
          (e.currentTarget.style.background = "var(--color-hover)")
        }
        onMouseLeave={(e) =>
          (e.currentTarget.style.background = "transparent")
        }
      >
        <ChevronDown
          size={14}
          className={`transition-transform ${isCollapsed ? "-rotate-90" : ""}`}
          style={{ color: "var(--color-muted)" }}
        />
        <Package size={14} style={{ color: "var(--color-muted)" }} />
        <span className="text-sm font-medium flex-1 text-left truncate">
          {pkg.name}
        </span>
        {runningCount > 0 && (
          <span className="text-xs px-1.5 py-0.5 rounded-full bg-runny-green/20 text-runny-green">
            {runningCount}
          </span>
        )}
        <span className="text-xs" style={{ color: "var(--color-muted)" }}>
          {searching
            ? `${filteredScripts.length} match${filteredScripts.length === 1 ? "" : "es"}`
            : filteredScripts.length}
        </span>
      </button>
      {/* Search always reveals matches; tree groups stay collapsed inside. */}
      {(searching || !isCollapsed) && scriptList}
    </div>
  );
}
