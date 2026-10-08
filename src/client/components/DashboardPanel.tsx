import React, { useEffect, useMemo, useState } from "react";
import { ArrowRight, ExternalLink, Home, Search, Trash2 } from "lucide-react";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import {
  createOpportunity,
  discardOpportunity,
  promoteOpportunity,
  type OpportunityRun,
} from "../lib/api";
import {
  keys,
  useConfig,
  useOpportunity,
  useSearchActions,
  useSearches,
} from "../lib/query";
import { useStore } from "../store/app";
import { googleSearchUrl, serpapiSearchUrl } from "../../shared/links";

function fitLabel(fit: OpportunityRun["productMatch"]["fit"]): string {
  return fit === "direct"
    ? "Direct capability"
    : fit === "composed"
      ? "Composed workflow"
      : fit === "editorial"
        ? "Editorial fit"
        : fit === "unsupported"
          ? "Unsupported"
          : "Unknown";
}

function expiresIn(iso: string): string {
  const minutes = Math.max(
    0,
    Math.ceil((new Date(iso).getTime() - Date.now()) / 60_000)
  );
  return minutes > 59 ? `${Math.ceil(minutes / 60)}h` : `${minutes}m`;
}

export function DashboardPanel() {
  const search = useSearch({ strict: false }) as { run?: string };
  const navigate = useNavigate();
  const client = useQueryClient();
  const config = useConfig().data;
  const searches = useSearches().data ?? [];
  const runQuery = useOpportunity(search.run);
  const { open } = useSearchActions();
  const setRunning = useStore((state) => state.setRunning);
  const setError = useStore((state) => state.setError);
  const [query, setQuery] = useState("");
  const [budget, setBudget] = useState(4);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [target, setTarget] = useState("new");
  const [name, setName] = useState("");
  const run = runQuery.data;

  useEffect(() => {
    if (!run) return;
    setSelected(new Set(run.candidates.slice(0, 8).map((row) => row.phrase)));
    setName(run.query);
  }, [run?.id]);

  const selectedCandidates = useMemo(
    () => run?.candidates.filter((row) => selected.has(row.phrase)) ?? [],
    [run, selected]
  );

  const start = async (event: React.FormEvent) => {
    event.preventDefault();
    setRunning(true);
    setError(null);
    try {
      const next = await createOpportunity({
        query,
        serpBudget: budget,
        locale: config?.locale,
      });
      client.setQueryData(keys.opportunity(next.id), next);
      await navigate({ to: "/", search: { run: next.id } });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRunning(false);
    }
  };

  const discard = async () => {
    if (!run) return;
    setRunning(true);
    setError(null);
    try {
      await discardOpportunity(run.id);
      client.removeQueries({ queryKey: keys.opportunity(run.id) });
      setSelected(new Set());
      await navigate({ to: "/", search: { run: undefined } });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRunning(false);
    }
  };

  const promote = async () => {
    if (!run || !selectedCandidates.length) return;
    setRunning(true);
    setError(null);
    try {
      const doc = await promoteOpportunity(run.id, {
        phrases: selectedCandidates.map((row) => row.phrase),
        name: target === "new" ? name : undefined,
        targetSearchId: target === "new" ? undefined : target,
      });
      client.removeQueries({ queryKey: keys.opportunity(run.id) });
      open(doc);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRunning(false);
    }
  };

  const promoteCandidate = async (phrase: string) => {
    if (!run) return;
    setRunning(true);
    setError(null);
    try {
      const doc = await promoteOpportunity(run.id, {
        phrases: [phrase],
        name: phrase,
      });
      client.removeQueries({ queryKey: keys.opportunity(run.id) });
      open(doc);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRunning(false);
    }
  };

  const toggle = (phrase: string) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(phrase)) next.delete(phrase);
      else next.add(phrase);
      return next;
    });
  };

  return (
    <main className="flex-1 min-w-0 overflow-y-auto">
      <div className="max-w-[1180px] mx-auto px-5 py-6 md:px-8 md:py-8">
        <div className="flex items-start justify-between gap-6 mb-6">
          <div>
            <div
              className="flex items-center gap-2 text-xs mb-2"
              style={{ color: "var(--color-muted)" }}
            >
              <Home size={13} />
              Opportunity explorer
            </div>
            <h1 className="search-title">Find a grounded angle</h1>
            <p className="lede mt-2 max-w-[680px]">
              Test a product-supported topic against live search demand. Nothing is
              saved until you promote selected phrases. To map the whole product,
              use{" "}
              <Link to="/plan" className="underline-offset-2 hover:underline">
                Product plan
              </Link>
              .
            </p>
          </div>
          {run && (
            <button type="button" className="btn btn-quiet" onClick={discard}>
              <Trash2 size={14} />
              Discard
            </button>
          )}
        </div>

        <form
          onSubmit={start}
          className="p-4 md:p-5 grid gap-4 md:grid-cols-[minmax(0,1fr)_140px_auto]"
          style={{
            background: "var(--color-surface)",
            border: "1px solid var(--color-border)",
            borderRadius: 4,
          }}
        >
          <label className="grid gap-1.5">
            <span className="text-xs font-medium">Question or topic</span>
            <input
              className="field"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="video screen recorder"
              required
            />
          </label>
          <label className="grid gap-1.5">
            <span className="text-xs font-medium">SERP budget</span>
            <select
              className="field"
              value={budget}
              onChange={(event) => setBudget(Number(event.target.value))}
            >
              <option value={2}>2 calls</option>
              <option value={4}>4 calls</option>
              <option value={6}>6 calls</option>
              <option value={8}>8 calls</option>
            </select>
          </label>
          <button
            type="submit"
            className="btn btn-primary self-end"
            disabled={!query.trim()}
          >
            <Search size={14} />
            Explore
          </button>
        </form>

        {search.run && runQuery.isPending && (
          <div className="py-14 text-sm" style={{ color: "var(--color-muted)" }}>
            Restoring temporary run…
          </div>
        )}

        {search.run && runQuery.isError && (
          <div
            className="mt-5 p-4 text-sm"
            style={{
              color: "var(--color-danger)",
              border: "1px solid var(--color-border)",
              borderRadius: 4,
            }}
          >
            This temporary run expired or is no longer available.
          </div>
        )}

        {run && (
          <div className="mt-6 grid gap-5">
            <section
              className="p-4 md:p-5"
              style={{
                background: "var(--color-surface)",
                border: "1px solid var(--color-border)",
                borderRadius: 4,
              }}
            >
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div>
                  <div className="flex flex-wrap items-center gap-2 mb-2">
                    <span className="pill">{fitLabel(run.productMatch.fit)}</span>
                    <span className="pill">
                      {Math.round(run.productMatch.confidence * 100)}% confidence
                    </span>
                    <span className="pill">expires in {expiresIn(run.expiresAt)}</span>
                  </div>
                  <h2 className="text-lg font-semibold tracking-tight">
                    {run.productMatch.outcome}
                  </h2>
                  <p
                    className="text-sm mt-1 max-w-[760px]"
                    style={{ color: "var(--color-muted)" }}
                  >
                    {run.productMatch.rationale}
                  </p>
                </div>
                <div className="text-xs font-mono text-right">
                  <div>{run.budget.attempted}/{run.budget.requested} calls</div>
                  <div style={{ color: "var(--color-muted)" }}>
                    {run.candidates.length} grounded candidates
                  </div>
                </div>
              </div>

              {run.productMatch.evidence.length > 0 && (
                <div className="mt-4 grid gap-2 md:grid-cols-2">
                  {run.productMatch.evidence.slice(0, 4).map((evidence) => (
                    <div
                      key={evidence.nodeId}
                      className="text-xs p-2.5"
                      style={{
                        background: "var(--color-panel)",
                        border: "1px solid var(--color-border)",
                        borderRadius: 4,
                      }}
                    >
                      <div className="font-medium">{evidence.label}</div>
                      <div
                        className="font-mono mt-0.5 truncate"
                        style={{ color: "var(--color-muted)" }}
                        title={evidence.source}
                      >
                        {evidence.kind} / {evidence.source}
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {run.productMatch.constraints.length > 0 && (
                <div
                  className="mt-4 text-sm"
                  style={{ color: "var(--color-danger)" }}
                >
                  {run.productMatch.constraints.join(" ")}
                </div>
              )}
            </section>

            {run.candidates.length > 0 ? (
              <section
                style={{
                  background: "var(--color-surface)",
                  border: "1px solid var(--color-border)",
                  borderRadius: 4,
                }}
              >
                <div
                  className="px-4 py-3 flex flex-wrap items-center justify-between gap-3"
                  style={{ borderBottom: "1px solid var(--color-border)" }}
                >
                  <div>
                    <h2 className="font-semibold">Grounded candidates</h2>
                    <div className="text-xs" style={{ color: "var(--color-muted)" }}>
                      Ranked by product fit, source overlap, and niche signal.
                    </div>
                  </div>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      className="btn btn-quiet h-8 text-xs"
                      onClick={() =>
                        setSelected(new Set(run.candidates.map((row) => row.phrase)))
                      }
                    >
                      Select all
                    </button>
                    <button
                      type="button"
                      className="btn btn-quiet h-8 text-xs"
                      onClick={() => setSelected(new Set())}
                    >
                      Clear
                    </button>
                  </div>
                </div>

                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="data-head">
                      <tr>
                        <th className="w-10 px-4 py-2 text-left">
                          <span className="sr-only">Select</span>
                        </th>
                        <th className="px-2 py-2 text-left">Phrase</th>
                        <th className="px-3 py-2 text-left">Evidence</th>
                        <th className="px-3 py-2 text-right">Niche</th>
                        <th className="px-4 py-2 text-right">Rank</th>
                        <th className="px-4 py-2 text-right">Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {run.candidates.map((candidate) => (
                        <tr
                          key={candidate.phrase}
                          style={{ borderTop: "1px solid var(--color-border)" }}
                        >
                          <td className="px-4 py-3 align-top">
                            <input
                              type="checkbox"
                              checked={selected.has(candidate.phrase)}
                              onChange={() => toggle(candidate.phrase)}
                              aria-label={`Select ${candidate.phrase}`}
                            />
                          </td>
                          <td className="px-2 py-3 align-top">
                            <a
                              href={googleSearchUrl(candidate.phrase, run.locale)}
                              target="_blank"
                              rel="noreferrer"
                              className="font-medium hover:underline"
                              title={`${candidate.phrase} - Google`}
                            >
                              {candidate.phrase}
                            </a>
                            <div
                              className="text-xs mt-1 flex items-center gap-2"
                              style={{ color: "var(--color-muted)" }}
                            >
                              <span>{fitLabel(candidate.productMatch.fit)}</span>
                              <a
                                href={googleSearchUrl(candidate.phrase, run.locale)}
                                target="_blank"
                                rel="noreferrer"
                                className="text-runny-accent hover:underline inline-flex items-center gap-1"
                              >
                                Google <ExternalLink size={10} />
                              </a>
                              {serpapiSearchUrl(
                                candidate.record.serp?.searchId,
                                config?.serpapiKey
                              ) && (
                                <a
                                  href={serpapiSearchUrl(
                                    candidate.record.serp?.searchId,
                                    config?.serpapiKey
                                  )}
                                  target="_blank"
                                  rel="noreferrer"
                                  className="text-runny-accent hover:underline inline-flex items-center gap-1"
                                >
                                  SERP <ExternalLink size={10} />
                                </a>
                              )}
                            </div>
                          </td>
                          <td className="px-3 py-3 align-top">
                            <div className="text-xs">
                              {candidate.record.sources.join(", ")}
                            </div>
                            <div
                              className="text-xs mt-0.5"
                              style={{ color: "var(--color-muted)" }}
                            >
                              {candidate.productMatch.evidence[0]?.label ??
                                candidate.productMatch.outcome}
                            </div>
                          </td>
                          <td className="px-3 py-3 text-right font-mono align-top">
                            {candidate.record.scores.niche}
                          </td>
                          <td className="px-4 py-3 text-right font-mono font-semibold align-top">
                            {candidate.rank}
                          </td>
                          <td className="px-4 py-3 text-right align-top">
                            <button
                              type="button"
                              className="btn btn-quiet h-7 px-2 text-xs whitespace-nowrap"
                              onClick={() => promoteCandidate(candidate.phrase)}
                              title="Save this candidate and open it as a new search"
                            >
                              New search
                              <ArrowRight size={11} />
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                <div
                  className="p-4 grid gap-3 md:grid-cols-[220px_minmax(0,1fr)_auto]"
                  style={{ borderTop: "1px solid var(--color-border)" }}
                >
                  <label className="grid gap-1.5">
                    <span className="text-xs font-medium">Promote into</span>
                    <select
                      className="field"
                      value={target}
                      onChange={(event) => setTarget(event.target.value)}
                    >
                      <option value="new">New saved search</option>
                      {searches.map((item) => (
                        <option key={item.id} value={item.id}>
                          {item.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  {target === "new" ? (
                    <label className="grid gap-1.5">
                      <span className="text-xs font-medium">Search name</span>
                      <input
                        className="field"
                        value={name}
                        onChange={(event) => setName(event.target.value)}
                      />
                    </label>
                  ) : (
                    <div
                      className="self-end pb-2 text-xs"
                      style={{ color: "var(--color-muted)" }}
                    >
                      Evidence will be merged without another SerpAPI call.
                    </div>
                  )}
                  <button
                    type="button"
                    className="btn btn-primary self-end"
                    disabled={!selectedCandidates.length || (target === "new" && !name.trim())}
                    onClick={promote}
                  >
                    Promote {selectedCandidates.length || ""}
                    <ArrowRight size={14} />
                  </button>
                </div>
              </section>
            ) : (
              <section
                className="p-5 text-sm"
                style={{
                  background: "var(--color-surface)",
                  border: "1px solid var(--color-border)",
                  borderRadius: 4,
                  color: "var(--color-muted)",
                }}
              >
                No paid search calls were made because this topic could not be
                grounded in current product evidence.
              </section>
            )}

            {run.errors.length > 0 && (
              <section className="text-xs" style={{ color: "var(--color-danger)" }}>
                {run.errors.length} SERP request{run.errors.length === 1 ? "" : "s"} failed.
                The available evidence is still shown above.
              </section>
            )}
          </div>
        )}
      </div>
    </main>
  );
}
