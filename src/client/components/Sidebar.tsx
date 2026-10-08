import React, { useCallback, useMemo, useRef } from "react";
import { Home, Plus } from "lucide-react";
import { Link, useParams, useRouterState } from "@tanstack/react-router";
import { useSearches } from "../lib/query";
import { useStore } from "../store/app";

const MIN_WIDTH = 220;
const MAX_WIDTH = 480;

function formatWhen(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const delta = Date.now() - then;
  const mins = Math.round(delta / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.round(hours / 24);
  return `${days}d`;
}

export function Sidebar({ emptyHint }: { emptyHint?: string }) {
  const searches = useSearches().data ?? [];
  const { searchId: activeId } = useParams({ strict: false });
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const query = useStore((s) => s.query);
  const setQuery = useStore((s) => s.setQuery);
  const width = useStore((s) => s.sidebarWidth);
  const setSidebarWidth = useStore((s) => s.setSidebarWidth);

  const dragging = useRef(false);
  const startX = useRef(0);
  const startWidth = useRef(width);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return searches;
    return searches.filter(
      (s) =>
        s.name.toLowerCase().includes(q) ||
        s.seeds.some((seed) => seed.toLowerCase().includes(q))
    );
  }, [query, searches]);

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault();
      dragging.current = true;
      startX.current = e.clientX;
      startWidth.current = width;
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
    },
    [width]
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (!dragging.current) return;
      setSidebarWidth(
        Math.min(
          MAX_WIDTH,
          Math.max(MIN_WIDTH, startWidth.current + (e.clientX - startX.current))
        )
      );
    },
    [setSidebarWidth]
  );

  const endDrag = useCallback((e: React.PointerEvent) => {
    if (!dragging.current) return;
    dragging.current = false;
    try {
      (e.target as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {
      // ignore
    }
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
  }, []);

  return (
    <aside
      className="relative flex flex-col shrink-0 overflow-hidden"
      style={{
        width,
        background: "var(--color-surface)",
        borderRight: "1px solid var(--color-border)",
      }}
    >
      <nav className="px-3 pt-3.5 pb-2 grid gap-1">
        <span className="text-[11px] font-medium" style={{ color: "var(--color-muted)" }}>
          Workflows
        </span>
        <Link
          to="/"
          search={{ run: undefined }}
          className="text-left px-2 py-1.5 text-sm no-underline rounded-sm"
          style={{
            color: "var(--color-text)",
            background: pathname === "/" ? "var(--color-accent-soft)" : "transparent",
          }}
        >
          Opportunity
        </Link>
        <Link
          to="/plan"
          className="text-left px-2 py-1.5 text-sm no-underline rounded-sm"
          style={{
            color: "var(--color-text)",
            background: pathname === "/plan" ? "var(--color-accent-soft)" : "transparent",
          }}
        >
          Product plan
        </Link>
        <Link
          to="/capabilities"
          className="text-left px-2 py-1.5 text-sm no-underline rounded-sm"
          style={{
            color: "var(--color-text)",
            background:
              pathname === "/capabilities" ? "var(--color-accent-soft)" : "transparent",
          }}
        >
          Capabilities
        </Link>
      </nav>
      <div className="px-3 pt-2 pb-2 flex items-center justify-between gap-2">
        <span className="text-[11px] font-medium" style={{ color: "var(--color-muted)" }}>
          Searches
        </span>
        <div className="flex items-center gap-1">
          <Link
            to="/"
            search={{ run: undefined }}
            className="btn btn-ghost h-7 w-7 p-0"
            title="Home"
          >
            <Home size={12} />
          </Link>
          <Link to="/searches/new" className="btn btn-ghost h-7 px-2 text-xs">
            <Plus size={12} />
            New
          </Link>
        </div>
      </div>
      <div className="px-3 pb-2">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Filter searches"
          className="field"
        />
      </div>
      <div className="flex-1 overflow-y-auto">
        {filtered.length === 0 ? (
          <div
            className="px-3 py-8 text-center text-sm"
            style={{ color: "var(--color-muted)" }}
          >
            {emptyHint ?? "No searches yet"}
          </div>
        ) : (
          filtered.map((search) => {
            const selected = search.id === activeId;
            return (
              <Link
                key={search.id}
                to="/searches/$searchId"
                params={{ searchId: search.id }}
                className="w-full text-left px-3 py-2.5 transition-colors block no-underline"
                style={{
                  color: "var(--color-text)",
                  background: selected ? "var(--color-accent-soft)" : "transparent",
                  boxShadow: selected
                    ? "inset 3px 0 0 var(--color-accent)"
                    : "inset 3px 0 0 transparent",
                }}
              >
                <div className="flex items-start justify-between gap-2">
                  <span className="text-sm font-medium truncate tracking-tight">
                    {search.name}
                  </span>
                  <span
                    className="text-[11px] shrink-0 font-mono"
                    style={{ color: "var(--color-muted)" }}
                  >
                    {formatWhen(search.updatedAt)}
                  </span>
                </div>
                <div className="text-xs mt-0.5" style={{ color: "var(--color-muted)" }}>
                  {search.phraseCount} phrase{search.phraseCount === 1 ? "" : "s"}
                  {search.parentId ? " / linked" : ""}
                  {search.seeds[0] ? ` / ${search.seeds[0]}` : ""}
                </div>
              </Link>
            );
          })
        )}
      </div>
      <div
        className="px-3 py-2 text-xs"
        style={{
          borderTop: "1px solid var(--color-border)",
          color: "var(--color-muted)",
        }}
      >
        {searches.length} saved
      </div>
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize sidebar"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        className="absolute top-0 right-0 h-full w-1.5 cursor-col-resize z-10 group"
        style={{ touchAction: "none" }}
      >
        <div
          className="absolute inset-y-0 right-0 w-px"
          style={{ background: "var(--color-border)" }}
        />
      </div>
    </aside>
  );
}
