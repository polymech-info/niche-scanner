import React, { useEffect, useMemo, useState } from "react";
import { Link } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import {
  Braces,
  ChevronDown,
  ChevronUp,
  Copy,
  ExternalLink,
  Map as MapIcon,
  RefreshCw,
  Star,
  Trash2,
} from "lucide-react";
import type { ProductCapability } from "../../shared/capabilities";
import type {
  ProductJob,
  ProductPlan,
  ProductPlanChapter,
} from "../../shared/product-plan";
import { documentationIntentJobs, isCustomProductJob } from "../../shared/product-plan";
import type { Locale, PhraseRecord, SiteMeta } from "../../shared/phrases";
import { googleSearchUrl } from "../../shared/links";
import { hostOf } from "../../shared/sites";
import { MarkdownRenderer } from "./MarkdownRenderer";
import { deleteProductPlan, renderProductPlan, runProductPlan } from "../lib/api";
import { fetchUserConfig, saveUserConfig } from "../lib/user-config";
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
  intent: "Jobs",
};

function capabilityForJob(
  job: ProductJob | undefined,
  capabilities: ProductCapability[],
): ProductCapability | undefined {
  if (!job) return;
  return capabilities.find(
    (node) =>
      job.capabilityIds.includes(node.id) ||
      job.proofIds.some((proof) => proof.split("#")[0] === node.id) ||
      job.id === `job:${node.id}`
  );
}

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
  const [planFavourites, setPlanFavourites] = useState<string[]>([]);

  useEffect(() => {
    let cancelled = false;
    fetchUserConfig()
      .then((config) => {
        if (!cancelled) setPlanFavourites(config.planFavourites ?? []);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  async function togglePlanFavourite(jobId: string) {
    const current = await fetchUserConfig();
    const ids = new Set(current.planFavourites ?? []);
    if (ids.has(jobId)) ids.delete(jobId);
    else ids.add(jobId);
    const saved = await saveUserConfig({
      ...current,
      version: 1,
      planFavourites: [...ids],
    });
    setPlanFavourites(saved.planFavourites ?? [...ids]);
  }
  const runState = saved.data?.run;
  const live = running || runState?.status === "running";
  const logRef = React.useRef<HTMLDivElement>(null);
  const jobs = grounding.data?.jobs ?? [];
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [seeded, setSeeded] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [serpBudget, setSerpBudget] = useState<2 | 4>(2);
  const [expand, setExpand] = useState(false);
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
  const capabilities = grounding.data?.capabilities ?? [];
  const featureIntents = useMemo(() => {
    const map = new Map<string, ProductJob[]>();
    for (const job of jobs) {
      if (job.proofKind !== "documentation") continue;
      const cap = capabilities.find(
        (node) =>
          node.id ===
          (job.proofIds.find((proof) => proof.startsWith("documentation:")) ??
            job.id.replace(/^job:/, ""))
      );
      const intents = documentationIntentJobs(job, cap);
      if (intents.length >= 2) map.set(job.id, intents);
    }
    return map;
  }, [capabilities, jobs]);
  const visibleJobs = useMemo(() => {
    const extra = [...featureIntents.values()].flat();
    return [...jobs, ...extra];
  }, [featureIntents, jobs]);
  const checkableJobs = useMemo(
    () =>
      visibleJobs.filter(
        (job) => job.proofKind !== "documentation" || !featureIntents.has(job.id)
      ),
    [featureIntents, visibleJobs]
  );

  useEffect(() => {
    const node = logRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [events.length, live, selectedId]);

  useEffect(() => {
    if (seeded || grounding.isPending || saved.isPending) return;
    const fromPlan = jobsFromPlan(plan).filter((id) =>
      visibleJobs.some((job) => job.id === id)
    );
    const sample = SAMPLE_JOBS.filter((id) =>
      visibleJobs.some((job) => job.id === id)
    );
    const next = new Set(fromPlan.length ? fromPlan : sample);
    setChecked(next);
    setSelectedId(
      [...next][0] ?? visibleJobs[0]?.id ?? (plan ? "plan:report" : "g:documentation")
    );
    setSeeded(true);
  }, [grounding.isPending, plan, saved.isPending, seeded, visibleJobs]);

  const groups: CatalogGroup[] = useMemo(() => {
    const byKind: Record<ProductJob["proofKind"], ProductJob[]> = {
      documentation: [],
      workflow: [],
      command: [],
      intent: [],
    };
    const customJobs = jobs.filter(isCustomProductJob);
    for (const job of jobs) {
      if (isCustomProductJob(job)) continue;
      if (job.proofKind === "documentation" && featureIntents.has(job.id)) continue;
      byKind[job.proofKind].push(job);
    }
    const customGroup: CatalogGroup | null = customJobs.length
      ? {
          id: "g:custom",
          label: "Custom",
          enabled: customJobs.every((job) => checked.has(job.id)),
          indeterminate:
            customJobs.some((job) => checked.has(job.id)) &&
            customJobs.some((job) => !checked.has(job.id)),
          count: customJobs.length,
          searchText: "custom overlay ribbon commands",
          items: customJobs.map((job) => {
            const chapter = chapters.get(job.id);
            return {
              id: job.id,
              label: job.label,
              enabled: checked.has(job.id),
              muted: !checked.has(job.id),
              badge: "custom",
              searchText: [job.id, job.proofKind, ...job.terms, ...job.proofIds].join(
                " "
              ),
            };
          }),
        }
      : null;
    const featureGroups: CatalogGroup[] = [...featureIntents.entries()].map(
      ([parentId, intents]) => {
        const parent = jobs.find((job) => job.id === parentId);
        const selectedCount = intents.filter((job) => checked.has(job.id)).length;
        return {
          id: parentId,
          label: parent?.label ?? parentId,
          enabled: selectedCount === intents.length,
          indeterminate: selectedCount > 0 && selectedCount < intents.length,
          count: intents.length,
          searchText: [parentId, parent?.label, ...intents.map((job) => job.label)].join(
            " "
          ),
          items: intents.map((job) => {
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
    const rest = [
      ...(customGroup ? [customGroup] : []),
      ...featureGroups,
      ...jobGroups,
    ];
    if (!planItems.length) return rest;
    return [
      {
        id: "g:plan",
        label: "Saved plan",
        count: planItems.length,
        searchText: "report holes log",
        items: planItems,
      },
      ...rest,
    ];
  }, [
    chapters,
    checked,
    events,
    featureIntents,
    jobs,
    live,
    markdown,
    plan,
    runState?.error,
  ]);

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

  const selectedJob =
    selectedId && featureIntents.has(selectedId)
      ? null
      : visibleJobs.find((job) => job.id === selectedId) ?? null;
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
        expand,
        decide,
        qualify,
        enrich,
        forceDiscover: force,
        forceExpand: force && expand,
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
          treeId="plan"
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
                  data-on={expand}
                  disabled={live}
                  title="LLM fill of documented job seeds before SERP"
                  onClick={() => setExpand((on) => !on)}
                >
                  Expand
                </button>
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
                {checked.size}/{checkableJobs.length}
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
                onClick={() =>
                  setChecked(new Set(checkableJobs.map((job) => job.id)))
                }
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
                favourite={planFavourites.includes(selectedJob.id)}
                onToggleFavourite={() => {
                  void togglePlanFavourite(selectedJob.id).catch((err) => {
                    setError(err instanceof Error ? err.message : String(err));
                  });
                }}
                capability={capabilityForJob(selectedJob, capabilities)}
                parent={
                  selectedJob.parentId
                    ? jobs.find((job) => job.id === selectedJob.parentId)?.label ??
                      KIND_LABEL[selectedJob.proofKind]
                    : isCustomProductJob(selectedJob)
                      ? "Custom"
                      : KIND_LABEL[selectedJob.proofKind]
                }
              />
            ) : selectedGroup ? (
              <GroupDetail
                group={selectedGroup}
                jobs={
                  featureIntents.get(selectedGroup.id) ??
                  (selectedGroup.id === "g:custom"
                    ? jobs.filter(isCustomProductJob)
                    : selectedKind && selectedKind !== "plan"
                      ? jobs.filter(
                          (job) =>
                            job.proofKind === selectedKind &&
                            !isCustomProductJob(job)
                        )
                      : [])
                }
                chapters={chapters}
                capability={capabilityForJob(
                  jobs.find((job) => job.id === selectedGroup.id),
                  capabilities
                )}
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
  capability,
  onOpen,
}: {
  group: CatalogGroup;
  jobs: ProductJob[];
  chapters: Map<string, ProductPlanChapter>;
  capability?: ProductCapability;
  onOpen: (id: string) => void;
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <CatalogDetailHead name={group.label}>
        {capability ? <span className="pill">{capability.kind}</span> : null}
      </CatalogDetailHead>
      {capability?.description ? (
        <p className="m-0 text-sm whitespace-pre-wrap max-w-[62ch]">
          {capability.description}
        </p>
      ) : null}
      {capability?.terms.length ? (
        <CatalogFacts
          rows={[{ label: "Terms", value: capability.terms.join(", ") }]}
        />
      ) : null}
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

function pageSnippet(site: SiteMeta): string | undefined {
  const parts = [site.description, site.excerpt].filter(
    (part): part is string => Boolean(part?.trim()),
  );
  const unique = [...new Set(parts)];
  if (unique.length) return unique.join("\n\n");
  return site.error;
}

function chapterNiche(chapter: ProductPlanChapter): number {
  const fromPhrases = chapter.phrases.reduce(
    (max, row) => Math.max(max, row.scores?.niche ?? 0),
    0,
  );
  return Math.max(chapter.demandScore ?? 0, fromPhrases);
}

function chapterDepth(chapter: ProductPlanChapter): number {
  const niche = chapterNiche(chapter);
  const questions = chapter.phrases.filter((row) => row.scores?.isQuestion).length;
  const ranking =
    (chapter.evidence?.organics.length ?? 0) +
    chapter.sites.length +
    chapter.social.length +
    chapter.apps.length;
  return Math.min(
    100,
    Math.round(
      niche * 0.45 +
        Math.min(1, Math.max(0, chapter.demand)) * 35 +
        Math.min(15, questions * 3) +
        Math.min(10, ranking),
    ),
  );
}

function mdLink(title: string, url: string): string {
  const safe = title.replace(/\[/g, "\\[").replace(/\]/g, "\\]");
  return `[${safe}](${url})`;
}

function chapterMarkdown(chapter: ProductPlanChapter): string {
  const lines = [
    `# ${chapter.label}`,
    "",
    `- **Action:** ${chapter.action}`,
    `- **Fit:** ${chapter.fit}`,
    `- **Niche:** ${chapterNiche(chapter)}`,
    `- **Depth:** ${chapterDepth(chapter)}`,
    `- **Qualified:** ${chapter.qualified ? "yes" : "no"}`,
    `- **Demand:** ${Math.round(chapter.demand * 100)}%`,
    `- **Query:** ${chapter.canonicalQuery}`,
    `- **Job:** \`${chapter.jobId}\``,
    "",
  ];
  if (chapter.gap) lines.push(chapter.gap, "");
  if (chapter.phrases.length) {
    lines.push("## Searches", "");
    for (const row of chapter.phrases) {
      lines.push(`- ${row.phrase} _(niche ${row.scores.niche})_`);
    }
    lines.push("");
  }
  const blocks: Array<[string, Array<{ title: string; link: string; snippet?: string; position?: number | null; host?: string; date?: string }>]> = [
    [
      "Ranking",
      (chapter.evidence?.organics ?? []).map((row) => ({
        title: row.title,
        link: row.link,
        snippet: row.snippet,
        position: row.position,
        date: row.date,
      })),
    ],
    ["Social", chapter.social],
    ["App stores", chapter.apps],
    [
      "Pages",
      chapter.sites.map((site) => ({
        title: site.title || site.url,
        link: site.url,
        snippet: pageSnippet(site),
        host: site.siteName,
      })),
    ],
  ];
  for (const [heading, rows] of blocks) {
    lines.push(`## ${heading}`, "");
    if (!rows.length) {
      lines.push("_None._", "");
      continue;
    }
    for (const row of rows) {
      const bits = [row.position != null ? `#${row.position}` : "", row.host, row.date]
        .filter(Boolean)
        .join(" · ");
      lines.push(`- ${mdLink(row.title || row.link, row.link)}${bits ? ` (${bits})` : ""}`);
      if (row.snippet) lines.push("", `  ${row.snippet}`, "");
    }
    lines.push("");
  }
  if (chapter.evidence?.aiOverview) {
    lines.push("## AI overview", "", chapter.evidence.aiOverview, "");
  }
  return lines.join("\n");
}

function chapterClipboardJson(chapter: ProductPlanChapter): string {
  return JSON.stringify(
    {
      ...chapter,
      niche: chapterNiche(chapter),
      depthScore: chapterDepth(chapter),
    },
    null,
    2,
  );
}

function ChapterActions({
  chapter,
  favourite,
  onToggleFavourite,
}: {
  chapter: ProductPlanChapter;
  favourite?: boolean;
  onToggleFavourite?: () => void;
}) {
  const [copied, setCopied] = useState<"md" | "json" | null>(null);

  async function copy(kind: "md" | "json") {
    const text = kind === "md" ? chapterMarkdown(chapter) : chapterClipboardJson(chapter);
    await navigator.clipboard.writeText(text);
    setCopied(kind);
    window.setTimeout(() => setCopied((current) => (current === kind ? null : current)), 1200);
  }

  return (
    <>
      <button
        type="button"
        className="btn btn-quiet h-6 px-2"
        data-on={favourite ? "true" : undefined}
        aria-pressed={favourite}
        title={favourite ? "Remove favourite" : "Favourite on the server"}
        onClick={onToggleFavourite}
      >
        <Star size={14} fill={favourite ? "currentColor" : "none"} />
        Favourite
      </button>
      <button
        type="button"
        className="btn btn-quiet h-6 px-2"
        title="Copy markdown"
        onClick={() => {
          void copy("md");
        }}
      >
        <Copy size={14} />
        {copied === "md" ? "Copied" : "Markdown"}
      </button>
      <button
        type="button"
        className="btn btn-quiet h-6 px-2"
        title="Copy JSON"
        onClick={() => {
          void copy("json");
        }}
      >
        <Braces size={14} />
        {copied === "json" ? "Copied" : "JSON"}
      </button>
    </>
  );
}

function JobDetail({
  job,
  chapter,
  locale,
  parent,
  capability,
  favourite,
  onToggleFavourite,
}: {
  job: ProductJob;
  chapter?: ProductPlanChapter;
  locale?: Locale;
  parent: string;
  capability?: ProductCapability;
  favourite?: boolean;
  onToggleFavourite?: () => void;
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
            <ChapterActions
              chapter={chapter}
              favourite={favourite}
              onToggleFavourite={onToggleFavourite}
            />
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
      {capability?.description ? (
        <p className="m-0 text-sm whitespace-pre-wrap max-w-[62ch]">
          {capability.description}
        </p>
      ) : null}
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
          (job.seeds ?? chapter?.seeds)?.length && {
            label: "Seeds",
            value: (job.seeds ?? chapter?.seeds ?? []).join(", "),
          },
          job.summary && {
            label: "Path",
            value: job.summary,
          },
          job.command && {
            label: "CLI",
            value: <code className="text-xs break-all">{job.command}</code>,
          },
          job.terms.length > 0 && {
            label: "Terms",
            value: job.terms.join(", "),
          },
          chapter?.gap && {
            label: "Gap",
            value: chapter.gap,
          },
          chapter && {
            label: "Niche",
            value: String(chapterNiche(chapter)),
          },
          chapter && {
            label: "Depth",
            value: (
              <span title="Derived from niche, demand, question phrases, and ranking links. The chapter record has no depthScore field.">
                {chapterDepth(chapter)}
              </span>
            ),
          },
          chapter && {
            label: "Qualified",
            value: chapter.qualified ? "yes" : "no",
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
          <RankingFound
            label="Ranking"
            empty="Qualify to pull ranking pages."
            rows={organics.map((row) => ({
              href: row.link,
              title: row.title,
              host: hostOf(row.link),
              position: row.position,
              date: row.date,
              extra: distinctLabel(row.source, hostOf(row.link)),
              snippet: row.snippet,
            }))}
          />
          <RankingFound
            label="Social"
            empty="Qualify pillars to collect social ranking links."
            rows={chapter.social.map((row) => ({
              href: row.link,
              title: row.title,
              host: row.host,
              position: row.position,
              date: row.date,
              extra: distinctLabel(row.source, row.host),
              snippet: row.snippet,
            }))}
          />
          <RankingFound
            label="App stores"
            empty="Qualify pillars to collect app-store links."
            rows={chapter.apps.map((row) => ({
              href: row.link,
              title: row.title,
              host: row.host,
              position: row.position,
              date: row.date,
              extra: distinctLabel(row.source, row.host),
              snippet: row.snippet,
            }))}
          />
          <CatalogFound
            label="Pages"
            count={sites.length}
            empty="Enrich to fetch ranking-page titles."
          >
            {sites.length ? (
              <ul className="found-list text-sm">
                {sites.map((site) => (
                  <FoundLink
                    key={site.url}
                    href={site.url}
                    title={site.title || site.url}
                    extra={site.siteName}
                    snippet={pageSnippet(site)}
                  />
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
    <ul className="found-list text-sm">
      {rows.map((row, index) => (
        <li key={`${row.phrase}-${index}`} className="found-row">
          <div className="found-row-meta">
            niche {row.scores.niche}
            {row.sources.length ? ` · ${row.sources.join(", ")}` : ""}
          </div>
          <a
            href={googleSearchUrl(row.phrase, locale)}
            target="_blank"
            rel="noreferrer"
            className="hover:underline"
          >
            {row.phrase}
          </a>
        </li>
      ))}
    </ul>
  );
}

function distinctLabel(label: string | undefined, host: string): string | undefined {
  if (!label) return;
  const needle = label.toLowerCase().replace(/[^a-z0-9]+/g, "");
  const hay = host.toLowerCase().replace(/[^a-z0-9]+/g, "");
  if (!needle || hay.includes(needle) || needle.includes(hay.replace(/com$/, ""))) {
    return;
  }
  return label;
}

function linkMeta(parts: Array<string | number | null | undefined>): string {
  return parts
    .map((part) => {
      if (part == null || part === "") return "";
      if (typeof part === "number") return `#${part}`;
      return String(part);
    })
    .filter(Boolean)
    .join(" · ");
}

function FoundLink({
  href,
  title,
  host,
  position,
  date,
  extra,
  snippet,
}: {
  href: string;
  title: string;
  host?: string;
  position?: number | null;
  date?: string;
  extra?: string;
  snippet?: string;
}) {
  const domain = (host || hostOf(href)).trim();
  const meta = linkMeta([position, domain, date, extra]);
  return (
    <li className="found-row">
      {meta ? <div className="found-row-meta">{meta}</div> : null}
      <a href={href} target="_blank" rel="noreferrer" className="hover:underline">
        {title || href}
      </a>
      {snippet ? <p className="found-snippet">{snippet}</p> : null}
    </li>
  );
}

type FoundSortKey = "date" | "domain" | "rank";

type FoundRow = {
  href: string;
  title: string;
  host?: string;
  position?: number | null;
  date?: string;
  extra?: string;
  snippet?: string;
};

const AGO_MS: Record<string, number> = {
  second: 1000,
  minute: 60_000,
  hour: 3_600_000,
  day: 86_400_000,
  week: 604_800_000,
  month: 2_592_000_000,
  year: 31_536_000_000,
};

function dateStamp(raw?: string): number {
  if (!raw) return 0;
  const text = raw.trim();
  const ago = /^(\d+)\s+(second|minute|hour|day|week|month|year)s?\s+ago$/i.exec(
    text,
  );
  if (ago) {
    return Date.now() - Number(ago[1]) * (AGO_MS[ago[2].toLowerCase()] ?? 0);
  }
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? parsed : 0;
}

function sortFound(
  rows: FoundRow[],
  key: FoundSortKey,
  dir: "asc" | "desc",
): FoundRow[] {
  const sign = dir === "asc" ? 1 : -1;
  return [...rows].sort((a, b) => {
    if (key === "rank") {
      const aMissing = a.position == null;
      const bMissing = b.position == null;
      if (aMissing !== bMissing) return aMissing ? 1 : -1;
      if (!aMissing && !bMissing && a.position !== b.position) {
        return (a.position! - b.position!) * sign;
      }
    } else if (key === "domain") {
      const ah = (a.host || hostOf(a.href)).toLowerCase();
      const bh = (b.host || hostOf(b.href)).toLowerCase();
      if (!ah !== !bh) return ah ? -1 : 1;
      const cmp = ah.localeCompare(bh, undefined, { sensitivity: "base" });
      if (cmp) return cmp * sign;
    } else {
      const ad = dateStamp(a.date);
      const bd = dateStamp(b.date);
      if (!ad !== !bd) return ad ? -1 : 1;
      if (ad !== bd) return (ad - bd) * sign;
    }
    const rank = (a.position ?? 999) - (b.position ?? 999);
    if (rank) return rank;
    return a.href.localeCompare(b.href);
  });
}

function FoundSort({
  active,
  dir,
  onToggle,
}: {
  active: FoundSortKey;
  dir: "asc" | "desc";
  onToggle: (key: FoundSortKey) => void;
}) {
  return (
    <>
      {(["date", "domain", "rank"] as const).map((key) => (
        <button
          key={key}
          type="button"
          className="pill"
          data-on={active === key ? "true" : undefined}
          aria-pressed={active === key}
          onClick={() => onToggle(key)}
        >
          {key === "date" ? "Date" : key === "domain" ? "Domain" : "Rank"}
          {active === key ? (
            dir === "asc" ? (
              <ChevronUp size={12} />
            ) : (
              <ChevronDown size={12} />
            )
          ) : null}
        </button>
      ))}
    </>
  );
}

function RankingFound({
  label,
  empty,
  rows,
}: {
  label: string;
  empty: string;
  rows: FoundRow[];
}) {
  const [key, setKey] = useState<FoundSortKey>("rank");
  const [dir, setDir] = useState<"asc" | "desc">("asc");
  const ordered = useMemo(() => sortFound(rows, key, dir), [rows, key, dir]);

  function toggle(next: FoundSortKey) {
    if (key === next) {
      setDir((current) => (current === "asc" ? "desc" : "asc"));
      return;
    }
    setKey(next);
    setDir(next === "date" ? "desc" : "asc");
  }

  return (
    <CatalogFound
      label={label}
      count={rows.length}
      empty={empty}
      actions={
        rows.length ? (
          <FoundSort active={key} dir={dir} onToggle={toggle} />
        ) : null
      }
    >
      {ordered.length ? (
        <ul className="found-list text-sm">
          {ordered.map((row) => (
            <FoundLink
              key={row.href}
              href={row.href}
              title={row.title}
              host={row.host}
              position={row.position}
              date={row.date}
              extra={row.extra}
              snippet={row.snippet}
            />
          ))}
        </ul>
      ) : null}
    </CatalogFound>
  );
}
