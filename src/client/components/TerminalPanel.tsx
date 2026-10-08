import React, { useEffect, useRef, useState } from "react";
import { Terminal as XTerminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { ChevronLeft, ChevronRight, Terminal } from "lucide-react";
import { useLogStream } from "../hooks/useLogStream";
import { useStore } from "../store/scripts";
import { SessionStrip } from "./SessionStrip";
import {
  DEFAULT_STREAM_FILTERS,
  loadStreamFilters,
  saveStreamFilters,
  type TerminalStreamFilters,
} from "../lib/terminal-filters";
import "@xterm/xterm/css/xterm.css";

function runningScriptIds(
  scriptStates: Map<string, { status: string }>
): string[] {
  return [...scriptStates.entries()]
    .filter(([, s]) => s.status === "running")
    .map(([id]) => id)
    .sort((a, b) => a.localeCompare(b));
}

const DARK_THEME = {
  background: "#0f1117",
  foreground: "#e5e7eb",
  cursor: "#6366f1",
  selectionBackground: "#6366f140",
};

const LIGHT_THEME = {
  background: "#fafbfc",
  foreground: "#1a1d27",
  cursor: "#6366f1",
  selectionBackground: "#6366f140",
};

function StreamToggle({
  label,
  active,
  accent,
  onClick,
}: {
  label: string;
  active: boolean;
  accent: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded transition-colors"
      style={{
        background: active ? `${accent}22` : "transparent",
        color: active ? accent : "var(--color-muted)",
        border: `1px solid ${active ? `${accent}66` : "var(--color-border)"}`,
      }}
      title={active ? `Hide ${label}` : `Show ${label}`}
    >
      {label}
    </button>
  );
}

export function TerminalPanel() {
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<XTerminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  // State (not just ref) so useLogStream re-runs once xterm is ready.
  const [terminal, setTerminal] = useState<XTerminal | null>(null);
  const [streamFilters, setStreamFilters] = useState<TerminalStreamFilters>(
    () => loadStreamFilters()
  );
  const selectedScriptId = useStore((s) => s.selectedScriptId);
  const packages = useStore((s) => s.packages);
  const scriptStates = useStore((s) => s.scriptStates);
  const cycleRunningScript = useStore((s) => s.cycleRunningScript);
  const scriptState = useStore((s) =>
    s.selectedScriptId ? s.scriptStates.get(s.selectedScriptId) : undefined
  );
  const theme = useStore((s) => s.theme);
  const runningIds = runningScriptIds(scriptStates);
  const runningIndex = selectedScriptId
    ? runningIds.indexOf(selectedScriptId)
    : -1;

  const selectedLabel = (() => {
    if (!selectedScriptId) return null;
    if (packages.length <= 1) {
      const colon = selectedScriptId.lastIndexOf(":");
      return colon === -1 ? selectedScriptId : selectedScriptId.slice(colon + 1);
    }
    return selectedScriptId;
  })();

  const toggleStream = (key: keyof TerminalStreamFilters) => {
    setStreamFilters((prev) => {
      const next = { ...prev, [key]: !prev[key] };
      // Keep at least one stream visible.
      if (!next.stdout && !next.stderr) {
        return prev;
      }
      saveStreamFilters(next);
      return next;
    });
  };

  // Alt+← / Alt+→ cycle running tasks (skip when typing in an input).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.altKey || (e.key !== "ArrowLeft" && e.key !== "ArrowRight")) return;
      const t = e.target as HTMLElement | null;
      if (
        t &&
        (t.tagName === "INPUT" ||
          t.tagName === "TEXTAREA" ||
          t.isContentEditable)
      ) {
        return;
      }
      if (runningScriptIds(useStore.getState().scriptStates).length === 0) {
        return;
      }
      e.preventDefault();
      cycleRunningScript(e.key === "ArrowRight" ? 1 : -1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [cycleRunningScript]);

  // Initialize xterm
  useEffect(() => {
    if (!containerRef.current) return;

    const term = new XTerminal({
      theme: theme === "dark" ? DARK_THEME : LIGHT_THEME,
      fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', monospace",
      fontSize: 13,
      lineHeight: 1.4,
      cursorBlink: false,
      disableStdin: true,
      convertEol: true,
      scrollback: 5000,
    });

    const fitAddon = new FitAddon();
    const webLinksAddon = new WebLinksAddon();
    term.loadAddon(fitAddon);
    term.loadAddon(webLinksAddon);
    term.open(containerRef.current);
    fitAddon.fit();

    terminalRef.current = term;
    fitAddonRef.current = fitAddon;
    setTerminal(term);

    const resizeObserver = new ResizeObserver(() => {
      fitAddon.fit();
    });
    resizeObserver.observe(containerRef.current);

    return () => {
      resizeObserver.disconnect();
      term.dispose();
      terminalRef.current = null;
      setTerminal(null);
    };
  }, []);

  // Update xterm theme when app theme changes
  useEffect(() => {
    if (terminalRef.current) {
      terminalRef.current.options.theme =
        theme === "dark" ? DARK_THEME : LIGHT_THEME;
    }
  }, [theme]);

  useLogStream(terminal, streamFilters);

  const status = scriptState?.status;

  return (
    <div className="flex-1 flex flex-col overflow-hidden" style={{ background: "var(--color-bg)" }}>
      <SessionStrip />
      {/* Terminal header */}
      <div
        className="h-10 flex items-center px-4 gap-2 shrink-0"
        style={{
          background: "var(--color-surface)",
          borderBottom: "1px solid var(--color-border)",
        }}
      >
        <Terminal size={14} style={{ color: "var(--color-muted)" }} />
        {selectedScriptId ? (
          <>
            <span className="text-sm truncate min-w-0" style={{ color: "var(--color-text)" }}>
              {selectedLabel}
            </span>
            {status && (
              <span
                className={`text-xs px-1.5 py-0.5 rounded shrink-0 ${
                  status === "running"
                    ? "bg-runny-green/20 text-runny-green"
                    : status === "errored"
                      ? "bg-runny-red/20 text-runny-red"
                      : ""
                }`}
                style={
                  status !== "running" && status !== "errored"
                    ? { background: "var(--color-border)", color: "var(--color-muted)" }
                    : undefined
                }
              >
                {status}
                {scriptState?.exitCode !== null && status !== "running"
                  ? ` (${scriptState?.exitCode})`
                  : ""}
              </span>
            )}
          </>
        ) : (
          <span className="text-sm" style={{ color: "var(--color-muted)" }}>
            Select a script to view output
          </span>
        )}

        <div className="ml-auto flex items-center gap-1.5 shrink-0">
          {runningIds.length > 0 && (
            <div
              className="flex items-center gap-0.5 mr-1"
              title="Cycle running tasks (Alt+← / Alt+→)"
            >
              <button
                type="button"
                className="p-0.5 rounded hover:opacity-80"
                style={{ color: "var(--color-muted)" }}
                onClick={() => cycleRunningScript(-1)}
                aria-label="Previous running task"
              >
                <ChevronLeft size={14} />
              </button>
              <span
                className="text-[10px] tabular-nums min-w-[2.5rem] text-center"
                style={{ color: "var(--color-muted)" }}
              >
                {runningIndex >= 0 ? runningIndex + 1 : "–"}/{runningIds.length}
              </span>
              <button
                type="button"
                className="p-0.5 rounded hover:opacity-80"
                style={{ color: "var(--color-muted)" }}
                onClick={() => cycleRunningScript(1)}
                aria-label="Next running task"
              >
                <ChevronRight size={14} />
              </button>
            </div>
          )}
          <span className="text-[10px] uppercase tracking-wide" style={{ color: "var(--color-muted)" }}>
            Streams
          </span>
          <StreamToggle
            label="stdout"
            active={streamFilters.stdout}
            accent="#22c55e"
            onClick={() => toggleStream("stdout")}
          />
          <StreamToggle
            label="stderr"
            active={streamFilters.stderr}
            accent="#ef4444"
            onClick={() => toggleStream("stderr")}
          />
          {(!streamFilters.stdout || !streamFilters.stderr) && (
            <button
              type="button"
              className="text-[10px] px-1 py-0.5 rounded"
              style={{ color: "var(--color-muted)" }}
              title="Show all streams"
              onClick={() => {
                const next = { ...DEFAULT_STREAM_FILTERS };
                saveStreamFilters(next);
                setStreamFilters(next);
              }}
            >
              all
            </button>
          )}
        </div>
      </div>

      {/* Terminal body */}
      <div className="flex-1 relative">
        {!selectedScriptId && (
          <div
            className="absolute inset-0 flex items-center justify-center"
            style={{ color: "var(--color-muted)" }}
          >
            <div className="text-center">
              <Terminal size={48} className="mx-auto mb-3 opacity-20" />
              <p className="text-sm">Click a script to view its output</p>
            </div>
          </div>
        )}
        <div
          ref={containerRef}
          className={`absolute inset-0 p-2 ${!selectedScriptId ? "opacity-0" : ""}`}
        />
      </div>
    </div>
  );
}
