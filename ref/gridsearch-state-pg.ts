/**
 * Postgres counterparts for SupabaseGridSearchStateStore and SupabasePipelineStore.
 *
 * Tables covered here that db-places-pg.ts does NOT yet reach:
 *   public.grid_areas         — GridSearchStateStore enum cache
 *   public.grid_area_places   — link table (grid_area_id × place_id)
 *   public.place_searches     — per-area search cache (state-store interface)
 *
 * `places` table read/write is delegated to db-places-pg.ts where functions exist;
 * the upsert below is a thin duplicate kept local to avoid circular imports.
 */
import crypto from 'crypto';
import { getServicePool } from '../../commons/postgres.js';
import type { GridSearchStateStore, GridAreaState, GridEnumState, AreaSearchParams } from './gridsearch-state.js';
import { areaKey } from './gridsearch-state.js';
import type { LocationCacheProvider } from './gridsearch-googlemaps.js';
import type { EnrichedNode } from './gridsearch-enrich.js';

function md5(str: string): string {
    return crypto.createHash('md5').update(str).digest('hex');
}

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

// ─── PgPipelineStore ──────────────────────────────────────────────────────────

/**
 * Postgres-backed enrichment pipeline store.
 * Mirrors SupabasePipelineStore: reads/writes `places.meta` JSONB by place_id.
 */
export class PgPipelineStore implements LocationCacheProvider<EnrichedNode> {

    async get(placeId: string): Promise<EnrichedNode | undefined> {
        const pool = getServicePool();
        const { rows } = await pool.query(
            `SELECT meta FROM public.places WHERE place_id = $1`,
            [placeId],
        );
        const meta = rows[0]?.meta;
        return meta ? (meta as EnrichedNode) : undefined;
    }

    async set(placeId: string, node: EnrichedNode): Promise<void> {
        const pool = getServicePool();
        await pool.query(
            `INSERT INTO public.places (place_id, title, website, address, types, meta, updated_at)
             VALUES ($1, $2, $3, $4, $5, $6, NOW())
             ON CONFLICT (place_id)
             DO UPDATE SET
               title      = EXCLUDED.title,
               website    = EXCLUDED.website,
               address    = EXCLUDED.address,
               types      = EXCLUDED.types,
               meta       = EXCLUDED.meta,
               updated_at = NOW()`,
            [
                placeId,
                node.title,
                node.website ?? null,
                node.address ?? null,
                node.type ? JSON.stringify([node.type]) : null,
                JSON.stringify(node),
            ],
        );
    }
}
