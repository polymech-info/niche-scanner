import React, { useEffect, useMemo, useState } from "react";
import { Link } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { ExternalLink, Map as MapIcon, RefreshCw, Trash2 } from "lucide-react";
import type {
  ProductJob,
  ProductPlan,
  ProductPlanChapter,
} from "../../shared/product-plan";
import type { Locale, OrganicResult, PhraseRecord } from "../../shared/phrases";
import type { RankingLeaf } from "../../shared/ranking";
import { googleSearchUrl } from "../../shared/links";
import { MarkdownRenderer } from "./MarkdownRenderer";
import { deleteProductPlan, renderProductPlan, runProductPlan } from "../lib/api";
import { keys, useCapabilities, useConfig, useProductPlan } from "../lib/query";
import { useStore } from "../store/app";
import {
  CatalogDetailHead,
  CatalogFacts,
  CatalogFound,
  CatalogWorkbench,
  type CatalogGroup,
} from "./CatalogWorkbench";

const SAMPLE_JOBS = [
  "job:workflow:video-recorder",
  "job:documentation:feature-markdown",
];

const KIND_ORDER: ProductJob["proofKind"][] = [
  "documentation",
  "workflow",
  "command",
];

const KIND_LABEL: Record<ProductJob["proofKind"], string> = {
  documentation: "Features",
  workflow: "Workflows",
  command: "Commands",
};

function jobsFromPlan(plan: ProductPlan | null | undefined): string[] {
  if (!plan) return [];
  return [...plan.chapters, ...plan.appendix].map((chapter) => chapter.jobId);
}

function chapterMap(plan: ProductPlan | null): Map<string, ProductPlanChapter> {
  const map = new Map<string, ProductPlanChapter>();
  if (!plan) return map;
  for (const row of [...plan.chapters, ...plan.appendix]) {
    if (!map.has(row.jobId)) map.set(row.jobId, row);
  }
  return map;
}

function jobBadge(chapter?: ProductPlanChapter): string | undefined {
  if (!chapter) return;
  if (chapter.phrases.length) return String(chapter.phrases.length);
  return chapter.action;
}

