import {
  useEffect,
  useMemo,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { ChevronDown, ChevronRight } from "lucide-react";

export type CatalogItem = {
  id: string;
  label: string;
  enabled?: boolean;
  muted?: boolean;
  badge?: string;
  searchText?: string;
};

export type CatalogGroup = {
  id: string;
  label: string;
  enabled?: boolean;
  indeterminate?: boolean;
  muted?: boolean;
  badge?: string;
  count?: number;
  items: CatalogItem[];
  searchText?: string;
};

function matchesQuery(query: string, ...parts: Array<string | undefined>) {
  if (!query) return true;
  return parts.some((part) => (part || "").toLowerCase().includes(query));
}

function activate(event: KeyboardEvent, fn: () => void) {
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    fn();
  }
}

type TreeFold = {
  opened: Record<string, boolean>;
  remembered: Record<string, boolean>;
};

function treeFoldKey(treeId: string) {
  return `phrases.tree.fold.v2.${treeId}`;
}

function asFlagMap(value: unknown): Record<string, boolean> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: Record<string, boolean> = {};
  for (const [id, flag] of Object.entries(value as Record<string, unknown>)) {
    if (typeof flag === "boolean") out[id] = flag;
  }
  return out;
}

function readTreeFold(treeId: string): TreeFold {
  try {
    const raw = localStorage.getItem(treeFoldKey(treeId));
    if (!raw) return { opened: {}, remembered: {} };
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { opened: {}, remembered: {} };
    }
    const row = parsed as { opened?: unknown; remembered?: unknown };
    const opened = asFlagMap(row.opened);
    return {
      opened,
      remembered: "remembered" in row ? asFlagMap(row.remembered) : opened,
    };
  } catch {
    return { opened: {}, remembered: {} };
  }
}

function writeTreeFold(treeId: string, fold: TreeFold) {
  try {
    localStorage.setItem(treeFoldKey(treeId), JSON.stringify(fold));
  } catch {
    /* quota */
  }
}

function pruneFlags(
  flags: Record<string, boolean>,
  ids: Set<string>,
): Record<string, boolean> {
  const next: Record<string, boolean> = {};
  for (const [id, flag] of Object.entries(flags)) {
    if (ids.has(id)) next[id] = flag;
  }
  return next;
}

