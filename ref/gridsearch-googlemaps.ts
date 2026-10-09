/**
 * Grid Search — Google Maps
 *
 * Two-phase architecture:
 *   Phase 1: gridEnumerate() — walk GADM tree, return area names + centers (no cost)
 *   Phase 2: gridSearchGoogleMaps() — run SerpAPI search per area (costs credits)
 *
 * The search is a pluggable iterator — same pattern works for future
 * gridSearchEmails(), gridSearchEnrich(), etc.
 */

import { GridArea } from './gridsearch/index.js';
import { searchRawWithStats, locationString } from './search/googlemaps.js';
import { zodSchema } from './search/googlemaps-zod.js';
import pMap from 'p-map';
import type { GridSearchStateStore, AreaSearchParams } from './gridsearch-state.js';

export interface GridSearchAreaResult {
    area: GridArea;
    results: any[];
    cached: boolean;
    apiCalls: number;
    filtered: number;
    viewportSqKm?: number;
    durationMs?: number;
    error?: string;
}

export interface GridSearchResult {
    region: { name: string; gid: string; level: number };
    areaCount: number;
    totalResults: number;
    /** Total SerpAPI calls across all areas (including cached area metadata). */
    apiCalls: number;
    /** SerpAPI calls made on this run — 0 means every area was served from cache. */
    freshApiCalls: number;
    filtered: number;
    totalScannedSqKm: number;
    results: any[];
    areas: GridSearchAreaResult[];
    durationMs: number;
}

/**
 * Generic cache contract for enriched locations.
 * Keyed by `place_id`.  Implementations can be file-backed, in-memory, etc.
 */
export interface LocationCacheProvider<T = unknown> {
    /** Return a cached entry or `undefined` if not cached. */
    get(placeId: string): Promise<T | undefined> | T | undefined;
    /** Persist a freshly-enriched entry. */
    set(placeId: string, value: T): Promise<void> | void;
    /** Optional: total number of entries stored. */
    size?(): Promise<number> | number;
}

/**
 * Calculate the estimated square kilometers visible in a standard 1024x768
 * Google Maps viewport at a given latitude and zoom level.
 */
export function estimateViewportAreaSqKm(lat: number, zoom: number, widthPx = 1024, heightPx = 768): number {
    const metersPerPx = (156543.03392 * Math.cos(lat * Math.PI / 180)) / Math.pow(2, Math.floor(zoom));
    const widthKm = (widthPx * metersPerPx) / 1000;
    const heightKm = (heightPx * metersPerPx) / 1000;
    return widthKm * heightKm;
}



// ────────── Phase 2: Google Maps Search ──────────

export interface GridSearchGoogleMapsOptions {
    areas: GridArea[];
    types: string[];
    apiKey: string;
    /** e.g. 'google.es', 'google.de' — default 'google.com' */
    googleDomain?: string;
    /** e.g. 'es', 'de' — default 'en' */
    language?: string;
    limitPerArea?: number;
    zoom?: number;
    concurrency?: number;
    /** AbortSignal — abort to stop search early */
    signal?: AbortSignal;
    /** Called BEFORE each area search begins — SSE streaming (pacman moves here) */
    onAreaStart?: (area: GridArea, index: number, total: number) => void;
    /** Called after each area completes — SSE streaming */
    onAreaDone?: (area: GridSearchAreaResult) => void;
    /** Called for each location that passes filters — SSE streaming */
    onLocation?: (location: any, areaName: string) => void;
    /** Filter results: only keep entries whose type_ids include at least one of these */
    filterTypeIds?: string[];
    /** Filter results: only keep entries whose address contains this string (case-insensitive) */
    filterCountry?: string;
    /**
     * Optional per-area state store.  When provided, a cache hit for an area
     * skips the SerpAPI call entirely and replays the stored raw results through
     * the same filter + dedup logic.  Compatible with a future Supabase-backed
     * store via the same GridSearchStateStore interface.
     */
    stateStore?: GridSearchStateStore;
    /** If true, uses the stateStore to avoid redundant calls (default: true) */
    useCache?: boolean;
    /** When true, deletes stale cache entries before searching (forces fresh API calls). */
    forceRefresh?: boolean;
    /** Checking function to pause enrichment */
    isPaused?: () => boolean;
}

/**
 * Run Google Maps SerpAPI search for each area.
 * This is the iterator — pluggable, takes GridArea[] from gridEnumerate().
 */
