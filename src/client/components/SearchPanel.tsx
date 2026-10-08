import React, { useMemo, useState } from "react";
import { ArrowDown, ArrowUp, ChevronDown, Trash2, X } from "lucide-react";
import type {
  ArticleRole,
  DiscoverEngine,
  DiscoverOptions,
  Locale,
  PhraseRecord,
  SiteMeta,
} from "../../shared/phrases";
import { classForPhrase, groupArticles } from "../../shared/classify";
import { SettingsPanel } from "./SettingsPanel";
import { MarkdownRenderer } from "./MarkdownRenderer";
import { buildSearchSnapshot } from "../../shared/snapshot";
import { googleSearchUrl } from "../../shared/links";
import { collectRankingLeaves, type RankingLeaf } from "../../shared/ranking";
import { siteFor } from "../../shared/sites";
import {
  DEFAULT_GENERATE_OPTIONS,
  buildArticlePackage,
  type GenerateOptions,
} from "../../shared/brief";
import {
  addPhrase,
  removePhrase,
  createSearch,
  deleteSearch,
  expandSearch,
  enrichSearch,
  discoverMoreSearch,
  openNeighborSearch,
  generateSearch,
  qualifySearch,
  type DiscoverMoreOutput,
  type GenerateOutput,
  type ReportOutput,
} from "../lib/api";
import { findSearchForSeed, uniqueNeighbors } from "../../shared/neighbors";
import { Link, useParams } from "@tanstack/react-router";
import {
  settingsOrEmpty,
  useConfig,
  useSearch,
  useSearchActions,
  useSearches,
  useReport,
  useSerpapiUrl,
  useSettings,
} from "../lib/query";
import { useStore } from "../store/app";

type SortKey = "phrase" | "role" | "niche" | "links";

const ENGINE_LABELS: { id: DiscoverEngine; label: string }[] = [
  { id: "autocomplete", label: "Autocomplete" },
  { id: "related_searches", label: "Related" },
  { id: "people_also_ask", label: "PAA" },
];

function splitSeeds(raw: string): string[] {
  return raw
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function EngineToggles({
  value,
  onChange,
}: {
  value: DiscoverEngine[];
  onChange: (next: DiscoverEngine[]) => void;
}) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {ENGINE_LABELS.map((engine) => {
        const checked = value.includes(engine.id);
        return (
          <button
            key={engine.id}
            type="button"
            className="pill"
            data-on={checked}
            title={engine.label}
            onClick={() => {
              if (checked && value.length === 1) return;
              onChange(
                checked
                  ? value.filter((id) => id !== engine.id)
                  : [...value, engine.id]
              );
            }}
          >
            {engine.label}
          </button>
        );
      })}
    </div>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block space-y-1">
      <span className="text-xs" style={{ color: "var(--color-muted)" }}>
        {label}
      </span>
      {children}
    </label>
  );
}

function Hint({
  tip,
  className = "flex items-center gap-1.5 cursor-help",
  children,
}: {
  tip: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <label className={className} title={tip}>
      {children}
    </label>
  );
}

const ROLE_TONE: Record<ArticleRole, string> = {
  write: "var(--color-accent)",
  faq: "var(--color-text)",
  cluster: "var(--color-muted)",
  skip: "var(--color-muted)",
};

const ROLE_TIP: Record<ArticleRole, string> = {
  write: "Full article. Generate uses this exact phrase as the H1.",
  faq: "FAQ / legal / how-to. Answer first. Often a section, not its own URL.",
  cluster: "Supporting long-tail. Fold under a parent. Do not generate a new page.",
  skip: "Ignore. Local junk, brand noise, or too generic.",
};

const inputClass = "field";

