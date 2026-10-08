import { useEffect, useRef } from "react";
import type { Terminal } from "@xterm/xterm";
import { sessionStepScriptId, type Session } from "../lib/api";
import {
  lineVisible,
  type TerminalStreamFilters,
} from "../lib/terminal-filters";
import { wsManager } from "../lib/ws";
import { useStore } from "../store/scripts";

type LogLine = { stream: string; data: string };

function writeLine(terminal: Terminal, line: LogLine) {
  const prefix = line.stream === "stderr" ? "\x1b[31m" : "";
  const suffix = line.stream === "stderr" ? "\x1b[0m" : "";
  terminal.writeln(`${prefix}${line.data}${suffix}`);
}

function renderFiltered(
  terminal: Terminal,
  lines: LogLine[],
  filters: TerminalStreamFilters
) {
  terminal.clear();
  for (const line of lines) {
    if (lineVisible(line.stream, filters)) writeLine(terminal, line);
  }
}

export function useLogStream(
  terminal: Terminal | null,
  streamFilters: TerminalStreamFilters
) {
  const selectedScriptId = useStore((s) => s.selectedScriptId);
  const setScriptStatus = useStore((s) => s.setScriptStatus);
  const upsertSession = useStore((s) => s.upsertSession);
  const selectScript = useStore((s) => s.selectScript);
  const prevIdRef = useRef<string | null>(null);
  const bufferRef = useRef<LogLine[]>([]);
  const filtersRef = useRef(streamFilters);
  filtersRef.current = streamFilters;

  useEffect(() => {
    wsManager.connect();
    return () => wsManager.disconnect();
  }, []);

  // Handle all incoming WebSocket messages for status / session updates
  useEffect(() => {
    const cleanup = wsManager.onMessage((data: unknown) => {
      const msg = data as {
        type: string;
        id?: string;
        status?: string;
        exitCode?: number | null;
        session?: Session;
      };
      if (msg.type === "status" && msg.id) {
        setScriptStatus(
          msg.id,
          msg.status as "running" | "stopped" | "errored",
          msg.exitCode
        );
      }
      if (msg.type === "session" && msg.session) {
        upsertSession(msg.session);
        const id = sessionStepScriptId(msg.session);
        if (
          id &&
          (msg.session.status === "running" ||
            msg.session.status === "queued") &&
          useStore.getState().followActiveSession
        ) {
          // Follow the active step so the terminal shows its output.
          selectScript(id);
        }
      }
    });
    return () => {
      cleanup();
    };
  }, [setScriptStatus, upsertSession, selectScript]);

  // Re-paint when stream filters change (keep full buffer).
  useEffect(() => {
    if (!terminal || !selectedScriptId) return;
    renderFiltered(terminal, bufferRef.current, streamFilters);
  }, [streamFilters, terminal, selectedScriptId]);

  // Handle log subscription for the selected script
  useEffect(() => {
    if (!terminal) return;

    if (prevIdRef.current) {
      wsManager.unsubscribe();
    }

    if (!selectedScriptId) {
      prevIdRef.current = null;
      bufferRef.current = [];
      return;
    }

    terminal.clear();
    bufferRef.current = [];
    prevIdRef.current = selectedScriptId;
    wsManager.subscribe(selectedScriptId);

    const cleanup = wsManager.onMessage((data: unknown) => {
      const msg = data as {
        type: string;
        id?: string;
        stream?: string;
        data?: string;
        lines?: Array<{ stream: string; data: string }>;
      };

      if (msg.id !== selectedScriptId) return;

      if (msg.type === "history" && msg.lines) {
        bufferRef.current = msg.lines.map((l) => ({
          stream: l.stream || "stdout",
          data: l.data,
        }));
        renderFiltered(terminal, bufferRef.current, filtersRef.current);
      }

      if (msg.type === "log" && msg.data) {
        const line: LogLine = {
          stream: msg.stream || "stdout",
          data: msg.data,
        };
        bufferRef.current.push(line);
        if (lineVisible(line.stream, filtersRef.current)) {
          writeLine(terminal, line);
        }
      }
    });

    return () => {
      cleanup();
    };
  }, [selectedScriptId, terminal]);
}
