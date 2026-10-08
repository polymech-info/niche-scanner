import { useMemo, useState, type KeyboardEvent, type ReactNode } from "react";
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
  detail: ReactNode;
}) {
  const [query, setQuery] = useState("");
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const needle = query.trim().toLowerCase();

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

  const isOpen = (id: string) => {
    if (needle) return true;
    return collapsed[id] !== true;
  };

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
                              setCollapsed((current) => ({
                                ...current,
                                [group.id]: open,
                              }));
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
          {treeToolbar ? (
            <div className="catalog-tree-tools">{treeToolbar}</div>
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
  children,
}: {
  label: string;
  count?: number;
  empty?: string;
  children?: ReactNode;
}) {
  const has = children != null && children !== false;
  return (
    <section className="catalog-found">
      <div className="catalog-found-label">
        {label}
        {typeof count === "number" ? <span>{count}</span> : null}
      </div>
      {has ? children : empty ? (
        <p className="catalog-empty">{empty}</p>
      ) : null}
    </section>
  );
}
