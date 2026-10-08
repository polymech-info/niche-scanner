import React, { useEffect, useMemo, useState } from "react";
import { Plus, RefreshCw, Trash2 } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import type {
  CapabilityKind,
  CapabilityWorkflow,
  ProductCapability,
} from "../../shared/capabilities";
import { isCustomCapabilityId } from "../../shared/capability-overlay";
import {
  deleteCustomCapability,
  refreshCapabilities,
  saveCustomCapability,
  setCapabilityAvailability,
  setCapabilityEnabled,
  setWorkflowEnabled,
  type CapabilityGrounding,
} from "../lib/api";
import { keys, useCapabilities } from "../lib/query";
import { useStore } from "../store/app";
import {
  CatalogDetailHead,
  CatalogFacts,
  CatalogFound,
  CatalogWorkbench,
  type CatalogGroup,
} from "./CatalogWorkbench";

type Scope = "all" | "enabled" | "disabled" | "custom";

const EMPTY_FORM = {
  id: "",
  label: "",
  kind: "documentation" as CapabilityKind,
  description: "",
  terms: "",
};

function formatWhen(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString();
}

function capId(id: string) {
  return `cap:${id}`;
}

function wfId(id: string) {
  return `wf:${id}`;
}

function isCustom(row: ProductCapability) {
  return isCustomCapabilityId(row.id) || row.source === "custom";
}

