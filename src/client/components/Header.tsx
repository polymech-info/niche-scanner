import React from "react";
import { Moon, Sun } from "lucide-react";
import { useConfig } from "../lib/query";
import { useStore } from "../store/app";

export function Header() {
  const theme = useStore((s) => s.theme);
  const toggle = useStore((s) => s.toggleTheme);
  const config = useConfig().data;
  const running = useStore((s) => s.running);

  return (
    <header
      className="h-[52px] flex items-center justify-between px-4 shrink-0"
      style={{
        background: "var(--color-surface)",
        borderBottom: "1px solid var(--color-border)",
      }}
    >
      <div className="flex items-baseline gap-3 min-w-0">
        <span className="wordmark">phrases</span>
        <span
          className="text-xs truncate"
          style={{ color: "var(--color-muted)" }}
          title={config?.logDir ? `Logs: ${config.logDir}` : undefined}
        >
          exact-match research
        </span>
        {running && (
          <span className="text-xs font-medium" style={{ color: "var(--color-accent)" }}>
            working
          </span>
        )}
      </div>
      <div className="flex items-center gap-1.5">
        {config && (
          <span
            className="text-[11px] px-2 h-6 inline-flex items-center font-medium"
            style={{
              background: "var(--color-panel)",
              border: "1px solid var(--color-border)",
              borderRadius: "var(--radius)",
              color: config.hasSerpapiKey
                ? "var(--color-text-secondary)"
                : "var(--color-danger)",
            }}
          >
            {config.hasSerpapiKey ? "SerpAPI" : "no API key"}
          </span>
        )}
        <button
          type="button"
          onClick={toggle}
          className="btn btn-quiet h-8 w-8 p-0"
          title={`Switch to ${theme === "dark" ? "light" : "dark"} mode`}
        >
          {theme === "dark" ? <Sun size={15} /> : <Moon size={15} />}
        </button>
      </div>
    </header>
  );
}