export function CatalogWorkbench({
  groups,
  selectedId,
  onSelect,
  onToggleItem,
  onToggleGroup,
  searchPlaceholder,
  emptySearch,
  emptyTree,
  toolbar,
  treeMeta,
  treeToolbar,
  treeId,
  detail,
}: {
  groups: CatalogGroup[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onToggleItem?: (id: string, enabled: boolean) => void;
  onToggleGroup?: (id: string, enabled: boolean) => void;
  searchPlaceholder: string;
  emptySearch: string;
  emptyTree?: string;
  toolbar?: ReactNode;
  treeMeta?: ReactNode;
  treeToolbar?: ReactNode;
  treeId: string;
  detail: ReactNode;
}) {
  const [query, setQuery] = useState("");
  const [fold, setFold] = useState<TreeFold>(() => readTreeFold(treeId));
  const needle = query.trim().toLowerCase();
  const opened = fold.opened;

  const visible = useMemo(() => {
    return groups
      .map((group) => {
        const groupHit = matchesQuery(needle, group.label, group.searchText, group.badge);
        const items = group.items.filter(
          (item) =>
            groupHit ||
            matchesQuery(needle, item.label, item.searchText, item.badge)
        );
        if (needle && !groupHit && items.length === 0) return null;
        return { group, items };
      })
      .filter(
        (row): row is { group: CatalogGroup; items: CatalogItem[] } =>
          Boolean(row)
      );
  }, [groups, needle]);

  useEffect(() => {
    writeTreeFold(treeId, fold);
  }, [fold, treeId]);

  useEffect(() => {
    if (!groups.length) return;
    const ids = new Set(groups.map((group) => group.id));
    setFold((current) => {
      const openedNext = pruneFlags(current.opened, ids);
      const rememberedNext = pruneFlags(current.remembered, ids);
      if (
        Object.keys(openedNext).length === Object.keys(current.opened).length &&
        Object.keys(rememberedNext).length === Object.keys(current.remembered).length
      ) {
        return current;
      }
      return { opened: openedNext, remembered: rememberedNext };
    });
  }, [groups]);

  const isOpen = (id: string) => {
    if (needle) return true;
    return opened[id] === true;
  };

  function setFlag(
    flags: Record<string, boolean>,
    id: string,
    open: boolean,
  ): Record<string, boolean> {
    const next = { ...flags };
    if (open) next[id] = true;
    else delete next[id];
    return next;
  }

  function setGroupOpen(id: string, open: boolean) {
    setFold((current) => ({
      opened: setFlag(current.opened, id, open),
      remembered: setFlag(current.remembered, id, open),
    }));
  }

  function expandAll() {
    const allClosed = groups.every((group) => opened[group.id] !== true);
    setFold((current) => {
      const rememberedOpens = groups.some(
        (group) => current.remembered[group.id] === true,
      );
      if (allClosed && rememberedOpens) {
        return {
          opened: { ...current.remembered },
          remembered: current.remembered,
        };
      }
      return {
        opened: Object.fromEntries(groups.map((group) => [group.id, true])),
        remembered: current.remembered,
      };
    });
  }

  function collapseAll() {
    setFold((current) => ({
      opened: {},
      remembered: current.remembered,
    }));
  }

  return (
    <div className="catalog-panel">
      {toolbar}
      <div className="catalog-workbench">
        <div className="catalog-tree">
          {treeMeta ? <div className="catalog-tree-head">{treeMeta}</div> : null}
          <input
            className="field catalog-tree-search"
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={searchPlaceholder}
            aria-label={searchPlaceholder}
          />
          <div className="catalog-tree-scroll">
            {visible.length === 0 ? (
              <div className="catalog-tree-empty">
                {groups.length === 0 ? emptyTree || emptySearch : emptySearch}
              </div>
            ) : (
              visible.map(({ group, items }) => {
                const open = isOpen(group.id);
                const showGroupCheck =
                  Boolean(onToggleGroup) && group.enabled !== undefined;
                return (
                  <div key={group.id}>
                    <div
                      role="button"
                      tabIndex={0}
                      className={`catalog-row${selectedId === group.id ? " is-active" : ""}${
                        group.muted ? " is-muted" : ""
                      }`}
                      onClick={() => onSelect(group.id)}
                      onKeyDown={(event) => activate(event, () => onSelect(group.id))}
                    >
                      <span className="catalog-row-main">
                        <span
                          className="catalog-caret"
                          onClick={(event) => {
                            event.stopPropagation();
                            if (!needle) {
                              setGroupOpen(group.id, !open);
                            }
                          }}
                        >
                          {open ? (
                            <ChevronDown size={14} aria-hidden />
                          ) : (
                            <ChevronRight size={14} aria-hidden />
                          )}
                        </span>
                        {showGroupCheck ? (
                          <span
                            className="catalog-check"
                            onClick={(event) => event.stopPropagation()}
                          >
                            <input
                              type="checkbox"
                              checked={group.enabled}
                              ref={(node) => {
                                if (node) {
                                  node.indeterminate = Boolean(group.indeterminate);
                                }
                              }}
                              onChange={(event) =>
                                onToggleGroup?.(group.id, event.target.checked)
                              }
                            />
                          </span>
                        ) : null}
                        <span className="catalog-row-label">{group.label}</span>
                      </span>
                      <span className="catalog-row-meta">
                        {group.badge ? <small>{group.badge}</small> : null}
                        <small>{group.count ?? items.length}</small>
                      </span>
                    </div>
                    {items.map((item) => {
                      const showItemCheck =
                        Boolean(onToggleItem) && item.enabled !== undefined;
                      return (
                        <div
                          key={item.id}
                          role="button"
                          tabIndex={0}
                          className={`catalog-row is-item${
                            open ? "" : " is-hidden"
                          }${selectedId === item.id ? " is-active" : ""}${
                            item.muted ? " is-muted" : ""
                          }`}
                          onClick={() => onSelect(item.id)}
                          onKeyDown={(event) =>
                            activate(event, () => onSelect(item.id))
                          }
                        >
                          <span className="catalog-row-main">
                            {showItemCheck ? (
                              <span className="catalog-leaf-gap" aria-hidden />
                            ) : (
                              <span className="catalog-leaf" aria-hidden />
                            )}
                            {showItemCheck ? (
                              <span
                                className="catalog-check"
                                onClick={(event) => event.stopPropagation()}
                              >
                                <input
                                  type="checkbox"
                                  checked={item.enabled}
                                  onChange={(event) =>
                                    onToggleItem?.(item.id, event.target.checked)
                                  }
                                />
                              </span>
                            ) : null}
                            <span className="catalog-row-label">{item.label}</span>
                          </span>
                          {item.badge ? (
                            <span className="catalog-row-meta">
                              <small>{item.badge}</small>
                            </span>
                          ) : null}
                        </div>
                      );
                    })}
                  </div>
                );
              })
            )}
          </div>
          {groups.length || treeToolbar ? (
            <div className="catalog-tree-actions">
              <div className="catalog-tree-fold">
                <button
                  type="button"
                  className="btn btn-quiet"
                  disabled={!groups.length}
                  onClick={expandAll}
                >
                  Expand all
                </button>
                <button
                  type="button"
                  className="btn btn-quiet"
                  disabled={!groups.length}
                  onClick={collapseAll}
                >
                  Collapse all
                </button>
              </div>
              {treeToolbar ? (
                <div className="catalog-tree-tools">{treeToolbar}</div>
              ) : null}
            </div>
          ) : null}
        </div>
        <div className="catalog-detail">{detail}</div>
      </div>
    </div>
  );
}

export function CatalogDetailHead({
  parent,
  name,
  children,
}: {
  parent?: string;
  name: string;
  children?: ReactNode;
}) {
  return (
    <div className="catalog-detail-head">
      <h2 className="catalog-detail-title">
        {parent ? (
          <>
            <span className="catalog-detail-parent">{parent}</span>
            <span className="catalog-detail-sep">/</span>
            <span>{name}</span>
          </>
        ) : (
          name
        )}
      </h2>
      {children ? <div className="catalog-detail-actions">{children}</div> : null}
    </div>
  );
}

export function CatalogFacts({
  rows,
}: {
  rows: Array<{ label: string; value: ReactNode } | null | undefined | false>;
}) {
  const shown = rows.filter(Boolean) as Array<{ label: string; value: ReactNode }>;
  if (!shown.length) return null;
  return (
    <div className="catalog-facts">
      {shown.map((row) => (
        <div className="catalog-fact" key={row.label}>
          <span>{row.label}</span>
          <div>{row.value}</div>
        </div>
      ))}
    </div>
  );
}

export function CatalogFound({
  label,
  count,
  empty,
  actions,
  children,
}: {
  label: string;
  count?: number;
  empty?: string;
  actions?: ReactNode;
  children?: ReactNode;
}) {
  const has = children != null && children !== false;
  return (
    <section className="catalog-found">
      <div className="catalog-found-label">
        {label}
        {typeof count === "number" ? <span>{count}</span> : null}
        {actions ? <div className="catalog-found-actions">{actions}</div> : null}
      </div>
      {has ? children : empty ? (
        <p className="catalog-empty">{empty}</p>
      ) : null}
    </section>
  );
}