export async function gridSearchGoogleMaps(
    opts: GridSearchGoogleMapsOptions,
): Promise<Omit<GridSearchResult, 'region'>> {
    const {
        areas,
        types,
        apiKey,
        googleDomain = 'google.com',
        language = 'en',
        limitPerArea = 20,
        zoom = 14,
        concurrency = 2,
        signal,
        onAreaStart,
        onAreaDone,
        onLocation,
        filterTypeIds,
        filterCountry,
        stateStore,
        useCache = true,
        forceRefresh = false,
        isPaused,
    } = opts;

    const filterCountryLower = filterCountry?.toLowerCase();

    const start = Date.now();
    const areaResults: GridSearchAreaResult[] = [];
    const allPlaceIds = new Set<string>();
    const allResults: any[] = [];

    // Search each area
    let areaIndex = 0;
    await pMap(areas, async (area) => {
        if (signal?.aborted) return;
        while (isPaused && isPaused() && !signal?.aborted) {
            await new Promise(r => setTimeout(r, 1000));
        }
        if (signal?.aborted) return;

        const currentIndex = areaIndex++;
        if (onAreaStart) onAreaStart(area, currentIndex, areas.length);

        const areaStart = Date.now();
        const areaResult: GridSearchAreaResult = {
            area,
            results: [],
            cached: false,
            apiCalls: 0,
            filtered: 0,
            viewportSqKm: Number(estimateViewportAreaSqKm(area.center.lat, zoom).toFixed(2))
        };

        // ── Build cache key params ────────────────────────────────────
        const searchParams: AreaSearchParams = {
            center: area.center,
            zoom,
            types,
            googleDomain,
            language,
            limit: limitPerArea,
        };

        // ── Force refresh: invalidate stale entry ─────────────────────
        if (forceRefresh && stateStore) {
            await stateStore.invalidateArea(searchParams);
        }

        // ── State cache check ─────────────────────────────────────────
        const cachedState = (stateStore && useCache && !forceRefresh) ? await stateStore.getArea(searchParams) : undefined;
        if (cachedState) {
            areaResult.results = cachedState.results;
            areaResult.apiCalls = cachedState.apiCalls;
            areaResult.cached = true;
        } else {
            try {
                const searchCoord = locationString(
                    `${area.center.lat},${area.center.lon}`,
                    zoom,
                );

                // Search for each type
                for (const type of types) {
                    if (signal?.aborted) break;

                    const searchOpts = zodSchema().parse({
                        query: type,
                        engine: 'google_maps',
                        type: 'search',
                        searchCoord,
                        google_domain: googleDomain,
                        language,
                        limit: limitPerArea,
                        zoom,
                        concurrency: 1,
                        resolve: [],
                        api_key: apiKey,
                    });

                    // Use searchRaw for lighter results — no geo enrichment needed
                    const { results, apiCalls } = await searchRawWithStats(type, apiKey, searchOpts);
                    areaResult.results.push(...results);
                    areaResult.apiCalls += apiCalls;
                }
            } catch (e: any) {
                console.error(`Error searching area ${area.name}:`, e);
                areaResult.error = e.message || String(e);
            }

            // ── Persist raw results before filter/dedup ───────────────
            if (!areaResult.error && stateStore) {
                await stateStore.saveArea(searchParams, {
                    gid: area.gid,
                    areaName: area.name,
                    results: areaResult.results,
                    apiCalls: areaResult.apiCalls,
                    viewportSqKm: areaResult.viewportSqKm,
                    cachedAt: new Date().toISOString(),
                });
            }
        }

        // Filter + deduplicate within area
        for (const r of areaResult.results) {
            if (signal?.aborted) break;
            if (!r || !r.place_id || allPlaceIds.has(r.place_id)) continue;

            // ── type_ids filter ──
            if (filterTypeIds?.length) {
                const ids: string[] = r.type_ids || [];
                if (!ids.some((id: string) => filterTypeIds.includes(id))) {
                    areaResult.filtered++;
                    continue;
                }
            }

            // ── country filter (address substring) ──
            if (filterCountryLower) {
                const addr = String(r.address || '').toLowerCase();
                if (!addr.includes(filterCountryLower)) {
                    areaResult.filtered++;
                    continue;
                }
            }

            allPlaceIds.add(r.place_id);
            const loc = { ...r, _gridArea: area.name, _gridGid: area.gid };
            allResults.push(loc);

            // Stream each location
            if (onLocation) onLocation(loc, area.name);
        }

        areaResult.durationMs = Date.now() - areaStart;
        areaResults.push(areaResult);

        // Stream area result
        if (onAreaDone) onAreaDone(areaResult);
    }, { concurrency });

    return {
        areaCount: areas.length,
        totalResults: allResults.length,
        apiCalls: areaResults.reduce((sum, a) => sum + a.apiCalls, 0),
        freshApiCalls: areaResults.filter(a => !a.cached).reduce((sum, a) => sum + a.apiCalls, 0),
        filtered: areaResults.reduce((sum, a) => sum + a.filtered, 0),
        totalScannedSqKm: Number(areaResults.reduce((sum, a) => sum + (a.viewportSqKm || 0), 0).toFixed(2)),
        results: allResults,
        areas: areaResults,
        durationMs: Date.now() - start,
    };
}
