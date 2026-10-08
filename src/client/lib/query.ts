import {
  QueryClient,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { EMPTY_SETTINGS, type AppSettings } from "../../shared/config";
import { summarize, type SearchDocument } from "../../shared/phrases";
import { serpapiSearchUrl } from "../../shared/links";
import {
  fetchCapabilities,
  fetchConfig,
  fetchOpportunity,
  fetchProductPlan,
  fetchReport,
  fetchSearch,
  fetchSearches,
  fetchSettings,
} from "./api";

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 15_000,
      retry: 8,
      retryDelay: 200,
    },
  },
});

export const keys = {
  config: ["config"] as const,
  settings: ["settings"] as const,
  searches: ["searches"] as const,
  search: (id: string) => ["search", id] as const,
  report: (id: string) => ["report", id] as const,
  opportunity: (id: string) => ["opportunity", id] as const,
  capabilities: ["capabilities"] as const,
  productPlan: ["product-plan"] as const,
};

export function upsertSearchCache(
  client: QueryClient,
  doc: SearchDocument
): void {
  client.setQueryData(keys.search(doc.id), doc);
  client.setQueryData(keys.searches, (prev: ReturnType<typeof summarize>[] = []) => {
    const summary = summarize(doc);
    return [summary, ...prev.filter((row) => row.id !== doc.id)].sort((a, b) =>
      b.updatedAt.localeCompare(a.updatedAt)
    );
  });
}

export function removeSearchCache(client: QueryClient, id: string): void {
  client.removeQueries({ queryKey: keys.search(id) });
  client.setQueryData(keys.searches, (prev: ReturnType<typeof summarize>[] = []) =>
    prev.filter((row) => row.id !== id)
  );
}

export function useConfig() {
  return useQuery({
    queryKey: keys.config,
    queryFn: fetchConfig,
  });
}

export function useSettings() {
  return useQuery({
    queryKey: keys.settings,
    queryFn: fetchSettings,
  });
}

export function useSearches() {
  return useQuery({
    queryKey: keys.searches,
    queryFn: fetchSearches,
  });
}

export function useSearch(id: string | undefined) {
  return useQuery({
    queryKey: keys.search(id ?? ""),
    queryFn: () => fetchSearch(id!),
    enabled: Boolean(id),
  });
}

export function useReport(id: string | undefined) {
  return useQuery({
    queryKey: keys.report(id ?? ""),
    queryFn: () => fetchReport(id!),
    enabled: Boolean(id),
    retry: false,
  });
}

export function useCapabilities() {
  return useQuery({
    queryKey: keys.capabilities,
    queryFn: fetchCapabilities,
    retry: false,
  });
}

export function useProductPlan() {
  return useQuery({
    queryKey: keys.productPlan,
    queryFn: fetchProductPlan,
    retry: false,
    refetchInterval: (query) =>
      query.state.data?.run?.status === "running" ? 1000 : 4000,
    refetchOnWindowFocus: true,
  });
}

export function useOpportunity(id: string | undefined) {
  return useQuery({
    queryKey: keys.opportunity(id ?? ""),
    queryFn: () => fetchOpportunity(id!),
    enabled: Boolean(id),
    retry: false,
  });
}

export function useSearchActions() {
  const client = useQueryClient();
  const navigate = useNavigate();

  return {
    cache(doc: SearchDocument) {
      upsertSearchCache(client, doc);
    },
    open(doc: SearchDocument) {
      upsertSearchCache(client, doc);
      void navigate({
        to: "/searches/$searchId",
        params: { searchId: doc.id },
      });
    },
    remove(id: string) {
      removeSearchCache(client, id);
      void navigate({ to: "/", search: { run: undefined } });
    },
    setSettings(next: AppSettings) {
      client.setQueryData(keys.settings, next);
    },
  };
}

export function settingsOrEmpty(data: AppSettings | undefined): AppSettings {
  return data ?? EMPTY_SETTINGS;
}

export function useSerpapiUrl(searchId: string | null | undefined) {
  const key = useConfig().data?.serpapiKey;
  return serpapiSearchUrl(searchId, key);
}
