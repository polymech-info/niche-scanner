import React from "react";
import { X } from "lucide-react";
import { Header } from "./components/Header";
import { Sidebar } from "./components/Sidebar";
import { useTheme } from "./hooks/useTheme";
import { useConfig, useSearches, useSettings } from "./lib/query";
import { useStore } from "./store/app";

export function AppShell({ children }: { children: React.ReactNode }) {
  useTheme();
  useSettings();
  const configQuery = useConfig();
  const searchesQuery = useSearches();
  const error = useStore((s) => s.error);
  const setError = useStore((s) => s.setError);
  const loadError =
    configQuery.error ?? searchesQuery.error
      ? (configQuery.error ?? searchesQuery.error)?.message ?? "Cannot reach API"
      : null;
  const loading = configQuery.isPending || searchesQuery.isPending;

  return (
    <div className="h-[100dvh] flex flex-col overflow-hidden">
      <Header />
      {(error || loadError) && (
        <div
          className="px-4 py-2 text-sm shrink-0 flex items-center justify-between gap-3"
          style={{
            background: "rgba(220,38,38,0.1)",
            color: "var(--color-danger)",
            borderBottom: "1px solid var(--color-border)",
          }}
        >
          <span className="min-w-0 truncate">{error || loadError}</span>
          {error && (
            <button
              type="button"
              className="btn btn-quiet h-7 w-7 p-0 shrink-0"
              onClick={() => setError(null)}
              title="Dismiss"
            >
              <X size={14} />
            </button>
          )}
        </div>
      )}
      {loading && !configQuery.data && (
        <div
          className="px-4 py-2 text-sm shrink-0"
          style={{
            color: "var(--color-muted)",
            borderBottom: "1px solid var(--color-border)",
          }}
        >
          Connecting to API…
        </div>
      )}
      <div
        className="flex-1 flex overflow-hidden min-h-0"
        style={{ background: "var(--color-panel)" }}
      >
        <Sidebar
          emptyHint={loading ? "Loading…" : loadError ? "API offline" : undefined}
        />
        {children}
      </div>
    </div>
  );
}