export function ProductPlanPanel() {
  const client = useQueryClient();
  const grounding = useCapabilities();
  const config = useConfig().data;
  const saved = useProductPlan();
  const setRunning = useStore((state) => state.setRunning);
  const setError = useStore((state) => state.setError);
  const running = useStore((state) => state.running);
  const runState = saved.data?.run;
  const live = running || runState?.status === "running";
  const logRef = React.useRef<HTMLDivElement>(null);
  const jobs = grounding.data?.jobs ?? [];
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [seeded, setSeeded] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [serpBudget, setSerpBudget] = useState<2 | 4>(2);
  const [decide, setDecide] = useState(false);
  const [qualify, setQualify] = useState(false);
  const [enrich, setEnrich] = useState(false);
  const [force, setForce] = useState(false);
  const plan = saved.data?.plan ?? null;
  const markdown = saved.data?.markdown ?? "";
  const outDir = saved.data?.outDir ?? "";
  const events = runState?.events ?? [];
  const chapters = useMemo(() => chapterMap(plan), [plan]);
  const locale = config?.locale;

  useEffect(() => {
    const node = logRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [events.length, live, selectedId]);

  useEffect(() => {
    if (seeded || grounding.isPending || saved.isPending) return;
    const fromPlan = jobsFromPlan(plan).filter((id) =>
      jobs.some((job) => job.id === id)
    );
    const sample = SAMPLE_JOBS.filter((id) => jobs.some((job) => job.id === id));
    const next = new Set(fromPlan.length ? fromPlan : sample);
    setChecked(next);
    setSelectedId(
      [...next][0] ?? jobs[0]?.id ?? (plan ? "plan:report" : "g:documentation")
    );
    setSeeded(true);
  }, [grounding.isPending, jobs, plan, saved.isPending, seeded]);

  const groups: CatalogGroup[] = useMemo(() => {
    const byKind: Record<ProductJob["proofKind"], ProductJob[]> = {
      documentation: [],
      workflow: [],
      command: [],
    };
    for (const job of jobs) byKind[job.proofKind].push(job);
    const jobGroups = KIND_ORDER.filter((kind) => byKind[kind].length).map(
      (kind) => {
        const rows = byKind[kind];
        const selectedCount = rows.filter((job) => checked.has(job.id)).length;
        return {
          id: `g:${kind}`,
          label: KIND_LABEL[kind],
          enabled: selectedCount === rows.length,
          indeterminate: selectedCount > 0 && selectedCount < rows.length,
          count: rows.length,
          searchText: kind,
          items: rows.map((job) => {
            const chapter = chapters.get(job.id);
            return {
              id: job.id,
              label: job.label,
              enabled: checked.has(job.id),
              muted: !checked.has(job.id),
              badge: jobBadge(chapter),
              searchText: [job.id, job.proofKind, ...job.terms, ...job.proofIds].join(
                " "
              ),
            };
          }),
        };
      }
    );
    const planItems = [];
    if (plan) {
      planItems.push({
        id: "plan:report",
        label: "Report",
        searchText: markdown,
      });
      if (plan.productHoles.length) {
        planItems.push({
          id: "plan:holes",
          label: "Product holes",
          badge: String(plan.productHoles.length),
          searchText: plan.productHoles.join(" "),
        });
      }
    }
    if (events.length || live || runState?.error) {
      planItems.push({
        id: "plan:log",
        label: "Run log",
        badge: events.length ? String(events.length) : live ? "live" : undefined,
        searchText: events.map((event) => event.message).join(" "),
      });
    }
    if (!planItems.length) return jobGroups;
    return [
      {
        id: "g:plan",
        label: "Saved plan",
        count: planItems.length,
        searchText: "report holes log",
        items: planItems,
      },
      ...jobGroups,
    ];
  }, [chapters, checked, events, jobs, live, markdown, plan, runState?.error]);

  useEffect(() => {
    if (!selectedId) return;
    const stillThere = groups.some(
      (group) =>
        group.id === selectedId ||
        group.items.some((item) => item.id === selectedId)
    );
    if (stillThere) return;
    const first = groups[0]?.items[0]?.id || groups[0]?.id || null;
    if (first) setSelectedId(first);
  }, [groups, selectedId]);

  const selectedJob = jobs.find((job) => job.id === selectedId) ?? null;
  const selectedChapter = selectedId ? chapters.get(selectedId) : undefined;
  const selectedGroup = groups.find((group) => group.id === selectedId) ?? null;
  const selectedKind = selectedId?.startsWith("g:")
    ? (selectedId.slice(2) as ProductJob["proofKind"] | "plan")
    : selectedJob?.proofKind;

  const toggleJob = (id: string, enabled: boolean) => {
    setChecked((current) => {
      const next = new Set(current);
      if (enabled) next.add(id);
      else next.delete(id);
      return next;
    });
  };

  const toggleGroup = (id: string, enabled: boolean) => {
    const group = groups.find((row) => row.id === id);
    if (!group) return;
    setChecked((current) => {
      const next = new Set(current);
      for (const item of group.items) {
        if (item.enabled === undefined) continue;
        if (enabled) next.add(item.id);
        else next.delete(item.id);
      }
      return next;
    });
  };

  const run = async () => {
    if (!checked.size) return;
    setRunning(true);
    setError(null);
    try {
      const result = await runProductPlan({
        jobIds: [...checked],
        serpCallsPerJob: serpBudget,
        decide,
        qualify,
        enrich,
        forceDiscover: force,
        forceDecide: force && decide,
        forceQualify: force && qualify,
        forceEnrich: force && enrich,
      });
      client.setQueryData(keys.productPlan, result);
      setSelectedId((current) => current ?? [...checked][0] ?? "plan:report");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRunning(false);
    }
  };

  const rerender = async () => {
    setRunning(true);
    setError(null);
    try {
      const result = await renderProductPlan();
      client.setQueryData(keys.productPlan, result);
      setSelectedId("plan:report");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRunning(false);
    }
  };

  const remove = async (jobIds?: string[]) => {
    if (jobIds && !jobIds.length) return;
    setRunning(true);
    setError(null);
    try {
      const result = await deleteProductPlan(jobIds);
      client.setQueryData(keys.productPlan, result);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRunning(false);
    }
  };

  return (
    <main className="flex-1 min-w-0 min-h-0 flex flex-col overflow-hidden">
      <div className="shrink-0 px-5 pt-5 pb-3 md:px-8">
        <div className="flex items-start justify-between gap-6">
          <div className="min-w-0">
            <div
              className="flex items-center gap-2 text-xs mb-1"
              style={{ color: "var(--color-muted)" }}
            >
              <MapIcon size={13} />
              Product master plan
            </div>
            <h1 className="search-title">Map demand onto jobs</h1>
          </div>
          <Link to="/capabilities" className="btn btn-ghost shrink-0">
            Capabilities
          </Link>
        </div>
      </div>

      <div className="flex-1 min-h-0 px-5 pb-5 md:px-8 flex flex-col">
        <CatalogWorkbench
          groups={groups}
          selectedId={selectedId}
          onSelect={setSelectedId}
          onToggleItem={toggleJob}
          onToggleGroup={toggleGroup}
          searchPlaceholder="Filter features, workflows, commands"
          emptySearch="No jobs match."
          emptyTree={
            grounding.isError
              ? "No capability snapshot. Recapture it on Capabilities."
              : "No harvested jobs yet."
          }
          toolbar={
            <div className="catalog-toolbar">
              <label className="grid gap-1 w-[148px]">
                <span className="text-xs font-medium">SERP budget</span>
                <select
                  className="field"
                  value={serpBudget}
                  onChange={(event) =>
                    setSerpBudget(Number(event.target.value) as 2 | 4)
                  }
                >
                  <option value={2}>2 · autocomplete</option>
                  <option value={4}>4 · + landscape</option>
                </select>
              </label>
              <label className="flex items-center gap-1.5 text-sm h-[38px] self-end">
                <input
                  type="checkbox"
                  checked={force}
                  onChange={(event) => setForce(event.target.checked)}
                />
                Ignore cache
              </label>
              <div className="flex flex-wrap items-center gap-1.5 ml-auto self-end">
                <button
                  type="button"
                  className="pill"
                  data-on={decide}
                  disabled={live}
                  title="LLM pass: pillar / section / skip"
                  onClick={() => setDecide((on) => !on)}
                >
                  Decide
                </button>
                <button
                  type="button"
                  className="pill"
                  data-on={qualify}
                  disabled={live}
                  title="Google + AI overview for pillar chapters"
                  onClick={() => setQualify((on) => !on)}
                >
                  Qualify
                </button>
                <button
                  type="button"
                  className="pill"
                  data-on={enrich}
                  disabled={live}
                  title="Fetch ranking-page meta for qualified pillars"
                  onClick={() => setEnrich((on) => !on)}
                >
                  Enrich
                </button>
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={live || !checked.size}
                  onClick={() => void run()}
                >
                  {live ? "Running…" : `Run ${checked.size}`}
                </button>
              </div>
            </div>
          }
          treeMeta={
            <>
              <strong>Jobs</strong>
              <span>
                {checked.size}/{jobs.length}
                {plan ? ` · ${plan.metrics.phrases} found` : ""}
              </span>
            </>
          }
          treeToolbar={
            <>
              <button
                type="button"
                className="btn btn-quiet"
                onClick={() =>
                  setChecked(
                    new Set(
                      SAMPLE_JOBS.filter((id) => jobs.some((job) => job.id === id))
                    )
                  )
                }
              >
                Sample
              </button>
              <button
                type="button"
                className="btn btn-quiet"
                onClick={() => setChecked(new Set(jobs.map((job) => job.id)))}
              >
                All
              </button>
              <button
                type="button"
                className="btn btn-quiet"
                onClick={() => setChecked(new Set())}
              >
                Clear
              </button>
              <button
                type="button"
                className="btn btn-quiet"
                disabled={live || !checked.size}
                title="Drop checked jobs from the saved plan and their caches"
                onClick={() => void remove([...checked])}
              >
                <Trash2 size={13} />
                Parts
              </button>
              <button
                type="button"
                className="btn btn-quiet"
                disabled={live || !plan}
                title="Delete product-plan.json, markdown, and .cache"
                onClick={() => void remove()}
              >
                <Trash2 size={13} />
                Plan
              </button>
              <button
                type="button"
                className="btn btn-quiet"
                disabled={live}
                onClick={() => void saved.refetch()}
              >
                Reload
              </button>
            </>
          }
          detail={
            selectedId === "plan:report" && plan ? (
              <div className="flex min-h-0 flex-1 flex-col gap-3">
                <CatalogDetailHead parent="Saved plan" name="Report">
                  <button
                    type="button"
                    className="btn btn-quiet"
                    disabled={live}
                    onClick={() => void rerender()}
                  >
                    <RefreshCw size={13} />
                    Render
                  </button>
                </CatalogDetailHead>
                <MarkdownRenderer content={markdown || "_No report yet._"} />
              </div>
            ) : selectedId === "plan:holes" && plan ? (
              <div className="flex min-h-0 flex-1 flex-col gap-3">
                <CatalogDetailHead parent="Saved plan" name="Product holes" />
                <CatalogFound label="Unmatched demand" count={plan.productHoles.length}>
                  <ul className="grid gap-1 text-sm">
                    {plan.productHoles.map((phrase, index) => (
                      <li key={`${phrase}-${index}`}>{phrase}</li>
                    ))}
                  </ul>
                </CatalogFound>
              </div>
            ) : selectedId === "plan:log" ? (
              <div className="flex min-h-0 flex-1 flex-col gap-3">
                <CatalogDetailHead parent="Saved plan" name="Run log" />
                <CatalogFacts
                  rows={[
                    outDir && { label: "Out", value: <code className="text-xs break-all">{outDir}</code> },
                    {
                      label: "Status",
                      value: live
                        ? runState?.current
                          ? `${runState.current.stage}${
                              runState.current.label
                                ? ` · ${runState.current.label}`
                                : ""
                            }`
                          : "running"
                        : runState?.status ?? "idle",
                    },
                  ]}
                />
                {runState?.error ? (
                  <p className="m-0 text-sm" style={{ color: "var(--color-danger)" }}>
                    {runState.error}
                  </p>
                ) : null}
                <div
                  ref={logRef}
                  className="font-mono text-xs overflow-y-auto p-3"
                  style={{
                    maxHeight: "100%",
                    background: "var(--color-panel)",
                    border: "1px solid var(--color-border)",
                    borderRadius: 4,
                    whiteSpace: "pre-wrap",
                  }}
                >
                  {events.length ? (
                    events.map((event, index) => (
                      <div
                        key={`${event.at}-${index}`}
                        style={{
                          color:
                            event.level === "error"
                              ? "var(--color-danger)"
                              : event.level === "warn"
                                ? "var(--color-warning, #b45309)"
                                : "var(--color-muted)",
                        }}
                      >
                        {event.stage}
                        {event.jobId ? ` ${event.jobId}` : ""} — {event.message}
                      </div>
                    ))
                  ) : (
                    <span style={{ color: "var(--color-muted)" }}>No events yet.</span>
                  )}
                </div>
              </div>
            ) : selectedJob ? (
              <JobDetail
                job={selectedJob}
                chapter={selectedChapter}
                locale={locale}
                parent={KIND_LABEL[selectedJob.proofKind]}
              />
            ) : selectedGroup ? (
              <GroupDetail
                group={selectedGroup}
                jobs={
                  selectedKind && selectedKind !== "plan"
                    ? jobs.filter((job) => job.proofKind === selectedKind)
                    : []
                }
                chapters={chapters}
                onOpen={setSelectedId}
              />
            ) : (
              <p className="catalog-empty">
                Select a feature to see its detail and found data.
              </p>
            )
          }
        />
      </div>
    </main>
  );
}

function GroupDetail({
  group,
  jobs,
  chapters,
  onOpen,
}: {
  group: CatalogGroup;
  jobs: ProductJob[];
  chapters: Map<string, ProductPlanChapter>;
  onOpen: (id: string) => void;
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <CatalogDetailHead name={group.label} />
      <p className="m-0 text-sm" style={{ color: "var(--color-muted)" }}>
        {jobs.length
          ? "Select a feature in the tree for detail and found searches."
          : group.id === "g:plan"
            ? "Saved report, unmatched demand, and the latest run log."
            : "Nothing in this group."}
      </p>
      {jobs.length ? (
        <ul className="grid gap-1 text-sm">
          {jobs.map((job) => {
            const chapter = chapters.get(job.id);
            const organics = chapter?.evidence?.organics?.length ?? 0;
            return (
              <li key={job.id}>
                <button
                  type="button"
                  className="btn btn-quiet h-auto py-1 px-0 text-left font-medium"
                  onClick={() => onOpen(job.id)}
                >
                  {job.label}
                </button>
                <span className="text-xs ml-2" style={{ color: "var(--color-muted)" }}>
                  {chapter
                    ? `${chapter.phrases.length} searches${
                        chapter.social.length ? ` · ${chapter.social.length} social` : ""
                      }${organics ? ` · ${organics} ranking` : ""}`
                    : "not run"}
                </span>
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}

function JobDetail({
  job,
  chapter,
  locale,
  parent,
}: {
  job: ProductJob;
  chapter?: ProductPlanChapter;
  locale?: Locale;
  parent: string;
}) {
  const organics = chapter?.evidence?.organics ?? [];
  const sites = chapter?.sites ?? [];
  const overview = chapter?.evidence?.aiOverview;
  const hint = chapter ? stepHint(chapter) : "Check this job and Run to collect searches.";
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <CatalogDetailHead parent={parent} name={job.label}>
        {chapter ? (
          <>
            <span className="pill">{chapter.action}</span>
            <span className="pill">{chapter.fit}</span>
            {chapter.qualified ? (
              <span className="pill" data-on="true">
                qualified
              </span>
            ) : null}
          </>
        ) : (
          <span className="pill">{job.proofKind}</span>
        )}
      </CatalogDetailHead>
      <CatalogFacts
        rows={[
          {
            label: "Id",
            value: <code className="text-xs break-all">{job.id}</code>,
          },
          chapter?.canonicalQuery && {
            label: "Query",
            value: (
              <a
                href={googleSearchUrl(chapter.canonicalQuery, locale)}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1"
              >
                {chapter.canonicalQuery}
                <ExternalLink size={12} />
              </a>
            ),
          },
          job.proofIds.length > 0 && {
            label: "Proof",
            value: job.proofIds.join(", "),
          },
          job.terms.length > 0 && {
            label: "Terms",
            value: job.terms.join(", "),
          },
          chapter?.gap && {
            label: "Gap",
            value: chapter.gap,
          },
        ]}
      />
      {hint ? <p className="catalog-empty" style={{ padding: 0 }}>{hint}</p> : null}
      {chapter ? (
        <>
          <CatalogFound
            label="Searches"
            count={chapter.phrases.length}
            empty="Run this job to collect searches."
          >
            {chapter.phrases.length ? (
              <PhraseList rows={chapter.phrases} locale={locale} />
            ) : null}
          </CatalogFound>
          <CatalogFound
            label="Ranking"
            count={organics.length}
            empty="Qualify to pull ranking pages."
          >
            {organics.length ? <OrganicList rows={organics} /> : null}
          </CatalogFound>
          <CatalogFound
            label="Social"
            count={chapter.social.length}
            empty="Qualify pillars to collect social ranking links."
          >
            {chapter.social.length ? (
              <LeafList rows={chapter.social} label="" />
            ) : null}
          </CatalogFound>
          <CatalogFound
            label="App stores"
            count={chapter.apps.length}
            empty="Qualify pillars to collect app-store links."
          >
            {chapter.apps.length ? (
              <LeafList rows={chapter.apps} label="" />
            ) : null}
          </CatalogFound>
          <CatalogFound
            label="Pages"
            count={sites.length}
            empty="Enrich to fetch ranking-page titles."
          >
            {sites.length ? (
              <ul className="grid gap-1 text-sm">
                {sites.map((site) => (
                  <li key={site.url} className="min-w-0">
                    <a
                      href={site.url}
                      target="_blank"
                      rel="noreferrer"
                      className="hover:underline truncate block"
                    >
                      {site.title || site.url}
                    </a>
                  </li>
                ))}
              </ul>
            ) : null}
          </CatalogFound>
          {overview ? (
            <CatalogFound label="AI overview">
              <p className="m-0 text-sm whitespace-pre-wrap">{overview}</p>
            </CatalogFound>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

function stepHint(chapter: ProductPlanChapter): string | null {
  if (!chapter.phrases.length) return "Run this job to collect searches.";
  if (
    !chapter.qualified &&
    !chapter.social.length &&
    !chapter.evidence?.organics?.length
  ) {
    return "Qualify to pull ranking pages and social links.";
  }
  if (chapter.qualified && !chapter.sites.length) {
    return "Enrich to fetch ranking-page titles.";
  }
  return null;
}

function PhraseList({
  rows,
  locale,
}: {
  rows: PhraseRecord[];
  locale?: Locale;
}) {
  return (
    <ul className="grid gap-1 text-sm">
      {rows.map((row, index) => (
        <li key={`${row.phrase}-${index}`} className="min-w-0">
          <a
            href={googleSearchUrl(row.phrase, locale)}
            target="_blank"
            rel="noreferrer"
            className="hover:underline"
          >
            {row.phrase}
          </a>
          <span className="text-xs ml-2" style={{ color: "var(--color-muted)" }}>
            {row.sources.join(", ")}
          </span>
        </li>
      ))}
    </ul>
  );
}

function OrganicList({ rows }: { rows: OrganicResult[] }) {
  return (
    <ul className="grid gap-1 text-sm">
      {rows.map((row) => (
        <li key={row.link} className="min-w-0">
          <a
            href={row.link}
            target="_blank"
            rel="noreferrer"
            className="hover:underline truncate block"
          >
            {row.title}
          </a>
        </li>
      ))}
    </ul>
  );
}

function LeafList({ rows, label }: { rows: RankingLeaf[]; label: string }) {
  return (
    <div>
      {label ? (
        <div className="text-xs mb-1" style={{ color: "var(--color-muted)" }}>
          {label}
        </div>
      ) : null}
      <ul className="grid gap-1 text-sm">
        {rows.map((row) => (
          <li key={row.link} className="min-w-0 flex items-baseline gap-2">
            <span className="text-xs shrink-0" style={{ color: "var(--color-muted)" }}>
              {row.network}
            </span>
            <a
              href={row.link}
              target="_blank"
              rel="noreferrer"
              className="hover:underline truncate"
              title={row.snippet || row.link}
            >
              {row.title}
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}
