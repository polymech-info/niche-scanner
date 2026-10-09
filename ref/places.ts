import { logger } from '@/commons/logger.js';
import type { PgBoss } from 'pg-boss';
import { GRIDSEARCH_JOB_NAME } from './constants.js';
import { getNames } from '@polymech/gadm';
import crypto from 'crypto';
import {
    getLocationsByPlaceIds,
    getGridSearchRunById,
    getPlacesTypes,
    getUserGridSearchRuns,
    getChildGridSearchRuns,
    getGridSearchRunSettings,
    updateGridSearchRunSettings,
    insertGridSearchRun,
    updateGridSearchRun,
    getGridSearchRunForRetryExpand,
    deleteGridSearchRun,
    deletePgBossGridSearchJobs,
    getPlaceById,
    getPlaceMetaById,
    updatePlaceMeta,
    getPlacesChunk,
    getPlaceSearchesByRunId,
    fetchUserSecretsSettingsPg,
} from './db-places.js';

import { getUserSecrets } from '@/commons/auth.js';
import type { GridSearchUdsManager } from './gridsearch-uds.js';
import { sendGridSearchControl } from './gridsearch-uds.js';
function md5(str: string): string {
    return crypto.createHash('md5').update(str).digest('hex');
}
import type { GridSearchStateStore, GridAreaState, GridEnumState, AreaSearchParams } from './gridsearch-state.js';
import { areaKey } from './gridsearch-state.js';
import { getServicePool } from '@/commons/postgres.js';
// ─── PgGridSearchStateStore ───────────────────────────────────────────────────

export class PgGridSearchStateStore implements GridSearchStateStore {
    readonly label = 'Postgres';
    private userId: string | null;
    private runId: string | null;

    constructor(userId?: string, runId?: string) {
        this.userId = userId ?? null;
        this.runId = runId ?? null;
    }

    async getEnum(region: string, level: string | number, flags: string): Promise<GridEnumState | undefined> {
        const pool = getServicePool();
        const filter = JSON.stringify({ flags, query: { level } });

        const { rows } = await pool.query(
            `SELECT *
             FROM public.grid_areas
             WHERE region = $1
               AND meta @> $2::jsonb`,
            [region, filter],
        );

        if (rows.length === 0) return undefined;

        const areas = rows.map((row: any) => ({
            name: row.name,
            gid: row.gid,
            level: row.level,
            center: row.center,
            bbox: row.bbox,
            areaSqKm: row.area_sqkm,
            maxDistanceKm: row.max_dist_km,
            geometry: row.geometry,
            stats: row.stats,
        }));

        const first = rows[0];
        const regionData = first.meta?.regionData ?? { name: region, gid: '', level: level as number };
        const query = first.meta?.query ?? { region, level };
        const maxLevelAvailable = first.meta?.maxLevelAvailable ?? level as number;

        return {
            region,
            level,
            cachedAt: first.created_at,
            result: {
                query,
                region: regionData,
                areas,
                maxLevelAvailable,
                generatedAt: first.created_at,
            },
        };
    }