export function CapabilitiesPanel() {
  const client = useQueryClient();
  const query = useCapabilities();
  const setRunning = useStore((state) => state.setRunning);
  const setError = useStore((state) => state.setError);
  const running = useStore((state) => state.running);
  const [scope, setScope] = useState<Scope>("all");
  const [busy, setBusy] = useState<string | null>(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const grounding = query.data;
  const overlay = grounding?.overlay;
  const disabledWorkflows = useMemo(
    () => new Set(overlay?.disabledWorkflows ?? []),
    [overlay]
  );

  const cache = (next: CapabilityGrounding) => {
    client.setQueryData(keys.capabilities, next);
  };

  const refresh = async (stage: "capture" | "compile" | "refresh") => {
    setBusy(stage);
    setRunning(true);
    setError(null);
    try {
      const result = await refreshCapabilities(stage);
      cache(result.grounding);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
      setRunning(false);
    }
  };

  const toggleCap = async (id: string, enabled: boolean) => {
    setError(null);
    try {
      cache(await setCapabilityEnabled(id, enabled));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const toggleWorkflow = async (id: string, enabled: boolean) => {
    setError(null);
    try {
      cache(await setWorkflowEnabled(id, enabled));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const saveCustom = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!form.label.trim()) return;
    setBusy("custom");
    setError(null);
    try {
      const next = await saveCustomCapability({
        id: form.id || undefined,
        label: form.label,
        kind: form.kind,
        description: form.description,
        terms: form.terms,
      });
      cache(next);
      const saved =
        next.capabilities.find((row) =>
          form.id ? row.id === form.id : row.label === form.label.trim()
        ) ?? next.capabilities.find((row) => isCustom(row) && row.label === form.label.trim());
      setForm(EMPTY_FORM);
      if (saved) setSelectedId(capId(saved.id));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const removeCustom = async (id: string) => {
    setError(null);
    try {
      cache(await deleteCustomCapability(id));
      if (form.id === id) setForm(EMPTY_FORM);
      if (selectedId === capId(id)) setSelectedId("form:custom");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const editCustom = (row: ProductCapability) => {
    setForm({
      id: row.id,
      label: row.label,
      kind: row.kind,
      description: row.description,
      terms: row.terms.join(", "),
    });
    setSelectedId("form:custom");
  };

  const capabilities = grounding?.capabilities ?? [];
  const workflows = grounding?.workflows ?? [];

  const features = capabilities.filter((row) => row.kind === "documentation");
  const capturedCustom = capabilities.filter((row) =>
    row.id.startsWith("command:custom.")
  );
  const rest = capabilities.filter(
    (row) => row.kind !== "documentation" && !row.id.startsWith("command:custom.")
  );

  const matchesScope = (enabled: boolean, custom: boolean) => {
    if (scope === "enabled") return enabled;
    if (scope === "disabled") return !enabled;
    if (scope === "custom") return custom;
    return true;
  };

  const capItem = (row: ProductCapability) => {
    const enabled = row.available !== false;
    return {
      id: capId(row.id),
      label: row.label,
      enabled,
      muted: !enabled,
      badge: isCustom(row) ? "custom" : undefined,
      searchText: [row.id, row.kind, row.source, row.description, ...(row.terms ?? [])].join(
        " "
      ),
    };
  };

  const groups: CatalogGroup[] = useMemo(() => {
    const featureRows = features.filter((row) =>
      matchesScope(row.available !== false, isCustom(row))
    );
    const customRows = capturedCustom.filter((row) =>
      matchesScope(row.available !== false, true)
    );
    const workflowRows = workflows.filter((row) =>
      matchesScope(!disabledWorkflows.has(row.id), false)
    );
    const restRows = rest.filter((row) =>
      matchesScope(row.available !== false, isCustom(row))
    );
    const enabledCount = (rows: { enabled?: boolean }[]) =>
      rows.filter((row) => row.enabled !== false).length;

    const out: CatalogGroup[] = [];
    const push = (
      id: string,
      label: string,
      items: CatalogGroup["items"],
      searchText: string
    ) => {
      if (scope !== "all" && items.length === 0) return;
      out.push({
        id,
        label,
        enabled: items.length
          ? enabledCount(items) === items.length
          : undefined,
        indeterminate:
          items.length > 0 &&
          enabledCount(items) > 0 &&
          enabledCount(items) < items.length,
        count: items.length,
        searchText,
        items,
      });
    };

    push("g:documentation", "Features", featureRows.map(capItem), "features documentation");
    push(
      "g:custom-commands",
      "Custom commands",
      customRows.map(capItem),
      "ribbon custom commands"
    );
    push(
      "g:workflows",
      "Workflows",
      workflowRows.map((row) => {
        const enabled = !disabledWorkflows.has(row.id);
        return {
          id: wfId(row.id),
          label: row.label,
          enabled,
          muted: !enabled,
          badge: String(row.nodeIds.length),
          searchText: `${row.id} ${row.source}`,
        };
      }),
      "workflows xblox"
    );
    push(
      "g:rest",
      "Commands, blocks, surfaces",
      restRows.map(capItem),
      "commands blocks surfaces"
    );
    out.push({
      id: "g:custom",
      label: "Custom overlay",
      count: overlay?.custom.length ?? 0,
      searchText: "add custom overlay",
      items: [
        {
          id: "form:custom",
          label: form.id ? `Edit ${form.label || form.id}` : "Add custom",
          badge: "edit",
          searchText: "add custom capability",
        },
      ],
    });
    return out;
  }, [
    capturedCustom,
    disabledWorkflows,
    features,
    form.id,
    form.label,
    overlay?.custom.length,
    rest,
    scope,
    workflows,
  ]);

  useEffect(() => {
    if (selectedId) {
      const stillThere = groups.some(
        (group) =>
          group.id === selectedId ||
          group.items.some((item) => item.id === selectedId)
      );
      if (stillThere) return;
    }
    const first = groups[0]?.items[0]?.id || groups[0]?.id || "form:custom";
    setSelectedId(first);
  }, [groups, selectedId]);

  const selectedCap =
    capabilities.find((row) => capId(row.id) === selectedId) ?? null;
  const selectedWorkflow =
    workflows.find((row) => wfId(row.id) === selectedId) ?? null;
  const selectedGroup = groups.find((group) => group.id === selectedId) ?? null;

  const toggleItem = (id: string, enabled: boolean) => {
    if (id.startsWith("cap:")) void toggleCap(id.slice(4), enabled);
    else if (id.startsWith("wf:")) void toggleWorkflow(id.slice(3), enabled);
  };

  const toggleGroup = async (id: string, enabled: boolean) => {
    const group = groups.find((row) => row.id === id);
    if (!group) return;
    const ids = group.items
      .filter((item) => item.id.startsWith("cap:"))
      .map((item) => item.id.slice(4));
    const workflows = group.items
      .filter((item) => item.id.startsWith("wf:"))
      .map((item) => item.id.slice(3));
    if (!ids.length && !workflows.length) return;
    setError(null);
    try {
      cache(await setCapabilityAvailability({ enabled, ids, workflows }));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <main className="flex-1 min-w-0 min-h-0 flex flex-col overflow-hidden">
      <div className="shrink-0 px-5 pt-5 pb-3 md:px-8">
        <div className="text-xs mb-1" style={{ color: "var(--color-muted)" }}>
          Product grounding
        </div>
        <h1 className="search-title">Capabilities</h1>
      </div>

      <div className="flex-1 min-h-0 px-5 pb-5 md:px-8 flex flex-col">
        <CatalogWorkbench
          groups={groups}
          selectedId={selectedId}
          onSelect={setSelectedId}
          onToggleItem={toggleItem}
          onToggleGroup={toggleGroup}
          searchPlaceholder="Filter features, workflows, commands"
          emptySearch="No capabilities match."
          emptyTree={
            query.isError
              ? "No snapshot yet. Recapture product truth, then compile."
              : "Loading snapshot…"
          }
          toolbar={
            <div className="catalog-toolbar">
              <div className="min-w-0 mr-auto">
                <div className="font-semibold tracking-tight">
                  {grounding?.product ?? "Snapshot"}
                </div>
                <div className="text-xs font-mono mt-0.5" style={{ color: "var(--color-muted)" }}>
                  {grounding
                    ? `${formatWhen(grounding.generatedAt)} · ${grounding.counts.enabled} on · ${grounding.counts.disabled} off`
                    : query.isError
                      ? "No snapshot yet."
                      : "Loading snapshot…"}
                </div>
              </div>
              <div className="seg">
                {(["all", "enabled", "disabled", "custom"] as const).map((key) => (
                  <button
                    key={key}
                    type="button"
                    data-on={scope === key}
                    onClick={() => setScope(key)}
                  >
                    {key}
                  </button>
                ))}
              </div>
              <button
                type="button"
                className="btn btn-ghost"
                disabled={running}
                onClick={() => void refresh("refresh")}
              >
                <RefreshCw size={13} />
                {busy === "refresh" ? "Capturing…" : "Recapture"}
              </button>
              <button
                type="button"
                className="btn btn-ghost"
                disabled={running}
                onClick={() => void refresh("compile")}
              >
                {busy === "compile" ? "Compiling…" : "Recompile"}
              </button>
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => {
                  setForm(EMPTY_FORM);
                  setSelectedId("form:custom");
                }}
              >
                <Plus size={13} />
                Add custom
              </button>
            </div>
          }
          treeMeta={
            <>
              <strong>Capabilities</strong>
              <span>{grounding?.counts.capabilities ?? 0}</span>
            </>
          }
          detail={
            selectedId === "form:custom" ? (
              <CustomForm
                form={form}
                busy={busy === "custom"}
                onChange={setForm}
                onSubmit={saveCustom}
                onCancel={() => {
                  setForm(EMPTY_FORM);
                  setSelectedId(groups[0]?.items[0]?.id ?? "g:documentation");
                }}
              />
            ) : selectedCap ? (
              <CapabilityDetail
                row={selectedCap}
                onToggle={toggleCap}
                onEdit={isCustom(selectedCap) ? () => editCustom(selectedCap) : undefined}
                onDelete={
                  isCustom(selectedCap)
                    ? () => void removeCustom(selectedCap.id)
                    : undefined
                }
              />
            ) : selectedWorkflow ? (
              <WorkflowDetail
                row={selectedWorkflow}
                enabled={!disabledWorkflows.has(selectedWorkflow.id)}
                onToggle={toggleWorkflow}
              />
            ) : selectedGroup ? (
              <div className="flex min-h-0 flex-1 flex-col gap-3">
                <CatalogDetailHead name={selectedGroup.label} />
                <p className="catalog-empty" style={{ padding: 0 }}>
                  {selectedGroup.items.length
                    ? "Select a feature in the tree to see its detail."
                    : "Nothing in this group for the current filter."}
                </p>
              </div>
            ) : (
              <p className="catalog-empty">Select a feature to see its detail.</p>
            )
          }
        />
      </div>
    </main>
  );
}

function CapabilityDetail({
  row,
  onToggle,
  onEdit,
  onDelete,
}: {
  row: ProductCapability;
  onToggle: (id: string, enabled: boolean) => void;
  onEdit?: () => void;
  onDelete?: () => void;
}) {
  const enabled = row.available !== false;
  const parent =
    row.kind === "documentation"
      ? "Features"
      : row.id.startsWith("command:custom.")
        ? "Custom commands"
        : "Commands, blocks, surfaces";
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <CatalogDetailHead parent={parent} name={row.label}>
        {isCustom(row) ? (
          <span className="pill" data-on="true">
            custom
          </span>
        ) : null}
        {onEdit ? (
          <button type="button" className="btn btn-quiet" onClick={onEdit}>
            Edit
          </button>
        ) : null}
        {onDelete ? (
          <button
            type="button"
            className="btn btn-quiet h-7 w-7 p-0"
            title="Remove custom capability"
            onClick={onDelete}
          >
            <Trash2 size={12} />
          </button>
        ) : null}
        <button
          type="button"
          className="pill"
          data-on={enabled}
          onClick={() => onToggle(row.id, !enabled)}
        >
          {enabled ? "On" : "Off"}
        </button>
      </CatalogDetailHead>
      {row.description ? (
        <p className="m-0 text-sm whitespace-pre-wrap max-w-[62ch]">{row.description}</p>
      ) : (
        <p className="catalog-empty" style={{ padding: 0 }}>
          No description captured.
        </p>
      )}
      <CatalogFacts
        rows={[
          {
            label: "Id",
            value: <code className="text-xs break-all">{row.id}</code>,
          },
          { label: "Kind", value: row.kind },
          { label: "Source", value: <code className="text-xs break-all">{row.source}</code> },
          row.terms.length > 0 && { label: "Terms", value: row.terms.join(", ") },
          row.inputs.length > 0 && { label: "Inputs", value: row.inputs.join(", ") },
          row.outputs.length > 0 && { label: "Outputs", value: row.outputs.join(", ") },
        ]}
      />
      <CatalogFound
        label="Options"
        count={row.options.length}
        empty="No options on this capability."
      >
        {row.options.length ? (
          <ul className="grid gap-1 text-sm">
            {row.options.map((option) => (
              <li key={option.name}>
                <span className="font-medium">{option.name}</span>
                {option.type ? (
                  <span className="text-xs ml-2" style={{ color: "var(--color-muted)" }}>
                    {option.type}
                    {option.required ? " · required" : ""}
                  </span>
                ) : null}
                {option.description ? (
                  <div className="text-xs" style={{ color: "var(--color-muted)" }}>
                    {option.description}
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        ) : null}
      </CatalogFound>
    </div>
  );
}

function WorkflowDetail({
  row,
  enabled,
  onToggle,
}: {
  row: CapabilityWorkflow;
  enabled: boolean;
  onToggle: (id: string, enabled: boolean) => void;
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <CatalogDetailHead parent="Workflows" name={row.label}>
        <button
          type="button"
          className="pill"
          data-on={enabled}
          onClick={() => onToggle(row.id, !enabled)}
        >
          {enabled ? "On" : "Off"}
        </button>
      </CatalogDetailHead>
      <CatalogFacts
        rows={[
          {
            label: "Id",
            value: <code className="text-xs break-all">{row.id}</code>,
          },
          {
            label: "Source",
            value: <code className="text-xs break-all">{row.source}</code>,
          },
          { label: "Nodes", value: String(row.nodeIds.length) },
        ]}
      />
      <CatalogFound label="Nodes" count={row.nodeIds.length} empty="No nodes.">
        {row.nodeIds.length ? (
          <ul className="grid gap-1 text-xs font-mono">
            {row.nodeIds.map((id) => (
              <li key={id}>{id}</li>
            ))}
          </ul>
        ) : null}
      </CatalogFound>
    </div>
  );
}

function CustomForm({
  form,
  busy,
  onChange,
  onSubmit,
  onCancel,
}: {
  form: typeof EMPTY_FORM;
  busy: boolean;
  onChange: React.Dispatch<React.SetStateAction<typeof EMPTY_FORM>>;
  onSubmit: (event: React.FormEvent) => void;
  onCancel: () => void;
}) {
  return (
    <form onSubmit={onSubmit} className="flex min-h-0 flex-1 flex-col gap-3">
      <CatalogDetailHead
        parent="Custom overlay"
        name={form.id ? form.label || form.id : "Add custom"}
      />
      <label className="grid gap-1.5">
        <span className="text-xs font-medium">Label</span>
        <input
          className="field"
          value={form.label}
          onChange={(event) =>
            onChange((current) => ({ ...current, label: event.target.value }))
          }
          placeholder="Local markdown preview"
          required
        />
      </label>
      <label className="grid gap-1.5">
        <span className="text-xs font-medium">Kind</span>
        <select
          className="field"
          value={form.kind}
          onChange={(event) =>
            onChange((current) => ({
              ...current,
              kind: event.target.value as CapabilityKind,
            }))
          }
        >
          <option value="documentation">Feature</option>
          <option value="command">Command</option>
          <option value="block">Block</option>
          <option value="surface">Surface</option>
        </select>
      </label>
      <label className="grid gap-1.5">
        <span className="text-xs font-medium">Description</span>
        <input
          className="field"
          value={form.description}
          onChange={(event) =>
            onChange((current) => ({
              ...current,
              description: event.target.value,
            }))
          }
          placeholder="What the product actually does"
        />
      </label>
      <label className="grid gap-1.5">
        <span className="text-xs font-medium">Terms</span>
        <input
          className="field"
          value={form.terms}
          onChange={(event) =>
            onChange((current) => ({ ...current, terms: event.target.value }))
          }
          placeholder="markdown, preview, viewer"
        />
      </label>
      <div className="flex justify-end gap-2 mt-auto">
        {form.id ? (
          <span
            className="mr-auto self-center text-xs font-mono"
            style={{ color: "var(--color-muted)" }}
          >
            {form.id}
          </span>
        ) : null}
        <button type="button" className="btn btn-quiet" onClick={onCancel}>
          Cancel
        </button>
        <button
          type="submit"
          className="btn btn-primary"
          disabled={busy || !form.label.trim()}
        >
          {form.id ? "Save custom" : "Add custom"}
        </button>
      </div>
    </form>
  );
}
