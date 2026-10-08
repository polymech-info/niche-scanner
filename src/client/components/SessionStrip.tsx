import React from "react";
import { Square } from "lucide-react";
import { useStore } from "../store/scripts";
import { stopSession, type Session } from "../lib/api";

export function SessionStrip() {
  const sessions = useStore((s) => s.sessions);
  const favouriteGroups = useStore((s) => s.favouriteGroups);
  const upsertSession = useStore((s) => s.upsertSession);

  const session = Array.from(sessions.values())
    .filter((s) => s.status === "running" || s.status === "queued")
    .sort((a, b) => b.startedAt - a.startedAt)[0];

  if (!session) return null;
  const step = session.steps[session.currentIndex];
  const done = session.steps.filter(
    (s) =>
      s.status === "passed" ||
      s.status === "failed" ||
      s.status === "skipped"
  ).length;

  const favPrefix = "favourite:";
  const favGroup =
    session.groupPath.startsWith(favPrefix) &&
    favouriteGroups.find((g) => g.id === session.groupPath.slice(favPrefix.length));
  const label = favGroup ? `★ ${favGroup.name}` : session.groupPath;

  const handleStop = async () => {
    try {
      const stopped = await stopSession(session.id);
      upsertSession(stopped);
    } catch {
      // ignore
    }
  };

  return (
    <div
      className="px-3 py-1.5 text-xs flex items-center gap-3 shrink-0"
      style={{
        borderBottom: "1px solid var(--color-border)",
        background: "var(--color-surface)",
        color: "var(--color-text-secondary)",
      }}
    >
      <span
        className="font-medium shrink-0"
        style={{ color: statusColor(session) }}
      >
        Session
      </span>
      <span className="truncate">
        {label}
        {step ? ` · ${step.command}` : ""}
      </span>
      <span className="tabular-nums shrink-0" style={{ color: "var(--color-muted)" }}>
        {done}/{session.steps.length}
      </span>
      <span className="shrink-0 capitalize" style={{ color: statusColor(session) }}>
        {session.status}
      </span>
      {(session.status === "running" || session.status === "queued") && (
        <button
          type="button"
          className="ml-auto p-1 rounded"
          style={{ color: "#ef4444" }}
          title="Stop session"
          onClick={handleStop}
        >
          <Square size={12} />
        </button>
      )}
    </div>
  );
}

function statusColor(session: Session): string {
  if (session.status === "failed") return "#ef4444";
  if (session.status === "passed") return "#22c55e";
  if (session.status === "cancelled") return "var(--color-muted)";
  return "#6366f1";
}
