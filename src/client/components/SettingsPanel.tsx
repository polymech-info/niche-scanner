import React, { useMemo, useState } from "react";
import { Check, Pencil, Plus, Trash2, X } from "lucide-react";
import {
  blacklistHits,
  normalizeBlacklistWord,
  topWords,
} from "../../shared/config";
import {
  addBlacklistWord,
  removeBlacklistWord,
  saveSettings,
  updateBlacklistWord,
} from "../lib/api";
import type { ProductProfile } from "../../shared/config";
import { settingsOrEmpty, useSearchActions, useSettings } from "../lib/query";
import { useStore } from "../store/app";

type SettingsTab = "product" | "blacklist";

export function SettingsPanel({ phrases }: { phrases: string[] }) {
  const [tab, setTab] = useState<SettingsTab>("product");

  return (
    <div className="px-5 py-4 space-y-4">
      <div>
        <h2 className="text-sm font-semibold tracking-tight">Settings</h2>
        <p className="lede mt-1 text-xs" style={{ color: "var(--color-muted)" }}>
          Global. Stored in data/config.json. Generate uses product limits.
        </p>
      </div>
      <div className="seg">
        {(["product", "blacklist"] as const).map((key) => (
          <button
            key={key}
            type="button"
            onClick={() => setTab(key)}
            data-on={tab === key}
          >
            {key}
          </button>
        ))}
      </div>
      {tab === "product" && <ProductTab />}
      {tab === "blacklist" && <BlacklistTab phrases={phrases} />}
    </div>
  );
}

function ProductTab() {
  const settings = settingsOrEmpty(useSettings().data);
  const { setSettings } = useSearchActions();
  const setError = useStore((s) => s.setError);
  const product = settings.product;
  const [name, setName] = useState(product?.name ?? "");
  const [summary, setSummary] = useState(product?.summary ?? "");
  const [platforms, setPlatforms] = useState(product?.platforms.join(", ") ?? "");
  const [notPlatforms, setNotPlatforms] = useState(
    product?.notPlatforms.join(", ") ?? ""
  );
  const [doesNot, setDoesNot] = useState(product?.doesNot.join(", ") ?? "");
  const [busy, setBusy] = useState(false);

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const next: ProductProfile = {
        name: name.trim(),
        summary: summary.trim() || undefined,
        platforms: platforms.split(","),
        notPlatforms: notPlatforms.split(","),
        doesNot: doesNot.split(","),
      };
      const { capabilities: _overlay, ...rest } = settings;
      setSettings(
        await saveSettings({
          ...rest,
          product: next,
        })
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="grid gap-3 max-w-xl"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <p className="text-xs" style={{ color: "var(--color-muted)" }}>
        Brand and platform policy only. Product features and workflows come
        from the generated CLI/XBlox capability snapshot.
      </p>
      <label className="block">
        <span className="ctrl-label">Name</span>
        <input
          className="field w-full mt-1"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Tanit"
        />
      </label>
      <label className="block">
        <span className="ctrl-label">Summary</span>
        <input
          className="field w-full mt-1"
          value={summary}
          onChange={(e) => setSummary(e.target.value)}
          placeholder="Windows desktop app. Not Mac, not mobile."
        />
      </label>
      <label className="block">
        <span className="ctrl-label">Platforms</span>
        <input
          className="field w-full mt-1"
          value={platforms}
          onChange={(e) => setPlatforms(e.target.value)}
          placeholder="windows"
        />
      </label>
      <label className="block">
        <span className="ctrl-label">Not platforms</span>
        <input
          className="field w-full mt-1"
          value={notPlatforms}
          onChange={(e) => setNotPlatforms(e.target.value)}
          placeholder="mac, ios, android, mobile"
        />
      </label>
      <label className="block">
        <span className="ctrl-label">Never claim</span>
        <input
          className="field w-full mt-1"
          value={doesNot}
          onChange={(e) => setDoesNot(e.target.value)}
          placeholder="mac app, iphone app"
        />
      </label>
      <button type="submit" className="btn btn-primary w-fit" disabled={busy}>
        {busy ? "Saving…" : "Save product"}
      </button>
    </form>
  );
}