    async saveEnum(region: string, level: string | number, flags: string, state: GridEnumState): Promise<void> {
        const areas = state.result.areas ?? [];
        if (areas.length === 0) return;

        const pool = getServicePool();
        const filter = JSON.stringify({ flags, query: { level } });

        const client = await pool.connect();
        try {
            await client.query('BEGIN');

            await client.query(
                `DELETE FROM public.grid_areas
                 WHERE region = $1
                   AND meta @> $2::jsonb`,
                [region, filter],
            );

            for (const area of areas) {
                await client.query(
                    `INSERT INTO public.grid_areas
                       (user_id, gid, name, level, region, center, bbox, area_sqkm, max_dist_km, geometry, stats, meta)
                     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
                    [
                        this.userId,
                        area.gid,
                        area.name,
                        area.level,
                        region,
                        area.center   != null ? JSON.stringify(area.center)   : null,
                        area.bbox     != null ? JSON.stringify(area.bbox)     : null,
                        (area as any).areaSqKm ?? null,
                        (area as any).maxDistanceKm ?? null,
                        area.geometry != null ? JSON.stringify(area.geometry) : null,
                        (area as any).stats != null ? JSON.stringify((area as any).stats) : null,
                        JSON.stringify({
                            flags,
                            query: state.result.query,
                            regionData: state.result.region,
                            maxLevelAvailable: state.result.maxLevelAvailable,
                        }),
                    ],
                );
            }

            await client.query('COMMIT');
        } catch (err) {
            await client.query('ROLLBACK');
            throw err;
        } finally {
            client.release();
        }
    }

    async getArea(params: AreaSearchParams): Promise<GridAreaState | undefined> {
        const hash = md5(areaKey(params));
        const pool = getServicePool();

        const { rows } = await pool.query(
            `SELECT input_params, result_place_ids, created_at
             FROM public.place_searches
             WHERE input_hash = $1`,
            [hash],
        );

        if (rows.length === 0) return undefined;
        const row = rows[0];
        const inputParams = row.input_params as any;
        let results = inputParams?.results;

        if (!results && row.result_place_ids?.length > 0) {
            const { rows: placeRows } = await pool.query(
                `SELECT meta FROM public.places WHERE place_id = ANY($1)`,
                [row.result_place_ids],
            );
            results = placeRows.map((p: any) => p.meta).filter(Boolean);
        } else if (!results) {
            results = [];
        }

        return {
            gid: inputParams?.gid ?? '',
            areaName: inputParams?.areaName ?? '',
            results,
            apiCalls: inputParams?.apiCalls ?? 0,
            viewportSqKm: inputParams?.viewportSqKm,
            cachedAt: row.created_at,
        };
    }

    async saveArea(params: AreaSearchParams, state: GridAreaState): Promise<void> {
        const hash = md5(areaKey(params));
        const pool = getServicePool();
        const placeIds = state.results.map((r: any) => r.place_id).filter(Boolean);

        const client = await pool.connect();
        try {
            await client.query('BEGIN');

            // 1. Upsert place_searches
            await client.query(
                `INSERT INTO public.place_searches
                   (input_hash, input_params, result_place_ids, user_id, run_id)
                 VALUES ($1, $2, $3, $4, $5)
                 ON CONFLICT (input_hash)
                 DO UPDATE SET
                   input_params    = EXCLUDED.input_params,
                   result_place_ids= EXCLUDED.result_place_ids,
                   user_id         = EXCLUDED.user_id,
                   run_id          = EXCLUDED.run_id`,
                [
                    hash,
                    JSON.stringify({
                        gid: state.gid,
                        types: params.types,
                        googleDomain: params.googleDomain,
                        language: params.language,
                        limit: params.limit,
                        center: params.center,
                        zoom: params.zoom,
                        areaName: state.areaName,
                        apiCalls: state.apiCalls,
                        viewportSqKm: state.viewportSqKm,
                    }),
                    placeIds,
                    this.userId,
                    this.runId,
                ],
            );

            // 2. Resolve grid_area_id by gid (most recent)
            let gridAreaId: string | null = null;
            if (state.gid) {
                const { rows: areaRows } = await client.query(
                    `SELECT id FROM public.grid_areas
                     WHERE gid = $1
                     ORDER BY created_at DESC
                     LIMIT 1`,
                    [state.gid],
                );
                gridAreaId = areaRows[0]?.id ?? null;
            }

            // 3. Upsert places
            if (state.results.length > 0) {
                const uniquePlaces = Array.from(
                    new Map(
                        state.results
                            .filter((r: any) => r.place_id)
                            .map((r: any) => [
                                r.place_id,
                                {
                                    place_id: r.place_id,
                                    title: r.title,
                                    website: r.website ?? null,
                                    address: r.address ?? null,
                                    types: r.type_ids ?? r.types ?? null,
                                    raw_data: r,
                                    user_id: this.userId,
                                },
                            ]),
                    ).values(),
                );

                for (const place of uniquePlaces) {
                    await client.query(
                        `INSERT INTO public.places
                           (place_id, title, website, address, types, raw_data, user_id)
                         VALUES ($1,$2,$3,$4,$5,$6,$7)
                         ON CONFLICT (place_id)
                         DO UPDATE SET
                           title    = EXCLUDED.title,
                           website  = EXCLUDED.website,
                           address  = EXCLUDED.address,
                           types    = EXCLUDED.types,
                           raw_data = EXCLUDED.raw_data`,
                        [
                            place.place_id,
                            place.title,
                            place.website,
                            place.address,
                            place.types != null ? JSON.stringify(place.types) : null,
                            JSON.stringify(place.raw_data),
                            place.user_id,
                        ],
                    );
                }

                // 4. Upsert grid_area_places
                if (gridAreaId) {
                    for (let idx = 0; idx < placeIds.length; idx++) {
                        await client.query(
                            `INSERT INTO public.grid_area_places (grid_area_id, place_id, rank)
                             VALUES ($1, $2, $3)
                             ON CONFLICT (grid_area_id, place_id)
                             DO UPDATE SET rank = EXCLUDED.rank`,
                            [gridAreaId, placeIds[idx], idx + 1],
                        );
                    }
                }
            }

            await client.query('COMMIT');
        } catch (err) {
            await client.query('ROLLBACK');
            throw err;
        } finally {
            client.release();
        }
    }

    async invalidateArea(params: AreaSearchParams): Promise<boolean> {
        const hash = md5(areaKey(params));
        const pool = getServicePool();
        const { rowCount } = await pool.query(
            `DELETE FROM public.place_searches WHERE input_hash = $1`,
            [hash],
        );
        return (rowCount ?? 0) > 0;
    }
}


// In-memory cache for GID → full hierarchy names (e.g. ["Spain", "Cataluña", "Barcelona"])
const hierarchyCache = new Map<string, string[]>();
async function resolveHierarchy(gid: string, areaLevel?: number): Promise<string[]> {
    if (hierarchyCache.has(gid)) return hierarchyCache.get(gid)!;
    try {
        const result = await getNames({ admin: gid, complete: true });
        const row = result.rows?.[0];
        if (row) {
            const names: string[] = [];
            for (let i = 0; i <= 5; i++) {
                const name = row[`NAME_${i}`];
                if (name && name !== '') names.push(name);
                else break;
            }
            hierarchyCache.set(gid, names);
            return names;
        }
    } catch (e) {
        logger.warn({ gid, err: e }, '[PlacesProduct] Failed to resolve hierarchy');
    }
    hierarchyCache.set(gid, []);
    return [];
}

export class PlacesLibrary {
    /** Helper to load a grid search run or active job, enforcing authorization */
    static async loadAuthorizedGridSearch(idOrRunId: string, userId: string | undefined, boss?: PgBoss): Promise<{
        run: any | null;
        req: any | null;
        result: any | null;
        errorResponse: { status: number; error: string } | null;
    }> {
        const { data: run, error } = await getGridSearchRunById(idOrRunId);

        if (run && !error) {
            const isOwner = run.user_id === userId;
            const isPublic = run.settings?.is_public === true;

            if (!isOwner && !isPublic) {
                return { run: null, req: null, result: null, errorResponse: { status: 401, error: 'Unauthorized' } };
            }

            return {
                run,
                req: run.request || {},
                result: run.result || {},
                errorResponse: null
            };
        }

        // Try Boss active jobs
        if (boss && userId) {
            try {
                const job = await boss.getJobById(GRIDSEARCH_JOB_NAME, idOrRunId);
                if (job && job.data && (job.data as any).userId === userId) {
                    return {
                        run: null,
                        req: job.data,
                        result: null,
                        errorResponse: null
                    };
                }
            } catch (e) {
                logger.warn({ err: e }, 'Error fetching boss job by ID');
            }
        }

        if (!userId) {
            return { run: null, req: null, result: null, errorResponse: { status: 401, error: 'Unauthorized' } };
        }
        return { run: null, req: null, result: null, errorResponse: { status: 404, error: 'Search not found' } };
    }

    /**
     * Remove scraped emails for public / shared viewers (not the run owner).
     * Strips top-level `emails` and `meta.emails` (places often store emails only in meta).
     */
    static stripEmailsIfPublic(data: any, isPublic: boolean, isOwner: boolean): any {
        if (!isPublic || isOwner) return data;
        if (!data) return data;

        const stripOne = (item: any): any => {
            if (!item || typeof item !== 'object') return item;
            const { emails: _e, meta, ...rest } = item;
            const next: Record<string, unknown> = { ...rest };
            if (meta && typeof meta === 'object') {
                const { emails: _me, ...metaRest } = meta as Record<string, unknown>;
                next.meta = metaRest;
            }
            return next;
        };

        if (Array.isArray(data)) {
            return data.map(stripOne);
        }

        return stripOne(data);
    }

    static async getPlacesTypes(): Promise<string[]> {
        const { rows, error } = await getPlacesTypes();

        if (error) throw error;

        const allTypes = new Set<string>();
        for (const row of rows || []) {
            if (Array.isArray(row.types)) {
                for (const t of row.types) {
                    allTypes.add(t);
                }
            }
        }

        return Array.from(allTypes).sort();
    }

    static async getPlacesGridSearches(userId: string): Promise<any[]> {
        const { data, error } = await getUserGridSearchRuns(userId);

        if (error) throw error;

        const mapRow = async (row: any) => {
            const req = row.request || {};
            const res = row.result || {};
            const enumReq = req.enumerate || {};
            const searchReq = req.search || {};

            let liveResults = 0;
            let liveEmails = 0;

            if (res.searchStats?.totalResults != null) {
                liveResults = res.searchStats.totalResults;
            } else if (Array.isArray(res.enrichResults)) {
                liveResults = res.enrichResults.length;
            } else {
                liveResults = res.totalResults || 0;
            }

            if (res.totalEmails != null) {
                liveEmails = res.totalEmails;
            } else if (Array.isArray(res.enrichResults)) {
                for (const item of res.enrichResults) {
                    if (item && typeof item === 'object' && item.emails && Array.isArray(item.emails)) {
                        liveEmails += item.emails.length;
                    }
                }
            }

            let regionName = req.guided?.areas?.[0]?.name || enumReq.region || req.region || searchReq.types?.join(', ') || 'Unknown';
            if (typeof regionName === 'string' && (regionName.toLowerCase().startsWith('n.a.') || regionName.toLowerCase() === 'unknown')) {
                const gid = req.guided?.areas?.[0]?.gid;
                if (gid) {
                    // const resolved = await resolveGadmName(gid, regionName);
                    // regionName = resolved.name;
                }
            }

            let queryStr = req.types?.join(', ') || searchReq.types?.join(', ') || searchReq.query || res.options?.searchQuery || 'Enumeration Only';
            let levelStr = req.guided?.areas?.[0]?.level || enumReq.level;

            let hierarchy: string[] = [];
            const firstArea = req.guided?.areas?.[0] || res.options?.areas?.[0];
            if (firstArea?.gid) {
                const raw = await resolveHierarchy(firstArea.gid, firstArea.level ?? firstArea.raw?.level);
                hierarchy = raw.filter((h: string) => !h.toLowerCase().startsWith('n.a.') && h.toLowerCase() !== 'unknown');
            }

            let countries: string[] = [];
            if (hierarchy.length > 0) {
                countries = [hierarchy[0]];
            } else if (req.guided?.areas) {
                const countrySet = new Set<string>();
                for (const area of req.guided.areas) {
                    const country = area.raw?.NAME_0 || (area.raw?.level === 0 ? (area.raw?.gadmName || area.name) : null);
                    if (country) countrySet.add(country);
                }
                countries = Array.from(countrySet);
            }

            return {
                id: row.id,
                runId: req.runId || '',
                status: row.status || 'complete',
                regionName,
                level: levelStr,
                query: queryStr,
                results: liveResults,
                emails: liveEmails,
                countries,
                hierarchy,
                generatedAt: row.created_at,
                history: row.history ?? null,
            };
        };

        const results = await Promise.all((data || []).map(mapRow));

        const parentIds = results.map(r => r.id);
        let childrenByParent: Record<string, any[]> = {};
        if (parentIds.length > 0) {
            const { data: childRows } = await getChildGridSearchRuns(parentIds);

            if (childRows && childRows.length > 0) {
                const mappedChildren = await Promise.all(childRows.map(mapRow));
                for (let i = 0; i < childRows.length; i++) {
                    const parentId = childRows[i].parent;
                    if (!childrenByParent[parentId]) childrenByParent[parentId] = [];
                    childrenByParent[parentId].push(mappedChildren[i]);
                }
            }
        }

        return results.map(r => ({
            ...r,
            children: childrenByParent[r.id] || []
        }));
    }

    static async getPlacesGridSearchById(id: string, userId: string | undefined): Promise<any> {
        let { run, req, result, errorResponse } = await this.loadAuthorizedGridSearch(id, userId);

        if (errorResponse) {
            throw errorResponse;
        }

        // Resolve enrichResults: handles both string[] (place IDs) and object[] formats
        if (result && result.enrichResults && Array.isArray(result.enrichResults)) {
            const isIds = result.enrichResults.length > 0 && typeof result.enrichResults[0] === 'string';
            const placeIds = isIds
                ? result.enrichResults
                : result.enrichResults.map((r: any) => r.placeId || r.place_id).filter(Boolean);

            if (placeIds.length > 0) {
                // Fetch fresh metadata from the places table in chunks
                const chunkSize = 200;
                let allPlaces: any[] = [];
                for (let i = 0; i < placeIds.length; i += chunkSize) {
                    const { data: chunk } = await getPlacesChunk(placeIds.slice(i, i + chunkSize));
                    if (chunk) allPlaces.push(...chunk);
                }

                if (allPlaces.length > 0) {
                    const rowMap = new Map(allPlaces.map(p => [p.place_id, p]));

                    if (isIds) {
                        result.enrichResults = result.enrichResults.map((pid: string) => {
                            const freshRow = rowMap.get(pid);
                            if (freshRow) {
                                const { meta, ...topLevel } = freshRow;
                                const validTopLevel = Object.fromEntries(Object.entries(topLevel).filter(([, v]) => v != null));
                                const { pages, pageErrors, bodyHtml, ...cleanMeta } = meta || {};
                                return { ...cleanMeta, ...validTopLevel, place_id: pid };
                            }
                            return { place_id: pid };
                        });
                    } else {
                        result.enrichResults = result.enrichResults.map((node: any) => {
                            const pid = node.placeId || node.place_id;
                            const freshRow = rowMap.get(pid);
                            const { pages, pageErrors, bodyHtml, ...cleanNode } = node;
                            if (freshRow) {
                                const { meta, ...topLevel } = freshRow;
                                const validTopLevel = Object.fromEntries(Object.entries(topLevel).filter(([, v]) => v != null));
                                const { pages: _p, pageErrors: _pe, bodyHtml: _bh, ...cleanMeta } = meta || {};
                                return { ...cleanNode, ...cleanMeta, ...validTopLevel, place_id: pid, types: topLevel.types || cleanMeta.types || cleanNode.types || (cleanNode.type ? [cleanNode.type] : []) };
                            }
                            return { ...cleanNode, place_id: pid, types: cleanNode.types || (cleanNode.type ? [cleanNode.type] : []) };
                        });
                    }
                    // Recalculate total emails from fresh data
                    result.totalEmails = result.enrichResults.reduce((acc: number, node: any) => acc + (node.emails?.length || 0), 0);
                } else {
                    // No places found in DB — normalize shape
                    if (isIds) {
                        result.enrichResults = result.enrichResults.map((pid: string) => ({ place_id: pid }));
                    } else {
                        result.enrichResults = result.enrichResults.map((node: any) => {
                            const { pages, pageErrors, bodyHtml, ...cleanNode } = node;
                            return { ...cleanNode, place_id: cleanNode.placeId || cleanNode.place_id, types: cleanNode.types || (cleanNode.type ? [cleanNode.type] : []) };
                        });
                    }
                }
            } else if (!isIds) {
                // No place IDs to resolve, just strip heavy fields
                result.enrichResults = result.enrichResults.map((node: any) => {
                    const { pages, pageErrors, bodyHtml, ...cleanNode } = node;
                    return { ...cleanNode, place_id: cleanNode.placeId || cleanNode.place_id, types: cleanNode.types || (cleanNode.type ? [cleanNode.type] : []) };
                });
            }

            // Strip emails if public and not owner
            result.enrichResults = this.stripEmailsIfPublic(result.enrichResults, run?.settings?.is_public === true, run?.user_id === userId);
            // Recalculate total emails if stripped
            if (run?.settings?.is_public === true && run?.user_id !== userId) {
                result.totalEmails = 0;
            }
        } else {
            result = result || {};
        }

        return {
            request: req,
            result,
            areas: req.guided?.areas || [],
            status: run?.status || 'complete',
            isOwner: run?.user_id === userId,
            isPublic: run?.settings?.is_public === true
        };
    }

    static async getPlacesGridSearchRunState(id: string, userId: string | undefined): Promise<any> {
        const { run, errorResponse } = await this.loadAuthorizedGridSearch(id, userId);

        if (errorResponse) {
            throw errorResponse;
        }
        if (!run) {
            throw { status: 404, error: 'Run not found' };
        }

        const { data: searches } = await getPlaceSearchesByRunId(run.run_id);

        const allPlaceIds = new Set<string>();
        for (const s of (searches || [])) {
            if (Array.isArray(s.result_place_ids)) {
                for (const pid of s.result_place_ids) allPlaceIds.add(pid);
            }
        }

        let places: any[] = [];
        if (allPlaceIds.size > 0) {
            const ids = Array.from(allPlaceIds);
            const chunkSize = 200;
            for (let i = 0; i < ids.length; i += chunkSize) {
                const { data: chunk } = await getPlacesChunk(ids.slice(i, i + chunkSize), 'place_id, title, address, gps_coordinates, phone, website, types, meta, country, city');
                if (chunk) places.push(...chunk);
            }
        }

        const isPublic = run.settings?.is_public === true;
        const isOwner = run.user_id === userId;

        let placesOut = places;
        if (isPublic && !isOwner && places.length > 0) {
            placesOut = this.stripEmailsIfPublic(places, true, false) as any[];
        }

        let resultOut = run.result;
        if (isPublic && !isOwner && run.result) {
            if (typeof run.result === 'string') {
                try {
                    resultOut = JSON.parse(run.result);
                } catch {
                    resultOut = run.result;
                }
            } else if (typeof run.result === 'object' && run.result !== null) {
                resultOut = { ...run.result };
            }
            if (resultOut && typeof resultOut === 'object' && Array.isArray((resultOut as any).enrichResults)) {
                (resultOut as any).enrichResults = this.stripEmailsIfPublic((resultOut as any).enrichResults, true, false);
                (resultOut as any).totalEmails = 0;
            }
        }

        return {
            run: {
                id: run.id,
                runId: run.run_id,
                status: run.status,
                request: run.request,
                result: resultOut,
                createdAt: run.created_at,
                updatedAt: run.updated_at,
                isOwner,
                isPublic,
            },
            areasSearched: (searches || []).length,
            totalPlaces: placesOut.length,
            places: placesOut,
        };
    }

    static async patchPlacesGridSearchSettings(id: string, userId: string, body: any): Promise<any> {
        const { data: run, error: fetchErr } = await getGridSearchRunSettings(id, userId);

        if (fetchErr || !run) {
            throw { status: 404, error: 'Run not found' };
        }

        if (run.user_id !== userId) {
            throw { status: 403, error: 'Unauthorized to modify settings' };
        }

        const currentSettings = run.settings || {};
        const newSettings = {
            ...currentSettings,
            ...(body.is_public !== undefined ? { is_public: body.is_public } : {}),
            ...(body.shared_with !== undefined ? { shared_with: body.shared_with } : {})
        };

        const { data: updatedRun, error: updateErr } = await updateGridSearchRunSettings(id, newSettings);

        if (updateErr) throw { status: 500, error: updateErr.message };

        return { success: true, settings: updatedRun?.settings };
    }

    static async postPlacesGridSearch(userId: string, body: any, boss: PgBoss): Promise<{ jobId: string }> {
        const {
            guided,
            search,
            enrichers,
            types,
            limitPerArea,
            filterCountry,
            googleDomain,
            language,
            zoom,
            jobId: providedJobId,
            excludeTypes,
            parentId,
            viewportSearch,
            viewportCenter,
            viewportZoom
        } = body;

        // Ensure we have a valid search object
        const finalSearch = search || {
            types: types || [],
            limitPerArea,
            filterCountry,
            googleDomain,
            language,
            zoom
        };

        if (!finalSearch.q && (!finalSearch.types || finalSearch.types.length === 0)) {
            // Default if none provided
            finalSearch.types = ['business', 'shop', 'factory', 'service', 'industry', 'company'];
        }

        const runId = providedJobId || crypto.randomUUID();

        // Insert the run record so it's immediately visible
        const { error: initError } = await insertGridSearchRun({
            id: runId,
            user_id: userId,
            run_id: runId,
            request: body,
            status: 'searching',
            // parent: parentId || runId,
        });

        if (initError) {
            logger.error({ error: initError, runId }, '[PlacesLibrary] Failed to init grid_search_runs');
            throw initError;
        }

        const jobId = await boss.send(GRIDSEARCH_JOB_NAME, {
            userId,
            runId,
            guided,
            search: finalSearch,
            enrichers: enrichers || [],
            excludeTypes: excludeTypes || [],
            parentId,
            viewportSearch,
            viewportCenter,
            viewportZoom
        } as any, { id: runId, retryLimit: 0 });

        logger.info({ jobId, runId, userId, viewportSearch }, '[PlacesLibrary] Queued grid search job');
        return { jobId: jobId || runId };
    }

    static async postPlacesGridSearchRetry(runId: string, userId: string, boss: PgBoss): Promise<{ jobId: string }> {
        const { data: run, error: runErr } = await getGridSearchRunForRetryExpand(runId, userId);

        if (runErr || !run) {
            throw { status: 404, error: 'Run not found' };
        }

        const requestPayload = typeof run.request === 'string' ? JSON.parse(run.request) : run.request;
        const finalSearch = requestPayload.search || {
            types: requestPayload.types || [],
            limitPerArea: requestPayload.limitPerArea,
            filterCountry: requestPayload.filterCountry,
            googleDomain: requestPayload.googleDomain,
            language: requestPayload.language,
            zoom: requestPayload.zoom
        };

        await updateGridSearchRun(runId, { status: 'searching', result: null });

        const newJobId = await boss.send(GRIDSEARCH_JOB_NAME, {
            userId,
            runId: run.run_id,
            guided: requestPayload.guided,
            search: finalSearch,
            enrichers: requestPayload.enrichers,
            excludeTypes: requestPayload.excludeTypes || []
        } as any, { retryLimit: 0 });

        return { jobId: newJobId || runId };
    }

    static async postPlacesGridSearchExpand(runId: string, userId: string, body: any, boss: PgBoss): Promise<{ childRunId: string, freshAreasCount: number, totalAreasCount: number }> {
        const { data: run, error: runErr } = await getGridSearchRunForRetryExpand(runId, userId);

        if (runErr || !run) {
            throw { status: 404, error: 'Run not found' };
        }

        const requestPayload = typeof run.request === 'string' ? JSON.parse(run.request) : run.request;
        const isViewportSearch = !!body.viewportSearch;
        const newAreas: { gid: string; name: string; level: number; raw?: any }[] = body.areas || [];
        const newSettings = body.settings || null;
        if (!isViewportSearch && newAreas.length === 0) {
            throw { status: 400, error: 'No areas provided' };
        }

        const existingGids = new Set(
            (requestPayload.guided?.areas || []).map((a: any) => a.gid)
        );
        const freshAreas = newAreas.filter(a => !existingGids.has(a.gid));
        if (!isViewportSearch && freshAreas.length === 0) {
            throw { status: 400, error: 'All provided areas have already been searched' };
        }

        let excludeTypes: string[] = requestPayload.excludeTypes || [];
        try {
            const { data: secrets } = await getUserSecrets(userId) as any;
            const savedExcludes = (secrets?.settings as any)?.gridsearch_exclude_types;
            if (Array.isArray(savedExcludes)) {
                excludeTypes = savedExcludes;
            }
        } catch (e) {
            logger.warn({ err: e }, '[PlacesProduct] Failed to fetch user exclude types, using stored ones');
        }

        const unionAreas = [
            ...(requestPayload.guided?.areas || []),
            ...freshAreas
        ];

        const mergedSettings = newSettings
            ? { ...(requestPayload.guided?.settings || {}), ...newSettings }
            : requestPayload.guided?.settings;

        const updatedRequest = {
            ...requestPayload,
            guided: {
                ...requestPayload.guided,
                areas: unionAreas,
                settings: mergedSettings,
            },
            region: isViewportSearch ? 'Viewport Search' : unionAreas.map((a: any) => a.name).join(' | '),
            excludeTypes,
        };

        if (isViewportSearch) {
            updatedRequest.viewportSearch = true;
            updatedRequest.viewportCenter = body.viewportCenter;
            updatedRequest.viewportZoom = body.viewportZoom;
        }

        const finalSearch = requestPayload.search || {
            types: requestPayload.types || [],
            limitPerArea: requestPayload.limitPerArea,
            filterCountry: requestPayload.filterCountry,
            googleDomain: requestPayload.googleDomain,
            language: requestPayload.language,
            zoom: requestPayload.zoom
        };

        if (isViewportSearch && body.types) {
            finalSearch.types = body.types;
        }

        await updateGridSearchRun(runId, { status: 'searching' });


        const childRunId = crypto.randomUUID();
        const { error: childInsertErr } = await insertGridSearchRun({
            id: childRunId,
            user_id: userId,
            run_id: childRunId,
            parent: runId,
            request: {
                ...updatedRequest,
                guided: { ...updatedRequest.guided, areas: freshAreas },
            },
            status: 'searching',
        });
        if (childInsertErr) {
            logger.error({ error: childInsertErr }, '[PlacesProduct] Failed to insert child grid_search_runs');
        }

        await boss.send(GRIDSEARCH_JOB_NAME, {
            userId,
            runId: childRunId,
            parentId: runId,
            guided: {
                ...requestPayload.guided,
                areas: freshAreas,
                settings: mergedSettings,
            },
            search: finalSearch,
            enrichers: requestPayload.enrichers,
            excludeTypes,
            ...(isViewportSearch ? {
                viewportSearch: true,
                viewportCenter: body.viewportCenter,
                viewportZoom: body.viewportZoom
            } : {})
        } as any, { id: childRunId, retryLimit: 0 });

        return { childRunId, freshAreasCount: freshAreas.length, totalAreasCount: unionAreas.length };
    }

    static async deletePlacesGridSearchById(id: string, userId: string, boss: PgBoss | undefined): Promise<void> {
        const { error: deleteError } = await deleteGridSearchRun(id, userId);

        if (deleteError) throw { status: 500, error: deleteError.message };

        if (boss) {
            await deletePgBossGridSearchJobs(boss, id);
        }
    }

    static async getPlaceById(place_id: string): Promise<any> {
        const { data, error } = await getPlaceById(place_id);

        if (error || !data) {
            throw { status: 404, error: 'Place not found' };
        }

        const { meta, ...topLevel } = data;
        const { pages, pageErrors, bodyHtml, ...cleanMeta } = meta || {};
        return {
            ...cleanMeta,
            ...Object.fromEntries(Object.entries(topLevel).filter(([, v]) => v != null)),
            place_id,
        };
    }

    private static async getSerpApiKey(userId?: string): Promise<string | null> {
        if (process.env.SERPAPI_KEY) return process.env.SERPAPI_KEY;
        if (!userId) return null;
        const settings = await fetchUserSecretsSettingsPg(userId);
        return (settings as any)?.api_keys?.serpapi_api_key || null;
    }

    static async getPlacePhotos(place_id: string, userId: string): Promise<any> {
        const { data: dbRow } = await getPlaceMetaById(place_id);

        const existingMedia = dbRow?.meta?.google_media;
        if (existingMedia?.photos?.length) {
            return existingMedia;
        }

        const apiKey = await this.getSerpApiKey(userId);
        if (!apiKey) {
            throw { status: 400, error: 'SerpAPI key not found. Please add it to your profile settings.' };
        }

        let dataId = dbRow?.meta?.data_id;
        if (!dataId) {
            const lookupUrl = `https://serpapi.com/search.json?engine=google_maps&place_id=${encodeURIComponent(place_id)}&api_key=${apiKey}`;
            //logger.info({ place_id }, '[PlacesLibrary] Looking up data_id via SerpAPI google_maps');
            const lookupRes = await fetch(lookupUrl);
            if (!lookupRes.ok) {
                const errText = await lookupRes.text();
                logger.error({ status: lookupRes.status, errText }, '[PlacesLibrary] SerpAPI lookup failed');
                throw { status: 502, error: 'Failed to look up place on SerpAPI' };
            }
            const lookupData = await lookupRes.json();
            dataId = lookupData.place_results?.data_id;
            if (!dataId) {
                throw { status: 404, error: 'Could not resolve data_id for this place' };
            }
        }

        const photosUrl = `https://serpapi.com/search.json?engine=google_maps_photos&data_id=${encodeURIComponent(dataId)}&api_key=${apiKey}`;
        //logger.info({ place_id, dataId }, '[PlacesLibrary] Fetching photos via SerpAPI');
        const photosRes = await fetch(photosUrl);
        if (!photosRes.ok) {
            const errText = await photosRes.text();
            logger.error({ status: photosRes.status, errText }, '[PlacesLibrary] SerpAPI photos fetch failed');
            throw { status: 502, error: 'Failed to fetch photos from SerpAPI' };
        }
        const photosData = await photosRes.json();

        if (photosData?.photos?.length && dbRow?.meta) {
            const updatedMeta = { ...dbRow.meta, google_media: photosData, data_id: dataId };
            await updatePlaceMeta(place_id, updatedMeta);
        }

        return photosData;
    }

    static async getPlacesGridSearchExportData(search: string, userId: string | undefined): Promise<any> {
        const { run, req, result, errorResponse } = await PlacesLibrary.loadAuthorizedGridSearch(search, userId);

        if (errorResponse) {
            throw { status: errorResponse.status, error: errorResponse.error === 'Search not found' ? 'Search not found in Database or Active Jobs' : errorResponse.error };
        }

        const enrichPlaceIds = Array.isArray(result?.enrichResults) ? result.enrichResults : [];
        let resolvedLocations: any[] = [];
        if (enrichPlaceIds.length > 0 && typeof enrichPlaceIds[0] === 'string') {
            try {
                resolvedLocations = await getLocationsByPlaceIds(enrichPlaceIds);
            } catch (e) {
                logger.warn({ err: e }, 'Failed to resolve enrichResults place_ids for export');
            }
        } else {
            resolvedLocations = enrichPlaceIds;
        }

        const enumReq = req?.enumerate || {};
        const store = new PgGridSearchStateStore(userId || 'anonymous');
        let state: any = null;
        try {
            state = await store.getEnum(enumReq.region || req?.guided?.areas?.[0]?.name || '', enumReq.level || '', '');
        } catch (e) { }

        const gridStats = result?.gridStats;
        const searchStats = result?.searchStats;

        const reportData: any = {
            regionName: enumReq.region || req?.guided?.areas?.[0]?.name || req.search?.types?.join(', ') || 'Unknown Region',
            preset: req as any,
            enumResult: state ? state.result : { result: { areas: req?.guided?.areas || [], gridStats } } as any,
            searchResult: {
                areas: state ? state.result?.areas || [] : req?.guided?.areas || [],
                results: resolvedLocations,
                filtered: result?.filtered || searchStats?.filtered || 0,
                apiCalls: result?.apiCalls || searchStats?.apiCalls || 0,
                freshApiCalls: result?.freshApiCalls || result?.searchApiCalls || 0,
                totalScannedSqKm: result?.totalScannedSqKm || searchStats?.totalScannedSqKm || 0,
                totalResults: searchStats?.totalResults || resolvedLocations.length,
                totalPopulation: result?.totalPopulation || searchStats?.totalPopulation || 0
            },
            enrichResults: resolvedLocations,
            timing: {
                enumMs: result?.enumMs,
                searchMs: result?.searchMs,
                enrichMs: result?.enrichMs,
                totalMs: result?.totalMs || result?.durationMs
            },
            totalEmails: result?.totalEmails || resolvedLocations.reduce((acc: number, node: any) => acc + (node.emails?.length || 0), 0),
            totalPagesScraped: result?.totalPagesScraped || 0,
            freshApiCalls: result?.freshApiCalls || 0,
            enumCached: state ? true : false,
            pipelineName: req?.name || req?.search?.name || req?.search?.types?.join(', ') || 'GridSearch',
            waypointCount: result?.waypointCount || gridStats?.totalWaypoints || 0,
        };

        const isPublic = run?.settings?.is_public === true;
        const isOwner = run?.user_id === userId;

        if (isPublic && !isOwner) {
            reportData.enrichResults = this.stripEmailsIfPublic(reportData.enrichResults, isPublic, isOwner);
            reportData.searchResult.results = this.stripEmailsIfPublic(reportData.searchResult.results, isPublic, isOwner);
            reportData.totalEmails = 0;
        }

        return reportData;
    }
    static async mergeGridSearches(targetId: string, sourceId: string, userId: string): Promise<number> {
        const { run: target, errorResponse: targetErr } = await this.loadAuthorizedGridSearch(targetId, userId);
        if (targetErr) throw targetErr;

        const { run: source, errorResponse: sourceErr } = await this.loadAuthorizedGridSearch(sourceId, userId);
        if (sourceErr) throw sourceErr;

        if (!target || !source) throw { status: 404, error: 'Run not found' };

        // 1. Merge Request
        const isReqString = typeof target.request === 'string' || typeof source.request === 'string';
        const targetReq = typeof target.request === 'string' ? JSON.parse(target.request) : target.request || {};
        const sourceReq = typeof source.request === 'string' ? JSON.parse(source.request) : source.request || {};

        const targetAreas = targetReq.guided?.areas || [];
        const sourceAreas = sourceReq.guided?.areas || [];

        const areaMap = new Map(targetAreas.map((a: any) => [a.gid, a]));
        for (const area of sourceAreas) {
            if (!areaMap.has(area.gid)) {
                areaMap.set(area.gid, area);
            }
        }

        const mergedAreas = Array.from(areaMap.values());
        const union = (a: string[] = [], b: string[] = []) => Array.from(new Set([...(a || []), ...(b || [])]));

        const newRequest = {
            ...targetReq,
            types: union(targetReq.types, sourceReq.types),
            enrichers: union(targetReq.enrichers, sourceReq.enrichers),
            excludeTypes: union(targetReq.excludeTypes, sourceReq.excludeTypes),
            guided: {
                ...(targetReq.guided || {}),
                areas: mergedAreas
            },
            // Update region name to reflect union
            region: mergedAreas.map((a: any) => a.name).slice(0, 5).join(' | ') + (mergedAreas.length > 5 ? ' ...' : '')
        };

        // 2. Merge Results
        const isResultString = typeof target.result === 'string' || typeof source.result === 'string';
        const targetResult = typeof target.result === 'string' ? JSON.parse(target.result) : target.result || {};
        const sourceResult = typeof source.result === 'string' ? JSON.parse(source.result) : source.result || {};

        const targetEnriched = Array.isArray(targetResult.enrichResults) ? targetResult.enrichResults : [];
        const sourceEnriched = Array.isArray(sourceResult.enrichResults) ? sourceResult.enrichResults : [];

        const getPid = (item: any) => typeof item === 'string' ? item : (item.place_id || item.placeId);

        const resultMap = new Map(targetEnriched.map((item: any) => [getPid(item), item]));
        for (const item of sourceEnriched) {
            const pid = getPid(item);
            if (!resultMap.has(pid)) {
                resultMap.set(pid, item);
            }
        }

        const mergedEnriched = Array.from(resultMap.values());

        // Merge stats
        const targetStats = targetResult.searchStats || {};
        const sourceStats = sourceResult.searchStats || {};

        const newResult = {
            ...targetResult,
            enrichResults: mergedEnriched,
            totalResults: mergedEnriched.length,
            // Recalculate emails if they are objects
            totalEmails: mergedEnriched.reduce((acc: number, node: any) => acc + (typeof node !== 'string' ? (node.emails?.length || 0) : 0), 0),
            searchStats: {
                ...targetStats,
                apiCalls: (targetStats.apiCalls || 0) + (sourceStats.apiCalls || 0),
                areaCount: (targetStats.areaCount || 0) + (sourceStats.areaCount || 0),
                totalScannedSqKm: (targetStats.totalScannedSqKm || 0) + (sourceStats.totalScannedSqKm || 0),
                totalResults: (targetStats.totalResults || 0) + (sourceStats.totalResults || 0),
                totalPopulation: (targetStats.totalPopulation || 0) + (sourceStats.totalPopulation || 0)
            }
        };

        // 3. Save changes
        const { error: updateErr } = await updateGridSearchRun(targetId, {
            request: isReqString ? JSON.stringify(newRequest) : newRequest,
            result: isResultString ? JSON.stringify(newResult) : newResult,
            updated_at: new Date().toISOString()
        });

        if (updateErr) throw { status: 500, error: updateErr.message };

        return mergedEnriched.length;
    }

    static async postPlacesGridSearchControl(
        runId: string,
        userId: string,
        action: 'pause' | 'resume' | 'cancel',
        udsManager: GridSearchUdsManager,
    ): Promise<void> {
        const { data: run, error } = await getGridSearchRunForRetryExpand(runId, userId);
        if (error || !run) {
            throw { status: 404, error: 'Run not found' };
        }
        const st = run.status;
        if (st !== 'searching' && st !== 'enriching') {
            throw { status: 400, error: 'Run is not active' };
        }

        try {
            await sendGridSearchControl(udsManager, userId, runId, action);
        } catch (e: any) {
            if (action !== 'cancel') throw e;
            logger.warn(
                { runId, err: e?.message },
                '[PlacesLibrary] UDS control failed on cancel; persisting DB stop anyway (orphan / worker down)',
            );
        }

        // Stop: always leave `searching`/`enriching` — UDS may be gone for broken runs; pipeline may overwrite later.
        if (action === 'cancel') {
            let prevResult: any = run.result;
            if (typeof prevResult === 'string') {
                try {
                    prevResult = JSON.parse(prevResult);
                } catch {
                    prevResult = {};
                }
            }
            if (!prevResult || typeof prevResult !== 'object') prevResult = {};
            const nextResult = { ...prevResult, stopped: true, clientStop: true };
            const { error: uErr } = await updateGridSearchRun(runId, {
                status: 'complete',
                result: nextResult,
                updated_at: new Date().toISOString(),
            });
            if (uErr) {
                logger.error({ runId, error: uErr }, '[PlacesLibrary] Failed to persist stop after cancel');
                throw { status: 500, error: 'Failed to update run after stop' };
            }
        }
    }
}
