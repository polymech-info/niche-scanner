import { QueryClient } from "@tanstack/react-query";
import {
  Outlet,
  createRootRouteWithContext,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { AppShell } from "./App";
import { SearchPanel } from "./components/SearchPanel";
import { DashboardPanel } from "./components/DashboardPanel";
import { ProductPlanPanel } from "./components/ProductPlanPanel";
import { CapabilitiesPanel } from "./components/CapabilitiesPanel";
import { keys, queryClient } from "./lib/query";
import { fetchSearch } from "./lib/api";

export interface RouterContext {
  queryClient: QueryClient;
}

const rootRoute = createRootRouteWithContext<RouterContext>()({
  component: () => (
    <AppShell>
      <Outlet />
    </AppShell>
  ),
});

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  validateSearch: (search: Record<string, unknown>) => ({
    run: typeof search.run === "string" ? search.run : undefined,
  }),
  component: DashboardPanel,
});

const planRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/plan",
  component: ProductPlanPanel,
});

const capabilitiesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/capabilities",
  component: CapabilitiesPanel,
});

const newSearchRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/searches/new",
  component: SearchPanel,
});

const searchRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/searches/$searchId",
  loader: ({ context, params }) =>
    context.queryClient.ensureQueryData({
      queryKey: keys.search(params.searchId),
      queryFn: () => fetchSearch(params.searchId),
    }),
  component: SearchPanel,
});

const routeTree = rootRoute.addChildren([
  indexRoute,
  planRoute,
  capabilitiesRoute,
  newSearchRoute,
  searchRoute,
]);

export const router = createRouter({
  routeTree,
  context: { queryClient },
  defaultPreload: "intent",
  scrollRestoration: true,
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