function BlacklistTab({ phrases }: { phrases: string[] }) {
  const settings = settingsOrEmpty(useSettings().data);
  const { setSettings } = useSearchActions();
  const setError = useStore((s) => s.setError);
  const [draft, setDraft] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState("");

  const listed = useMemo(
    () => new Set(settings.blacklist.map((word) => normalizeBlacklistWord(word))),
    [settings.blacklist]
  );

  const words = useMemo(() => {
    const q = normalizeBlacklistWord(filter);
    return topWords(phrases).filter((row) => !q || row.word.includes(q));
  }, [phrases, filter]);

  const rows = useMemo(
    () =>
      [...settings.blacklist]
        .map((word) => ({
          word,
          hits: blacklistHits(phrases, word),
        }))
        .sort((a, b) => b.hits - a.hits || a.word.localeCompare(b.word)),
    [phrases, settings.blacklist]
  );

  const run = async (work: () => Promise<typeof settings>) => {
    setBusy(true);
    setError(null);
    try {
      setSettings(await work());
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const addWord = (raw: string) => {
    const word = normalizeBlacklistWord(raw);
    if (!word || listed.has(word)) return;
    void run(() => addBlacklistWord(word));
    setDraft("");
  };

  const saveEdit = async () => {
    if (!editing) return;
    const next = normalizeBlacklistWord(editValue);
    if (!next || next === editing) {
      setEditing(null);
      return;
    }
    if (await run(() => updateBlacklistWord(editing, next))) {
      setEditing(null);
    }
  };

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <section>
        <div className="flex items-end justify-between gap-3 mb-2">
          <div>
            <h3 className="text-xs font-semibold">Top words</h3>
            <p className="text-xs mt-0.5" style={{ color: "var(--color-muted)" }}>
              Click to add. Global list, counts from this search.
            </p>
          </div>
          <input
            className="field h-8 w-36 text-xs"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="filter"
          />
        </div>
        <table className="w-full text-sm table-fixed">
          <colgroup>
            <col />
            <col className="w-16" />
            <col className="w-16" />
            <col className="w-14" />
          </colgroup>
          <thead className="data-head sticky top-0">
            <tr>
              <th className="text-left px-3 py-1.5 font-medium">Word</th>
              <th className="text-right px-2 py-1.5 font-medium">Uses</th>
              <th className="text-right px-2 py-1.5 font-medium">Phrases</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {words.length === 0 && (
              <tr>
                <td
                  colSpan={4}
                  className="px-3 py-6 text-xs"
                  style={{ color: "var(--color-muted)" }}
                >
                  No words in this search yet.
                </td>
              </tr>
            )}
            {words.map((row) => {
              const on = listed.has(row.word);
              return (
                <tr key={row.word} className="hover:bg-[var(--color-hover)]">
                  <td className="px-3 py-1.5 font-mono text-xs">{row.word}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums text-xs">
                    {row.count}
                  </td>
                  <td className="px-2 py-1.5 text-right tabular-nums text-xs">
                    {row.phrases}
                  </td>
                  <td className="px-1 py-1 text-right">
                    <button
                      type="button"
                      className="btn btn-quiet h-7 px-2 text-xs"
                      disabled={busy || on}
                      onClick={() => addWord(row.word)}
                      title={on ? "Already on the blacklist" : "Add to blacklist"}
                    >
                      {on ? "on" : "add"}
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>

      <section>
        <h3 className="text-xs font-semibold">Blacklist</h3>
        <p className="text-xs mt-0.5 mb-2" style={{ color: "var(--color-muted)" }}>
          Phrases that contain these words are skipped.
        </p>
        <form
          className="flex gap-2 mb-3"
          onSubmit={(event) => {
            event.preventDefault();
            addWord(draft);
          }}
        >
          <input
            className="field h-8 text-xs"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="add word or phrase"
            disabled={busy}
          />
          <button
            type="submit"
            className="btn btn-ghost h-8 px-2.5"
            disabled={busy || !normalizeBlacklistWord(draft)}
            title="Add to blacklist"
          >
            <Plus size={14} />
            Add
          </button>
        </form>
        <table className="w-full text-sm table-fixed">
          <colgroup>
            <col />
            <col className="w-16" />
            <col className="w-16" />
          </colgroup>
          <thead className="data-head sticky top-0">
            <tr>
              <th className="text-left px-3 py-1.5 font-medium">Word</th>
              <th className="text-right px-2 py-1.5 font-medium">Hits</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td
                  colSpan={3}
                  className="px-3 py-6 text-xs"
                  style={{ color: "var(--color-muted)" }}
                >
                  Empty. Add a top word or type one.
                </td>
              </tr>
            )}
            {rows.map((row) => (
              <tr key={row.word} className="hover:bg-[var(--color-hover)]">
                <td className="px-3 py-1.5">
                  {editing === row.word ? (
                    <input
                      className="field h-7 text-xs font-mono"
                      value={editValue}
                      autoFocus
                      onChange={(e) => setEditValue(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          saveEdit();
                        }
                        if (e.key === "Escape") setEditing(null);
                      }}
                      disabled={busy}
                    />
                  ) : (
                    <span className="font-mono text-xs">{row.word}</span>
                  )}
                </td>
                <td className="px-2 py-1.5 text-right tabular-nums text-xs">
                  {row.hits}
                </td>
                <td className="px-1 py-1">
                  <div className="flex justify-end gap-0.5">
                    {editing === row.word ? (
                      <>
                        <button
                          type="button"
                          className="btn btn-quiet h-7 w-7 p-0"
                          title="Save"
                          disabled={busy}
                          onClick={saveEdit}
                        >
                          <Check size={13} />
                        </button>
                        <button
                          type="button"
                          className="btn btn-quiet h-7 w-7 p-0"
                          title="Cancel"
                          onClick={() => setEditing(null)}
                        >
                          <X size={13} />
                        </button>
                      </>
                    ) : (
                      <>
                        <button
                          type="button"
                          className="btn btn-quiet h-7 w-7 p-0"
                          title="Edit"
                          disabled={busy}
                          onClick={() => {
                            setEditing(row.word);
                            setEditValue(row.word);
                          }}
                        >
                          <Pencil size={13} />
                        </button>
                        <button
                          type="button"
                          className="btn btn-quiet h-7 w-7 p-0"
                          title="Remove"
                          disabled={busy}
                          onClick={() =>
                            void run(() => removeBlacklistWord(row.word))
                          }
                        >
                          <Trash2 size={13} />
                        </button>
                      </>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}
