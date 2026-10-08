import React, { useEffect, useState } from "react";
import { ChevronDown, ChevronRight, Play, Square } from "lucide-react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "./ui/collapsible";
import { ScriptRow } from "./ScriptRow";
import { useStore } from "../store/scripts";
import {
  scriptGroupKey,
  type ScriptTreeNode,
} from "../lib/group-scripts";
import {
  sessionStepScriptId,
  startGroupSession,
  stopSession,
  type Session,
} from "../lib/api";

interface ScriptGroupProps {
  packageName: string;
  node: ScriptTreeNode;
  depth?: number;
  /** When searching: keep trees collapsed; expand per-group on demand. */
  searchMode?: boolean;
}

export function ScriptGroupBlock({
  packageName,
  node,
  depth = 0,
  searchMode = false,
}: ScriptGroupProps) {
  // Leaf script — no nested children.
  if (node.children.length === 0 && node.script) {
    return (
      <div style={{ paddingLeft: depth > 0 ? depth * 12 : undefined }}>
        <ScriptRow
          packageName={packageName}
          scriptName={node.script[0]}
          command={node.script[1]}
          indent={depth > 0}
        />
      </div>
    );
  }

  // Group with children (and optional exact script at this path).
  const key = scriptGroupKey(packageName, node.path);
  const persistedOpen = useStore((s) => s.expandedScriptGroups.includes(key));
  const setScriptGroupExpanded = useStore((s) => s.setScriptGroupExpanded);
  const upsertSession = useStore((s) => s.upsertSession);
  const selectScript = useStore((s) => s.selectScript);
  const childCount = countScripts(node);
  const session = useStore((s) =>
    findGroupSession(s.sessions, packageName, node.path)
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Search: start collapsed; local expand only (don't fight persisted tree state).
  const [searchOpen, setSearchOpen] = useState(false);
  useEffect(() => {
    if (searchMode) setSearchOpen(false);
  }, [searchMode, key]);

  const open = searchMode ? searchOpen : persistedOpen;

  const isActive =
    session?.status === "running" || session?.status === "queued";
  const progress = session
    ? `${countDone(session)}/${session.steps.length}`
    : null;

  const handleRun = async (e: React.MouseEvent) => {
    e.stopPropagation();
    setBusy(true);
    setError(null);
    try {
      if (isActive && session) {
        const stopped = await stopSession(session.id);
        upsertSession(stopped);
      } else {
        const started = await startGroupSession(packageName, node.path);
        upsertSession(started);
        const id = sessionStepScriptId(started);
        if (id) selectScript(id);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const runControls = (
    <>
      {progress && (
        <span
          className="text-xs tabular-nums"
          style={{
            color:
              session?.status === "failed"
                ? "#ef4444"
                : session?.status === "passed"
                  ? "#22c55e"
                  : "var(--color-muted)",
          }}
          title={`Session ${session?.status}`}
        >
          {progress}
        </span>
      )}
      <button
        type="button"
        className="p-1 rounded opacity-60 hover:opacity-100 focus:opacity-100"
        style={{ color: isActive ? "#ef4444" : "var(--color-muted)" }}
        title={
          isActive
            ? "Stop group session"
            : `Run group sequentially (${childCount})`
        }
        disabled={busy}
        onClick={handleRun}
      >
        {isActive ? <Square size={13} /> : <Play size={13} />}
      </button>
    </>
  );

  return (
    <Collapsible
      open={open}
      onOpenChange={(nextOpen) => {
        if (searchMode) setSearchOpen(nextOpen);
        else setScriptGroupExpanded(key, nextOpen);
      }}
    >
      <div
        className="flex items-stretch"
        style={{ paddingLeft: depth > 0 ? depth * 12 : undefined }}
      >
        <CollapsibleTrigger asChild>
          <button
            className="shrink-0 px-1.5 flex items-center self-stretch"
            style={{ color: "var(--color-muted)" }}
            title={open ? "Collapse group" : "Expand group"}
            onClick={(e) => e.stopPropagation()}
          >
            {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          </button>
        </CollapsibleTrigger>
        <div className="flex-1 min-w-0">
          {node.script ? (
            <div className="flex items-start gap-1">
              <div className="flex-1 min-w-0">
                <ScriptRow
                  packageName={packageName}
                  scriptName={node.script[0]}
                  command={node.script[1]}
                />
              </div>
              <div className="flex items-center gap-1 pr-2 pt-1.5 shrink-0">
                {runControls}
              </div>
            </div>
          ) : (
            <div
              className="flex items-center gap-2 px-3 py-1.5 text-sm"
              style={{ color: "var(--color-text-secondary)" }}
            >
              <span className="flex-1 truncate font-medium">{node.label}</span>
              <span
                className="text-[10px] tabular-nums shrink-0"
                style={{ color: "var(--color-muted)" }}
                title={
                  searchMode
                    ? `${childCount} match${childCount === 1 ? "" : "es"}`
                    : `${childCount} scripts`
                }
              >
                {searchMode
                  ? `${childCount} match${childCount === 1 ? "" : "es"}`
                  : childCount}
              </span>
              {runControls}
            </div>
          )}
          {error && (
            <div className="px-3 pb-1 text-xs" style={{ color: "#ef4444" }}>
              {error}
            </div>
          )}
        </div>
      </div>

      <CollapsibleContent>
        {node.children.map((child) => (
          <ScriptGroupBlock
            key={child.path}
            packageName={packageName}
            node={child}
            depth={depth + 1}
            searchMode={searchMode}
          />
        ))}
      </CollapsibleContent>
    </Collapsible>
  );
}

function countScripts(node: ScriptTreeNode): number {
  let n = node.script ? 1 : 0;
  for (const child of node.children) n += countScripts(child);
  return n;
}

function findGroupSession(
  sessions: Map<string, Session>,
  packageName: string,
  groupPath: string
): Session | undefined {
  let best: Session | undefined;
  for (const s of sessions.values()) {
    if (s.packageName !== packageName || s.groupPath !== groupPath) continue;
    if (!best || s.startedAt > best.startedAt) best = s;
  }
  return best;
}

function countDone(session: Session): number {
  return session.steps.filter(
    (s) =>
      s.status === "passed" ||
      s.status === "failed" ||
      s.status === "skipped"
  ).length;
}