export function SearchPanel() {
  const { searchId: activeId } = useParams({ strict: false });
  const searchQuery = useSearch(activeId);
  const reportQuery = useReport(activeId);
  const active = searchQuery.data ?? null;
  const running = useStore((s) => s.running);
  const setRunning = useStore((s) => s.setRunning);
  const setError = useStore((s) => s.setError);
  const { cache: upsertSearch, open, remove: removeSearch } = useSearchActions();
  const searches = useSearches().data ?? [];
  const config = useConfig().data;
  const settings = settingsOrEmpty(useSettings().data);
  const blacklist = settings.blacklist;

  const [name, setName] = useState("");
  const [seeds, setSeeds] = useState("");
  const [engines, setEngines] = useState<DiscoverEngine[]>([
    "autocomplete",
    "related_searches",
    "people_also_ask",
  ]);
  const [paaDepth, setPaaDepth] = useState(0);
  const [alphabet, setAlphabet] = useState(false);
  const [questions, setQuestions] = useState(false);
  const [expandSeeds, setExpandSeeds] = useState("");
  const [manualPhrase, setManualPhrase] = useState("");
  const [lastAdded, setLastAdded] = useState<string | null>(null);
  const [sortKey, setSortKey] = useState<SortKey>("links");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [showSkip, setShowSkip] = useState(false);
  const [showLinks, setShowLinks] = useState(false);
  const [showAdd, setShowAdd] = useState(false);
  const [tab, setTab] = useState<
    "plan" | "phrases" | "social" | "apps" | "sites" | "report" | "settings"
  >("phrases");
  const [outDir, setOutDir] = useState("");
  const [handoff, setHandoff] = useState<{
    searchId: string;
    output: GenerateOutput;
  } | null>(null);
  const [gen, setGen] = useState<GenerateOptions>(DEFAULT_GENERATE_OPTIONS);
  const [enrichers, setEnrichers] = useState<string[]>(["meta", "ai"]);
  const [enrichLimit, setEnrichLimit] = useState(20);
  const [enrichForce, setEnrichForce] = useState(false);
  const [enrichStats, setEnrichStats] = useState<{
    fetched: number;
    cached: number;
    failed: number;
    skipped: number;
    aiFetched?: number;
    aiCached?: number;
    aiFailed?: number;
    aiSkipped?: number;
  } | null>(null);
  const [discoverStats, setDiscoverStats] = useState<DiscoverMoreOutput | null>(
    null
  );
  const visibleHandoff =
    handoff && handoff.searchId === active?.id ? handoff.output : null;

  const options: Partial<DiscoverOptions> = {
    engines,
    paaDepth,
    alphabet,
    questionPrefixes: questions,
  };

  const runQualify = async () => {
    if (!active) return;
    setRunning(true);
    setError(null);
    try {
      upsertSearch(await qualifySearch(active.id, { limit: 6 }));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRunning(false);
    }
  };

  const runEnrich = async () => {
    if (!active) return;
    setRunning(true);
    setError(null);
    try {
      const result = await enrichSearch(active.id, {
        enrichers,
        limit: enrichLimit,
        force: enrichForce,
      });
      upsertSearch(result.doc);
      setEnrichStats({
        fetched: result.fetched,
        cached: result.cached,
        failed: result.failed,
        skipped: result.skipped,
        aiFetched: result.aiFetched,
        aiCached: result.aiCached,
        aiFailed: result.aiFailed,
        aiSkipped: result.aiSkipped,
      });
      setTab(enrichers.includes("ai") ? "phrases" : "sites");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRunning(false);
    }
  };

  const runDiscoverMore = async () => {
    if (!active) return;
    setRunning(true);
    setError(null);
    try {
      const result = await discoverMoreSearch(active.id, {
        force: enrichForce,
      });
      upsertSearch(result.doc);
      setDiscoverStats(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRunning(false);
    }
  };

  const runOpenNeighbor = async (seed: string) => {
    if (!active) return;
    setRunning(true);
    setError(null);
    try {
      const result = await openNeighborSearch(active.id, seed);
      upsertSearch(result.parent);
      open(result.child);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRunning(false);
    }
  };

  const siteCount = Object.keys(active?.sites ?? {}).length;
  const rankingLeaves = useMemo(
    () =>
      active
        ? collectRankingLeaves(active)
        : { social: [] as RankingLeaf[], apps: [] as RankingLeaf[] },
    [active]
  );

  const nextSearches = useMemo(
    () =>
      uniqueNeighbors(active?.neighbors ?? [], [
        ...(active?.seeds ?? []),
        ...(active?.phrases ?? []).map((row) => row.phrase),
      ]),
    [active]
  );

  const skipCount = useMemo(
    () =>
      (active?.phrases ?? []).filter(
        (row) => classForPhrase(row.phrase, row.class, blacklist).role === "skip"
      ).length,
    [active, blacklist]
  );

  const phrases = useMemo(() => {
    const list = (active?.phrases ?? []).filter((row) => {
      if (showSkip) return true;
      return classForPhrase(row.phrase, row.class, blacklist).role !== "skip";
    });
    const copy = [...list];
    const sign = sortDir === "asc" ? 1 : -1;
    const roleRank = (phrase: (typeof copy)[number]) => {
      const role = classForPhrase(phrase.phrase, phrase.class, blacklist).role;
      return { write: 0, faq: 1, cluster: 2, skip: 3 }[role];
    };
    const linksOf = (row: (typeof copy)[number]) => row.serp?.organics?.length ?? 0;
    copy.sort((a, b) => {
      if (sortKey === "phrase") return sign * a.phrase.localeCompare(b.phrase);
      if (sortKey === "role") return sign * (roleRank(a) - roleRank(b));
      if (sortKey === "links") {
        const byLinks = sign * (linksOf(a) - linksOf(b));
        return byLinks || b.scores.niche - a.scores.niche;
      }
      const byNiche = sign * (a.scores.niche - b.scores.niche);
      return byNiche || linksOf(b) - linksOf(a);
    });
    return copy;
  }, [active, blacklist, showSkip, sortDir, sortKey]);

  const preview = useMemo(
    () =>
      active
        ? buildArticlePackage(active, gen, settings, config?.serpapiKey)
        : null,
    [active, settings, config?.serpapiKey, gen]
  );

  const snapshot = useMemo(
    () => (active ? buildSearchSnapshot(active) : null),
    [active]
  );

  const toggleRole = (role: ArticleRole) => {
    setGen((current) => {
      const has = current.roles.includes(role);
      const roles = has
        ? current.roles.filter((item) => item !== role)
        : [...current.roles, role];
      return { ...current, roles: roles.length ? roles : current.roles };
    });
  };

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDir((dir) => (dir === "asc" ? "desc" : "asc"));
      return;
    }
    setSortKey(key);
    setSortDir(key === "phrase" || key === "role" ? "asc" : "desc");
  };

  const runCreate = async (event: React.FormEvent) => {
    event.preventDefault();
    setRunning(true);
    setError(null);
    try {
      const doc = await createSearch({
        seeds: splitSeeds(seeds),
        name: name.trim() || undefined,
        locale: config?.locale,
        options,
      });
      open(doc);
      setSeeds("");
      setName("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRunning(false);
    }
  };

  const runExpand = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!active) return;
    setRunning(true);
    setError(null);
    try {
      const doc = await expandSearch(active.id, {
        seeds: splitSeeds(expandSeeds),
        options,
      });
      upsertSearch(doc);
      setExpandSeeds("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRunning(false);
    }
  };

  const runManual = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!active) return;
    setError(null);
    try {
      const doc = await addPhrase(active.id, manualPhrase);
      upsertSearch(doc);
      setLastAdded(manualPhrase.trim().toLowerCase().replace(/\s+/g, " "));
      setManualPhrase("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const runRemove = async (phrase: string) => {
    if (!active) return;
    setError(null);
    try {
      upsertSearch(await removePhrase(active.id, phrase));
      if (lastAdded === phrase) setLastAdded(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const runGenerate = async () => {
    if (!active) return;
    setRunning(true);
    setError(null);
    try {
      const output = await generateSearch(active.id, {
        outDir: outDir.trim() || undefined,
        options: gen,
      });
      setHandoff({ searchId: active.id, output });
      await reportQuery.refetch();
      setTab("report");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRunning(false);
    }
  };

  const runDelete = async () => {
    if (!active) return;
    if (!window.confirm(`Delete “${active.name}”?`)) return;
    await deleteSearch(active.id);
    removeSearch(active.id);
  };

  if (!activeId) {
    return (
      <main className="flex-1 overflow-y-auto px-8 py-12">
        <div className="max-w-xl">
          <h1 className="search-title">New search</h1>
          <p className="lede mt-2 mb-8" style={{ color: "var(--color-text-secondary)" }}>
            Keywords find suggestions. A full title is kept and expanded around.
            One seed per line.
          </p>
          <form onSubmit={runCreate} className="space-y-4">
            <Field label="Name">
              <input
                className={inputClass}
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="voice recorder"
              />
            </Field>
            <Field label="Seeds">
              <textarea
                className={`${inputClass} min-h-28`}
                value={seeds}
                onChange={(e) => setSeeds(e.target.value)}
                placeholder={
                  "voice recorder\ndoes android have a built-in voice recorder"
                }
                required
                title="One keyword or phrase per line. Commas stay in the phrase."
              />
            </Field>
            <EngineToggles value={engines} onChange={setEngines} />
            <div className="flex flex-wrap items-center gap-3 text-xs" style={{ color: "var(--color-muted)" }}>
              <label className="flex items-center gap-1.5" title="People Also Ask expansion depth">
                PAA
                <input
                  type="number"
                  min={0}
                  max={4}
                  className="field w-12 py-1 px-1.5"
                  value={paaDepth}
                  onChange={(e) => setPaaDepth(Number(e.target.value) || 0)}
                />
              </label>
              <label className="flex items-center gap-1.5 cursor-pointer" title="26 extra autocomplete calls per short keyword">
                <input
                  type="checkbox"
                  className="accent-runny-accent"
                  checked={alphabet}
                  onChange={(e) => setAlphabet(e.target.checked)}
                />
                Alphabet
              </label>
              <label className="flex items-center gap-1.5 cursor-pointer" title="Prefix short keywords with how / what / why">
                <input
                  type="checkbox"
                  className="accent-runny-accent"
                  checked={questions}
                  onChange={(e) => setQuestions(e.target.checked)}
                />
                Question prefixes
              </label>
            </div>
            <button type="submit" disabled={running} className="btn btn-primary">
              {running ? "Searching…" : "Find phrases"}
            </button>
          </form>
        </div>
      </main>
    );
  }

  if (searchQuery.isError) {
    return (
      <main
        className="flex-1 flex flex-col items-center justify-center gap-2 text-sm"
        style={{ color: "var(--color-muted)" }}
      >
        <span>{searchQuery.error.message}</span>
        <Link to="/searches/new" className="btn btn-ghost h-7">
          New search
        </Link>
      </main>
    );
  }

  if (!active) {
    return (
      <main
        className="flex-1 flex items-center justify-center text-sm"
        style={{ color: "var(--color-muted)" }}
      >
        Opening search…
      </main>
    );
  }

  return (
    <main className="flex-1 min-w-0 min-h-0 overflow-y-auto">
      <div
        className="px-5 pt-4 pb-3"
        style={{ borderBottom: "1px solid var(--color-border)" }}
      >
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <h1 className="search-title truncate">{active.name}</h1>
            <div className="meta-split mt-1.5">
              <span>{active.phrases.length} phrases</span>
              {siteCount ? <span>{siteCount} sites</span> : null}
              <span>{active.meta.calls.length} calls</span>
              {active.seeds[0] ? <span>{active.seeds[0]}</span> : null}
            </div>
          </div>
          <div className="flex items-center gap-1.5 shrink-0 pt-0.5">
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => setShowAdd((v) => !v)}
              aria-expanded={showAdd}
              title="Add seeds or a phrase"
            >
              Add
              <ChevronDown
                size={12}
                className={showAdd ? "rotate-180" : ""}
              />
            </button>
            <button
              onClick={runQualify}
              disabled={running}
              className="btn btn-ghost"
              title="Paid SerpAPI: pull live ranking links and PAA answers for the best phrases"
            >
              Qualify
            </button>
            <button
              onClick={runEnrich}
              disabled={running}
              className="btn btn-ghost"
              title="Fetch title / description / OG from ranking URLs"
            >
              Enrich
            </button>
            <button
              onClick={runDiscoverMore}
              disabled={running}
              className="btn btn-ghost"
              title="Cached LLM pass: suggest linked next searches from seed, generate survivors, and related"
            >
              Discover more
            </button>
            <button
              onClick={runGenerate}
              disabled={running}
              className="btn btn-primary"
              title="Write articles.json + report.md. Overlapping titles collapse into hubs."
            >
              {running
                ? "Working…"
                : `Generate${preview ? ` ${preview.metrics.hubCount}` : ""}`}
            </button>
            <button
              onClick={runDelete}
              className="btn btn-quiet h-8 w-8 p-0"
              title="Delete search"
            >
              <Trash2 size={14} />
            </button>
          </div>
        </div>
        {snapshot && <SnapshotStrip snapshot={snapshot} />}
        {nextSearches.length > 0 && (
          <NeighborStrip
            neighbors={nextSearches}
            searches={searches}
            running={running}
            onOpen={runOpenNeighbor}
          />
        )}

        {showAdd && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 mt-3 pt-3" style={{ borderTop: "1px solid var(--color-border)" }}>
          <form onSubmit={runExpand} className="space-y-2">
            <Field label="More seeds">
              <textarea
                className={`${inputClass} min-h-16`}
                value={expandSeeds}
                onChange={(e) => setExpandSeeds(e.target.value)}
                placeholder={"voice recorder\ndoes android have a built-in voice recorder"}
                title="One keyword or phrase per line. Each line is kept as a title and expanded."
              />
            </Field>
            <EngineToggles value={engines} onChange={setEngines} />
            <button type="submit" disabled={running} className="btn btn-primary">
              {running ? "Working…" : "Find more"}
            </button>
          </form>
          <form onSubmit={runManual} className="space-y-2">
            <Field label="Add phrase">
              <input
                className={inputClass}
                value={manualPhrase}
                onChange={(e) => setManualPhrase(e.target.value)}
                placeholder="exact title you want to write"
                required
                title="Adds one article title. No Google call. Remove with × or Undo."
              />
            </Field>
            <p className="text-xs" style={{ color: "var(--color-muted)" }}>
              Title only. Undo or × removes it.
            </p>
            <div className="flex items-center gap-2">
              <button
                type="submit"
                disabled={running || !manualPhrase.trim()}
                className="btn btn-ghost"
              >
                Add
              </button>
              {lastAdded && (
                <button
                  type="button"
                  onClick={() => runRemove(lastAdded)}
                  className="btn btn-quiet"
                  title={`Remove “${lastAdded}”`}
                >
                  Undo
                </button>
              )}
            </div>
          </form>
        </div>
        )}
        <div className="ctrl-bar">
          <div className="ctrl-group">
          <span className="ctrl-label">Generate</span>
          <Hint tip="Skip phrases below this local long-tail score (0-100). Higher = fewer, more specific titles.">
            min niche
            <input
              type="number"
              min={0}
              max={100}
              className="field w-12 py-1 px-1.5"
              value={gen.minNiche}
              onChange={(e) =>
                setGen((c) => ({ ...c, minNiche: Number(e.target.value) || 0 }))
              }
            />
          </Hint>
          <Hint tip="Skip short phrases. 4+ words is usually a real article title.">
            min words
            <input
              type="number"
              min={1}
              max={20}
              className="field w-10 py-1 px-1.5"
              value={gen.minWords}
              onChange={(e) =>
                setGen((c) => ({ ...c, minWords: Number(e.target.value) || 1 }))
              }
            />
          </Hint>
          <Hint tip="Cap how many pages (hubs) Generate writes. Near-duplicate titles fold into one page.">
            max
            <input
              type="number"
              min={1}
              max={200}
              className="field w-10 py-1 px-1.5"
              value={gen.maxGenerate}
              onChange={(e) =>
                setGen((c) => ({ ...c, maxGenerate: Number(e.target.value) || 1 }))
              }
            />
          </Hint>
          {(["write", "faq", "cluster"] as ArticleRole[]).map((role) => (
            <Hint
              key={role}
              tip={ROLE_TIP[role]}
              className="flex items-center gap-1 cursor-help"
            >
              <input
                type="checkbox"
                className="accent-runny-accent"
                checked={gen.roles.includes(role)}
                onChange={() => toggleRole(role)}
              />
              {role}
            </Hint>
          ))}
          <Hint
            tip="Only generate phrases that are questions (how / what / can / does…)."
            className="flex items-center gap-1 cursor-help"
          >
            <input
              type="checkbox"
              className="accent-runny-accent"
              checked={gen.questionsOnly}
              onChange={(e) =>
                setGen((c) => ({ ...c, questionsOnly: e.target.checked }))
              }
            />
            questions only
          </Hint>
          <Hint
            tip="Only phrases that already have live Google ranking links. Run Qualify first."
            className="flex items-center gap-1 cursor-help"
          >
            <input
              type="checkbox"
              className="accent-runny-accent"
              checked={gen.qualifiedOnly}
              onChange={(e) =>
                setGen((c) => ({ ...c, qualifiedOnly: e.target.checked }))
              }
            />
            qualified only
          </Hint>
          <Hint
            tip="Use one cached LLM pass to adjudicate ambiguous or composed capability evidence. This does not write articles."
            className="flex items-center gap-1 cursor-help"
          >
            <input
              type="checkbox"
              className="accent-runny-accent"
              checked={gen.llmGrounding}
              onChange={(e) =>
                setGen((c) => ({ ...c, llmGrounding: e.target.checked }))
              }
            />
            LLM grounding
          </Hint>
          <input
            className="field w-40 py-1 text-xs"
            value={outDir}
            onChange={(e) => setOutDir(e.target.value)}
            placeholder={config?.resultsDir || "data/results"}
            title="Parent output directory for Generate"
          />
          {preview && (
            <span
              style={{ color: "var(--color-muted)" }}
              title="Live Generate preview. Pages = hubs to write. Absorbed = FAQ under a hub."
              className="cursor-help font-mono"
            >
              {preview.metrics.hubCount} pages / {preview.metrics.absorbedCount}{" "}
              absorbed / {preview.metrics.skipCount} skip
              {preview.social.length ? ` / ${preview.social.length} social` : ""}
              {preview.apps.length ? ` / ${preview.apps.length} apps` : ""}
            </span>
          )}
          </div>
          <div className="ctrl-group">
          <span className="ctrl-label">Enrich</span>
          <Hint
            tip="Cheap enricher: fetch title, description, and OG from ranking URLs. No browser."
            className="flex items-center gap-1 cursor-help"
          >
            <input
              type="checkbox"
              className="accent-runny-accent"
              checked={enrichers.includes("meta")}
              onChange={() =>
                setEnrichers((current) =>
                  current.includes("meta")
                    ? current.filter((item) => item !== "meta")
                    : [...current, "meta"]
                )
              }
            />
            meta
          </Hint>
          <Hint
            tip="SerpAPI: pull Google AI overview text for the best phrases. Follows a short-lived token immediately."
            className="flex items-center gap-1 cursor-help"
          >
            <input
              type="checkbox"
              className="accent-runny-accent"
              checked={enrichers.includes("ai")}
              onChange={() =>
                setEnrichers((current) =>
                  current.includes("ai")
                    ? current.filter((item) => item !== "ai")
                    : [...current, "ai"]
                )
              }
            />
            ai
          </Hint>
          <Hint tip="Max unique ranking pages to fetch in one Enrich run.">
            enrich max
            <input
              type="number"
              min={1}
              max={200}
              className="field w-10 py-1 px-1.5"
              value={enrichLimit}
              onChange={(e) => setEnrichLimit(Number(e.target.value) || 1)}
            />
          </Hint>
          <Hint
            tip="Ignore cached site meta and cached neighbor suggestions."
            className="flex items-center gap-1 cursor-help"
          >
            <input
              type="checkbox"
              className="accent-runny-accent"
              checked={enrichForce}
              onChange={(e) => setEnrichForce(e.target.checked)}
            />
            re-fetch
          </Hint>
          </div>
        </div>
        {enrichStats && (
          <div
            className="mt-3 text-xs rounded-md px-3 py-2"
            style={{
              background: "rgba(34,197,94,0.08)",
              color: "var(--color-text-secondary)",
            }}
          >
            Enrich meta: {enrichStats.fetched} fetched / {enrichStats.cached} cached
            {enrichStats.failed ? ` / ${enrichStats.failed} failed` : ""}
            {enrichStats.skipped ? ` / ${enrichStats.skipped} over limit` : ""}
            {" · "}ai: {enrichStats.aiFetched ?? 0} fetched /{" "}
            {enrichStats.aiCached ?? 0} cached
            {enrichStats.aiFailed ? ` / ${enrichStats.aiFailed} failed` : ""}
          </div>
        )}
        {discoverStats && (
          <div
            className="mt-3 text-xs rounded-md px-3 py-2"
            style={{
              background: "var(--color-accent-soft)",
              color: "var(--color-text-secondary)",
            }}
          >
            Discover more: {discoverStats.neighbors?.length ?? 0} neighbors
            {discoverStats.fromCache
              ? " / local cache"
              : ` / ${discoverStats.cacheHits} llm cache / ${discoverStats.transformed} new`}
          </div>
        )}
        {visibleHandoff && (
          <div
            className="mt-3 text-xs rounded-md px-3 py-2"
            style={{
              background: "var(--color-accent-soft)",
              color: "var(--color-text-secondary)",
            }}
          >
            <div>
              Handoff: {visibleHandoff.metrics.hubCount} pages /{" "}
              {visibleHandoff.metrics.absorbedCount} absorbed /{" "}
              {visibleHandoff.metrics.skipCount} skip
            </div>
            <div className="font-mono mt-1 truncate" title={visibleHandoff.report}>
              report: {visibleHandoff.report}
            </div>
            <div className="font-mono truncate" title={visibleHandoff.articles}>
              articles: {visibleHandoff.articles}
            </div>
          </div>
        )}
      </div>

      <div
        className="px-5 py-2 flex items-center gap-3 text-xs sticky top-0 z-10"
        style={{
          background: "var(--color-panel)",
          borderBottom: "1px solid var(--color-border)",
        }}
      >
        <div className="seg">
          {(["plan", "phrases", "social", "apps", "sites", "report", "settings"] as const).map((key) => (
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
        {tab === "phrases" && skipCount > 0 && (
          <label
            className="flex items-center gap-1 cursor-pointer"
            title="Junk / local / brand noise. Hidden by default."
            style={{ color: showSkip ? "var(--color-text)" : "var(--color-muted)" }}
          >
            <input
              type="checkbox"
              className="accent-runny-accent"
              checked={showSkip}
              onChange={(e) => setShowSkip(e.target.checked)}
            />
            skip {skipCount}
          </label>
        )}
        {tab === "phrases" && (
        <label
          className="flex items-center gap-1 cursor-pointer"
          title="Show ranking URLs under each phrase"
          style={{ color: showLinks ? "var(--color-text)" : "var(--color-muted)" }}
        >
          <input
            type="checkbox"
            className="accent-runny-accent"
            checked={showLinks}
            onChange={(e) => setShowLinks(e.target.checked)}
          />
          links
        </label>
        )}
        {active.meta.errors.length > 0 && (
          <span className="text-runny-yellow ml-auto">
            {active.meta.errors.length} API error
            {active.meta.errors.length === 1 ? "" : "s"}
          </span>
        )}
      </div>

      <div>
        {tab === "plan" ? (
          <PlanView
            phrases={phrases}
            landscape={active.landscape ?? []}
            sites={active.sites}
            locale={active.locale}
            blacklist={blacklist}
          />
        ) : tab === "social" ? (
          <RankingView
            kind="social"
            rows={rankingLeaves.social}
            empty="No Reddit / Facebook / other social results yet. Qualify phrases first."
          />
        ) : tab === "apps" ? (
          <RankingView
            kind="apps"
            rows={rankingLeaves.apps}
            empty="No Play / App Store / Microsoft Store listings yet. Qualify phrases first."
          />
        ) : tab === "sites" ? (
          <SitesView sites={active.sites ?? {}} />
        ) : tab === "report" ? (
          <ReportView
            report={
              visibleHandoff?.markdown
                ? {
                    exists: true,
                    report: visibleHandoff.report,
                    markdown: visibleHandoff.markdown,
                  }
                : reportQuery.data
            }
            loading={reportQuery.isPending}
            error={
              reportQuery.error instanceof Error
                ? reportQuery.error.message
                : undefined
            }
            running={running}
            onGenerate={runGenerate}
          />
        ) : tab === "settings" ? (
          <SettingsPanel
            phrases={(active.phrases ?? []).map((row) => row.phrase)}
          />
        ) : (
        <table className="w-full text-sm table-fixed">
          <colgroup>
            <col />
            <col className="w-20" />
            <col className="w-14" />
            <col className="w-24" />
            <col className="w-10" />
          </colgroup>
          <thead className="data-head sticky top-10">
            <tr>
              <SortHeader
                label="Phrase"
                column="phrase"
                active={sortKey}
                dir={sortDir}
                onClick={toggleSort}
                align="left"
              />
              <SortHeader
                label="Role"
                column="role"
                active={sortKey}
                dir={sortDir}
                onClick={toggleSort}
                align="left"
              />
              <SortHeader
                label="Niche"
                column="niche"
                active={sortKey}
                dir={sortDir}
                onClick={toggleSort}
                align="right"
                tip="Local long-tail score 0-100. Higher = longer, more question-like, seen in more Google surfaces. Not search volume."
              />
              <SortHeader
                label="Links"
                column="links"
                active={sortKey}
                dir={sortDir}
                onClick={toggleSort}
                align="right"
                tip="How many live ranking URLs Qualify found. Default sort: most links, then highest niche."
              />
              <th className="w-10 px-1" />
            </tr>
          </thead>
          <tbody>
            {phrases.map((row) => {
              const cls = classForPhrase(row.phrase, row.class, blacklist);
              return (
              <tr
                key={row.phrase}
                className="hover:bg-[var(--color-hover)]"
                style={{ borderTop: "1px solid var(--color-border)" }}
              >
                <td className="px-5 py-2 align-top min-w-0">
                  <PhraseLinks phrase={row} locale={active.locale} />
                  {row.serp?.answer?.snippet && (
                    <div className="text-xs mt-0.5 truncate" style={{ color: "var(--color-text-secondary)" }} title={row.serp.answer.snippet}>
                      {row.serp.answer.snippet}
                    </div>
                  )}
                  {showLinks && (
                    <InlineRankingLinks
                      phrase={row}
                      sites={active.sites}
                    />
                  )}
                </td>
                <td className="px-2 py-2 align-top min-w-0">
                  <div
                    className="text-[11px] font-medium"
                    style={{ color: ROLE_TONE[cls.role] }}
                  >
                    {cls.role}
                  </div>
                </td>
                <td
                  className="px-2 py-2 text-right font-mono text-[13px] align-top cursor-help"
                  title="Long-tail score: words + question + source overlap + autocomplete relevance"
                >
                  {row.scores.niche}
                </td>
                <td className="px-3 py-2 align-top text-right min-w-0">
                  <RankingLinks phrase={row} />
                </td>
                <td className="px-1 py-2 align-top">
                  <button
                    type="button"
                    onClick={() => runRemove(row.phrase)}
                    className="p-1 rounded hover:bg-red-500/10"
                    style={{ color: "var(--color-muted)" }}
                    title={
                      row.sources.includes("manual")
                        ? "Remove this phrase"
                        : "Remove this phrase from the list (does not call Google)"
                    }
                  >
                    <X size={12} />
                  </button>
                </td>
              </tr>
              );
            })}
          </tbody>
        </table>
        )}
      </div>
    </main>
  );
}

function SnapshotStrip({
  snapshot,
}: {
  snapshot: ReturnType<typeof buildSearchSnapshot>;
}) {
  const mark =
    snapshot.productShare != null && snapshot.productShare >= 0.5
      ? "product-heavy"
      : snapshot.flags.find((flag) =>
          /AI overview|answer box|no SERP yet|qualify next/i.test(flag)
        ) ?? null;

  return (
    <div className="mt-3 min-w-0">
      <p className="lede">
        {mark && <span className="mark">{mark}</span>}
        {snapshot.headline}
      </p>
      <dl className="scoreboard">
        <div>
          <dt>write</dt>
          <dd>{snapshot.write}</dd>
        </div>
        <div>
          <dt>skip</dt>
          <dd data-hot={snapshot.skip > snapshot.write}>{snapshot.skip}</dd>
        </div>
        <div>
          <dt>qualified</dt>
          <dd>{snapshot.qualified}</dd>
        </div>
        <div>
          <dt>niche</dt>
          <dd>{snapshot.avgNiche ?? "-"}</dd>
        </div>
      </dl>
      {snapshot.topHosts.length > 0 && (
        <p className="hosts truncate">{snapshot.topHosts.join("  /  ")}</p>
      )}
    </div>
  );
}

function NeighborStrip({
  neighbors,
  searches,
  running,
  onOpen,
}: {
  neighbors: NonNullable<import("../../shared/phrases").SearchDocument["neighbors"]>;
  searches: import("../../shared/phrases").SearchSummary[];
  running: boolean;
  onOpen: (seed: string) => void;
}) {
  return (
    <div className="mt-3 min-w-0">
      <div className="ctrl-label mb-1.5">Next searches</div>
      <ul className="space-y-1">
        {neighbors.map((row) => {
          const existing =
            (row.searchId && searches.find((item) => item.id === row.searchId)) ||
            findSearchForSeed(searches, row.seed);
          return (
            <li key={row.seed} className="flex items-baseline gap-2 min-w-0">
              {existing ? (
                <Link
                  to="/searches/$searchId"
                  params={{ searchId: existing.id }}
                  className="btn btn-quiet h-6 px-1.5 text-xs shrink-0"
                  title={`Open ${existing.name}`}
                >
                  Open
                </Link>
              ) : (
              <button
                type="button"
                className="btn btn-quiet h-6 px-1.5 text-xs shrink-0"
                disabled={running}
                onClick={() => onOpen(row.seed)}
                title="Run this as a linked search (SerpAPI)"
              >
                Search
              </button>
              )}
              <span className="text-sm font-medium truncate">{row.seed}</span>
              {row.why && (
                <span
                  className="text-xs truncate"
                  style={{ color: "var(--color-muted)" }}
                >
                  {row.why}
                </span>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function PhraseLinks({
  phrase,
  locale,
}: {
  phrase: PhraseRecord;
  locale: Locale;
}) {
  const google = googleSearchUrl(phrase.phrase, locale);
  const serp = useSerpapiUrl(phrase.serp?.searchId);
  return (
    <div className="min-w-0 truncate">
      <a
        href={google}
        target="_blank"
        rel="noreferrer"
        className="font-medium hover:underline"
        title={`${phrase.phrase} - Google`}
      >
        {phrase.phrase}
      </a>
      {serp && (
        <>
          {" "}
          <a
            href={serp}
            target="_blank"
            rel="noreferrer"
            className="text-[10px] hover:underline"
            style={{ color: "var(--color-muted)" }}
            title="Open this phrase on SerpAPI"
          >
            serp
          </a>
        </>
      )}
    </div>
  );
}

function InlineRankingLinks({
  phrase,
  sites,
}: {
  phrase: PhraseRecord;
  sites?: Record<string, SiteMeta>;
}) {
  const organics = phrase.serp?.organics ?? [];
  if (!organics.length) return null;
  return (
    <ul className="mt-1 space-y-0.5 text-xs min-w-0">
      {organics.slice(0, 5).map((organic) => {
        const meta = siteFor(organic.link, sites);
        const label = meta?.title || organic.title;
        return (
          <li key={organic.link} className="truncate">
            <a
              href={organic.link}
              target="_blank"
              rel="noreferrer"
              className="text-runny-accent hover:underline"
              title={meta?.description || organic.link}
            >
              {organic.position}. {label}
            </a>
          </li>
        );
      })}
    </ul>
  );
}

function RankingLinks({ phrase }: { phrase: PhraseRecord }) {
  const organics = phrase.serp?.organics ?? [];
  const serp = useSerpapiUrl(phrase.serp?.searchId);
  if (!organics.length && !serp) {
    return <span className="tabular-nums text-xs">0</span>;
  }
  const tip = organics
    .slice(0, 5)
    .map((row) => `${row.position}. ${row.title}`)
    .join("\n");
  return (
    <div className="text-xs truncate">
      <span className="tabular-nums">{organics.length}</span>
      {serp && (
        <>
          {" "}
          <a
            href={serp}
            target="_blank"
            rel="noreferrer"
            className="text-runny-accent hover:underline"
            title={tip || "Open SerpAPI search result"}
          >
            serp
          </a>
        </>
      )}
    </div>
  );
}

function SortHeader({
  label,
  column,
  active,
  dir,
  onClick,
  align,
  tip,
}: {
  label: string;
  column: SortKey;
  active: SortKey;
  dir: "asc" | "desc";
  onClick: (key: SortKey) => void;
  align: "left" | "right";
  tip?: string;
}) {
  const selected = active === column;
  return (
    <th
      className={`font-medium px-3 py-2 ${align === "right" ? "text-right" : "text-left"} ${column === "phrase" ? "px-5" : ""} ${column === "links" ? "px-5" : ""}`}
      title={tip}
    >
      <button
        type="button"
        onClick={() => onClick(column)}
        className="inline-flex items-center gap-1 hover:text-runny-accent"
        style={{ color: selected ? "var(--color-accent)" : "inherit" }}
      >
        {label}
        {selected ? (
          dir === "asc" ? <ArrowUp size={11} /> : <ArrowDown size={11} />
        ) : null}
      </button>
    </th>
  );
}

function RankingView({
  kind,
  rows,
  empty,
}: {
  kind: "social" | "apps";
  rows: RankingLeaf[];
  empty: string;
}) {
  if (!rows.length) {
    return (
      <div className="px-5 py-8 text-sm" style={{ color: "var(--color-muted)" }}>
        {empty}
      </div>
    );
  }
  return (
    <table className="w-full text-sm table-fixed">
      <colgroup>
        <col className="w-24" />
        <col className="w-[36%]" />
        <col />
        <col className="w-14" />
      </colgroup>
      <thead className="data-head sticky top-10">
        <tr>
          <th className="font-medium px-4 py-2 text-left">
            {kind === "social" ? "Network" : "Store"}
          </th>
          <th className="font-medium px-2 py-2 text-left">Title</th>
          <th className="font-medium px-2 py-2 text-left">Via</th>
          <th className="font-medium px-3 py-2 text-right">Pos</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.link} style={{ borderTop: "1px solid var(--color-border)" }}>
            <td className="px-4 py-1.5 text-xs align-middle">{row.network}</td>
            <td className="px-2 py-1.5 align-middle min-w-0">
              <a
                href={row.link}
                target="_blank"
                rel="noreferrer"
                className="text-runny-accent hover:underline block truncate"
                title={row.snippet || row.link}
              >
                {row.title}
              </a>
            </td>
            <td
              className="px-2 py-1.5 text-xs align-middle truncate"
              style={{ color: "var(--color-muted)" }}
              title={row.phrases.join(", ")}
            >
              {row.phrases[0] || row.host}
            </td>
            <td className="px-3 py-1.5 text-right tabular-nums text-xs align-middle">
              {row.position ?? "—"}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function ReportView({
  report,
  loading,
  error,
  running,
  onGenerate,
}: {
  report?: ReportOutput;
  loading: boolean;
  error?: string;
  running: boolean;
  onGenerate: () => Promise<void>;
}) {
  if (loading) {
    return (
      <div className="px-5 py-8 text-sm" style={{ color: "var(--color-muted)" }}>
        Loading report…
      </div>
    );
  }

  if (!report?.exists || !report.markdown) {
    return (
      <div className="px-5 py-12 flex justify-center">
        <div
          className="max-w-md w-full p-5 text-center"
          style={{
            background: "var(--color-surface)",
            border: "1px solid var(--color-border)",
            borderRadius: 4,
          }}
        >
          <h2 className="font-semibold">No report generated</h2>
          <p className="text-sm mt-1 mb-4" style={{ color: "var(--color-muted)" }}>
            Generate the intelligence package to preview its Markdown report here.
          </p>
          {error && (
            <p className="text-xs mb-3" style={{ color: "var(--color-danger)" }}>
              {error}
            </p>
          )}
          <button
            type="button"
            className="btn btn-primary"
            disabled={running}
            onClick={() => void onGenerate()}
          >
            {running ? "Generating…" : "Generate report"}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div>
      <div
        className="px-5 py-2 text-xs font-mono truncate"
        title={report.report}
        style={{
          color: "var(--color-muted)",
          background: "var(--color-panel)",
          borderBottom: "1px solid var(--color-border)",
        }}
      >
        {report.report}
      </div>
      <MarkdownRenderer content={report.markdown} />
    </div>
  );
}

function SitesView({ sites }: { sites: Record<string, SiteMeta> }) {
  const rows = Object.values(sites).sort((a, b) =>
    (a.title || a.url).localeCompare(b.title || b.url)
  );
  if (!rows.length) {
    return (
      <div className="px-5 py-8 text-sm" style={{ color: "var(--color-muted)" }}>
        No site meta yet. Qualify phrases, then Enrich.
      </div>
    );
  }
  return (
    <table className="w-full text-sm table-fixed">
      <colgroup>
        <col className="w-[38%]" />
        <col />
        <col className="w-14" />
      </colgroup>
      <thead className="data-head sticky top-10">
        <tr>
          <th className="font-medium px-4 py-2 text-left">Site</th>
          <th className="font-medium px-2 py-2 text-left">Description</th>
          <th className="font-medium px-3 py-2 text-right">ms</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((site) => (
          <tr key={site.url} style={{ borderTop: "1px solid var(--color-border)" }}>
            <td className="px-4 py-1.5 align-middle min-w-0">
              <a
                href={site.finalUrl || site.url}
                target="_blank"
                rel="noreferrer"
                className="text-runny-accent hover:underline block truncate"
                title={site.url}
              >
                {site.title || site.siteName || site.url}
              </a>
            </td>
            <td
              className="px-2 py-1.5 align-middle text-xs min-w-0 truncate"
              style={{ color: site.error ? "#f59e0b" : "var(--color-text-secondary)" }}
              title={site.error || site.description || site.url}
            >
              {site.error || site.description || "-"}
            </td>
            <td className="px-3 py-1.5 text-right tabular-nums align-middle text-xs">
              {site.fromCache ? "cache" : site.ms}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function PlanView({
  phrases,
  landscape,
  sites,
  locale,
  blacklist,
}: {
  phrases: PhraseRecord[];
  landscape: import("../../shared/phrases").SerpLandscape[];
  sites?: Record<string, SiteMeta>;
  locale: Locale;
  blacklist: readonly string[];
}) {
  const landscapeSerp = useSerpapiUrl(landscape[0]?.searchId);
  const groups = groupArticles(
    phrases.map((row) => ({
      ...row,
      class: classForPhrase(row.phrase, row.class, blacklist),
    }))
  );
  return (
    <div className="px-5 py-4 space-y-8 max-w-4xl">
      {landscape[0] && (
        <section>
          <h2 className="text-[15px] font-semibold tracking-tight mb-2">
            Who already ranks
          </h2>
          <p className="text-xs mb-3" style={{ color: "var(--color-muted)" }}>
            <a
              href={googleSearchUrl(landscape[0].query, locale)}
              target="_blank"
              rel="noreferrer"
              className="text-runny-accent hover:underline"
            >
              {landscape[0].query}
            </a>
            {landscapeSerp && (
              <>
                {" / "}
                <a
                  href={landscapeSerp}
                  target="_blank"
                  rel="noreferrer"
                  className="hover:underline"
                >
                  SerpAPI
                </a>
              </>
            )}
            {landscape[0].features.length
              ? ` / ${landscape[0].features.join(", ")}`
              : ""}
          </p>
          <ol className="space-y-2 text-sm">
            {landscape[0].organics.slice(0, 8).map((row) => (
              <li key={row.link} className="flex gap-3">
                <span className="tabular-nums" style={{ color: "var(--color-muted)" }}>
                  {row.position}
                </span>
                <div className="min-w-0">
                  <a
                    href={row.link}
                    target="_blank"
                    rel="noreferrer"
                    className="text-runny-accent hover:underline"
                  >
                    {row.title}
                  </a>
                  <div className="text-xs truncate" style={{ color: "var(--color-muted)" }}>
                    {siteFor(row.link, sites)?.siteName || row.source || row.link}
                  </div>
                  {siteFor(row.link, sites)?.description && (
                    <div className="text-xs mt-0.5" style={{ color: "var(--color-text-secondary)" }}>
                      {siteFor(row.link, sites)?.description}
                    </div>
                  )}
                </div>
              </li>
            ))}
          </ol>
        </section>
      )}
      {groups.map((group) => (
        <section key={group.role}>
          <h2 className="text-[15px] font-semibold tracking-tight mb-2">
            {group.title}
          </h2>
          <div className="space-y-4">
            {group.phrases.map((row) => {
              const cls = classForPhrase(row.phrase, row.class, blacklist);
              return (
                <article
                  key={row.phrase}
                  className="pb-3"
                  style={{ borderBottom: "1px solid var(--color-border)" }}
                >
                  <PhraseLinks phrase={row} locale={locale} />
                  <div className="text-xs mt-0.5" style={{ color: "var(--color-muted)" }}>
                    {cls.intent} / {cls.reason}
                  </div>
                  {row.serp?.answer?.snippet && (
                    <p className="text-sm mt-2" style={{ color: "var(--color-text-secondary)" }}>
                      {row.serp.answer.snippet}
                      {row.serp.answer.link && (
                        <>
                          {" "}
                          <a
                            href={row.serp.answer.link}
                            target="_blank"
                            rel="noreferrer"
                            className="text-runny-accent hover:underline"
                          >
                            {row.serp.answer.title || "source"}
                          </a>
                        </>
                      )}
                    </p>
                  )}
                  {row.serp?.organics && row.serp.organics.length > 0 && (
                    <ul className="mt-2 space-y-1 text-xs">
                      {row.serp.organics.slice(0, 3).map((organic) => {
                        const meta = siteFor(organic.link, sites);
                        return (
                        <li key={organic.link}>
                          <a
                            href={organic.link}
                            target="_blank"
                            rel="noreferrer"
                            className="text-runny-accent hover:underline"
                          >
                            {organic.position}. {organic.title}
                          </a>
                          {meta?.description && (
                            <div style={{ color: "var(--color-muted)" }}>
                              {meta.description}
                            </div>
                          )}
                        </li>
                        );
                      })}
                    </ul>
                  )}
                </article>
              );
            })}
          </div>
        </section>
      ))}
    </div>
  );
}
