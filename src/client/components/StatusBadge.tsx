import React from "react";
import { Check, Minus, X } from "lucide-react";

export type DisplayStatus =
  | "idle"
  | "running"
  | "passed"
  | "failed"
  | "skipped";

interface StatusBadgeProps {
  status: DisplayStatus;
  /** Shown in the title tooltip when finished. */
  exitCode?: number | null;
}

export function StatusBadge({ status, exitCode }: StatusBadgeProps) {
  const title =
    exitCode != null && (status === "passed" || status === "failed")
      ? `${status} (exit ${exitCode})`
      : status;

  if (status === "idle") {
    return (
      <span
        className="inline-flex w-3.5 h-3.5 shrink-0 rounded-full border"
        style={{ borderColor: "var(--color-border)" }}
        title={title}
      />
    );
  }

  if (status === "running") {
    return (
      <span
        className="inline-block w-2.5 h-2.5 rounded-full shrink-0 bg-runny-green animate-pulse"
        title={title}
      />
    );
  }

  if (status === "passed") {
    return (
      <span
        className="inline-flex items-center justify-center w-3.5 h-3.5 shrink-0 rounded-full"
        style={{ background: "rgba(34,197,94,0.18)", color: "#22c55e" }}
        title={title}
      >
        <Check size={10} strokeWidth={3} />
      </span>
    );
  }

  if (status === "failed") {
    return (
      <span
        className="inline-flex items-center justify-center w-3.5 h-3.5 shrink-0 rounded-full"
        style={{ background: "rgba(239,68,68,0.18)", color: "#ef4444" }}
        title={title}
      >
        <X size={10} strokeWidth={3} />
      </span>
    );
  }

  // skipped
  return (
    <span
      className="inline-flex items-center justify-center w-3.5 h-3.5 shrink-0 rounded-full"
      style={{ background: "var(--color-border)", color: "var(--color-muted)" }}
      title={title}
    >
      <Minus size={10} strokeWidth={3} />
    </span>
  );
}
