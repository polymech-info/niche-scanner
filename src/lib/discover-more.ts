import fs from "fs/promises";
import path from "path";
import type { SearchDocument } from "../shared/phrases.js";
import {
  flattenNeighbors,
  knownPhrases,
  mergeNeighborLinks,
  pickNeighborHubs,
  NEIGHBOR_PROMPT,
  type DiscoverMoreMeta,
  type NeighborHint,
  type NeighborHub,
} from "../shared/neighbors.js";
import { resultsParentDir } from "./generate.js";
import { runLlmEach } from "./llm-each.js";
import { log } from "./log.js";
import { getStore } from "./run.js";
import type { SearchStore } from "./store.js";

export interface DiscoverMoreInput {
  id: string;
  force?: boolean;
  maxHubs?: number;
  dryRun?: boolean;
  store?: SearchStore;
}

export interface DiscoverMoreResult {
  doc: SearchDocument;
  hubs: NeighborHub[];
  neighbors: NeighborHint[];
  cacheHits: number;
  transformed: number;
  fromCache: boolean;
}

interface NeighborFile {
  searchId: string;
  name: string;
  items: Array<NeighborHub & { neighbors?: unknown }>;
}

export async function discoverMore(
  input: DiscoverMoreInput
): Promise<DiscoverMoreResult> {
  const store = getStore(input.store);
  const current = await store.get(input.id);
  const hubs = pickNeighborHubs(current, input.maxHubs ?? 8);
  if (!hubs.length) {
    throw new Error("Nothing to expand. Add a seed first.");
  }

  if (current.neighbors?.length && !input.force) {
    log.info(
      { id: current.id, neighbors: current.neighbors.length },
      "discover-more cache"
    );
    return {
      doc: current,
      hubs,
      neighbors: current.neighbors,
      cacheHits: hubs.length,
      transformed: 0,
      fromCache: true,
    };
  }

  const dir = path.join(resultsParentDir(), current.id);
  await fs.mkdir(dir, { recursive: true });
  const source = path.join(dir, "neighbors.in.json");
  const dest = path.join(dir, "neighbors.out.json");
  const file: NeighborFile = {
    searchId: current.id,
    name: current.name,
    items: hubs,
  };
  await fs.writeFile(source, `${JSON.stringify(file, null, 2)}\n`, "utf8");

  const dryRun =
    Boolean(input.dryRun) || process.env.PHRASES_LLM_DRY === "1";
  log.info(
    { id: current.id, hubs: hubs.map((hub) => hub.phrase), source, dest, dryRun },
    "discover-more start"
  );
  const llm = await runLlmEach({
    source,
    dest,
    selector: ".items[].phrase",
    prompt: NEIGHBOR_PROMPT,
    force: input.force,
    dryRun,
  });

  const output = (llm.output ?? {}) as NeighborFile;
  const neighbors = dryRun
    ? current.neighbors ?? []
    : mergeNeighborLinks(
        current.neighbors,
        flattenNeighbors(
          output.items ?? [],
          knownPhrases(current),
          current.seeds
        )
      );

  const meta: DiscoverMoreMeta = {
    ranAt: new Date().toISOString(),
    hubs: hubs.length,
    cacheHits: llm.cacheHits,
    transformed: llm.transformed,
    source,
    dest,
  };

  const next: SearchDocument = dryRun
    ? current
    : {
        ...current,
        updatedAt: meta.ranAt,
        neighbors,
        discoverMore: meta,
      };
  const doc = dryRun ? current : await store.save(next);
  log.info(
    {
      id: doc.id,
      neighbors: neighbors.length,
      cacheHits: llm.cacheHits,
      transformed: llm.transformed,
      dryRun,
    },
    "discover-more done"
  );
  return {
    doc,
    hubs,
    neighbors,
    cacheHits: llm.cacheHits,
    transformed: llm.transformed,
    fromCache: false,
  };
}
