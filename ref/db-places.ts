/**
 * Postgres data layer for the places product (`places/index.ts`, `places/places.ts`, `places/db.ts` pattern).
 * `gridsearch-uds.ts` job completion updates map to `updateGridSearchRunPg` helpers.
 * **PgBoss** (`deletePgBossGridSearchJobs`, queue wiring) stays in `db.ts` / workers — not duplicated here.
 *
 * **Cross-feature:** export-to-contacts uses `insertContactsBulkReturningIdsPg` / `upsertContactGroupMembersPg`
 * from `../contacts/db-imap-pg.js` (re-exported below).
 */
import { getServicePool } from '@/commons/postgres.js';
import { getPgBossSchemaName } from '@/jobs/boss/boss-schema.js';
import { logger } from './logger.js';
export { fetchUserSecretsSettingsPg } from '../serving/db/db-users.js';
export { insertContactsBulkReturningIdsPg, upsertContactGroupMembersPg } from '../contacts/db-imap-pg.js';

const jsonParam = (v: unknown) => JSON.stringify(v === undefined ? null : v);

function quoteIdent(name: string): string {
    return `"${name.replace(/"/g, '""')}"`;
}

export type PgErrorLike = { message: string; code?: string } | null;

// ─── searches (shared cache) ─────────────────────────────────────────────────

export async function getSearchByHash(inputHash: string): Promise<{ result_place_ids: string[] } | null> {
    const pool = getServicePool();
    try {
        const res = await pool.query(`SELECT result_place_ids FROM public.searches WHERE input_hash = $1 LIMIT 1`, [
            inputHash,
        ]);
        return res.rows[0] ?? null;
    } catch (err: any) {
        logger.error({ err: err }, 'db-places-pg: getSearchByHashPg');
        return null;
    }
}

export async function storeSearch(
    inputHash: string,
    inputParams: unknown,
    placeIds: string[],
): Promise<{ error: PgErrorLike }> {
    const pool = getServicePool();
    try {
        await pool.query(
            `INSERT INTO public.searches (input_hash, input_params, result_place_ids, created_at)
             VALUES ($1, $2::jsonb, $3::text[], $4::timestamptz)
             ON CONFLICT (input_hash) DO UPDATE SET
               input_params = EXCLUDED.input_params,
               result_place_ids = EXCLUDED.result_place_ids,
               created_at = EXCLUDED.created_at`,
            [inputHash, jsonParam(inputParams), placeIds, new Date().toISOString()],
        );
        return { error: null };
    } catch (err: any) {
        logger.error({ err: err }, 'db-places-pg: storeSearchPg');
        return { error: { message: String(err?.message ?? err) } };
    }
}

// ─── places ──────────────────────────────────────────────────────────────────

const PLACES_JSONB_KEYS = new Set([
    'gps_coordinates',
    'operating_hours',
    'raw_data',
    'meta',
    'media',
    'contacts',
]);
const PLACES_ALLOWED_KEYS = new Set([
    'place_id',
    'title',
    'description',
    'address',
    'gps_coordinates',
    'phone',
    'website',
    'operating_hours',
    'thumbnail',
    'types',
    'raw_data',
    'created_at',
    'updated_at',
    'continent',
    'country',
    'city',
    'meta',
    'media',
    'contacts',
    'user_id',
]);

function filterPlaceRow(row: Record<string, unknown>): [string, unknown][] {
    return Object.entries(row).filter(([k, v]) => PLACES_ALLOWED_KEYS.has(k) && v !== undefined);
}

export async function getLocationsByPlaceIds(placeIds: string[]): Promise<any[]> {
    if (placeIds.length === 0) return [];
    const pool = getServicePool();
    try {
        const res = await pool.query(`SELECT * FROM public.places WHERE place_id = ANY($1::text[])`, [placeIds]);
        return res.rows || [];
    } catch (err: any) {
        logger.error({ err: err }, 'db-places-pg: getLocationsByPlaceIdsPg');
        throw err;
    }
}

export async function getLocationsMeta(placeIds: string[]): Promise<{ place_id: string; meta: unknown }[]> {
    if (placeIds.length === 0) return [];
    const pool = getServicePool();
    try {
        const res = await pool.query(`SELECT place_id, meta FROM public.places WHERE place_id = ANY($1::text[])`, [
            placeIds,
        ]);
        return res.rows || [];
    } catch (err: any) {
        logger.error({ err: err }, 'db-places-pg: getLocationsMetaPg');
        return [];
    }
}

async function upsertSinglePlace(row: Record<string, unknown>): Promise<void> {
    const entries = filterPlaceRow(row);
    if (entries.length === 0 || !row.place_id) return;
    const pool = getServicePool();
    const keys = entries.map(([k]) => k);
    const cols = keys.map(quoteIdent);
    const vals: unknown[] = [];
    const placeholders = keys.map((k, i) => {
        const raw = entries[i][1];
        if (PLACES_JSONB_KEYS.has(k)) {
            vals.push(jsonParam(raw));
            return `$${vals.length}::jsonb`;
        }
        if (k === 'types') {
            vals.push(raw);
            return `$${vals.length}::text[]`;
        }
        vals.push(raw);
        return `$${vals.length}`;
    });
    const updateSet = keys
        .filter((k) => k !== 'place_id')
        .map((k) => `${quoteIdent(k)} = EXCLUDED.${quoteIdent(k)}`)
        .join(', ');
    const sql = `INSERT INTO public.places (${cols.join(', ')}) VALUES (${placeholders.join(', ')})
    ON CONFLICT (place_id) DO UPDATE SET ${updateSet}`;
    await pool.query(sql, vals);
}

export async function upsertLocations(locations: any[]): Promise<void> {
    if (locations.length === 0) return;
    for (const loc of locations) {
        await upsertSinglePlace(loc as Record<string, unknown>);
    }
}

const PLACES_ALLOWED_SELECT = new Set([
    'place_id',
    'title',
    'description',
    'address',
    'gps_coordinates',
    'phone',
    'website',
    'operating_hours',
    'thumbnail',
    'types',
    'raw_data',
    'created_at',
    'updated_at',
    'continent',
    'country',
    'city',
    'meta',
    'media',
    'contacts',
    'user_id',
]);

function parsePlacesSelectFields(selectFields: string): string {
    if (selectFields === '*') return '*';
    const parts = selectFields
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    for (const p of parts) {
        if (!PLACES_ALLOWED_SELECT.has(p)) {
            throw new Error(`db-places-pg: disallowed select field: ${p}`);
        }
    }
    return parts.map(quoteIdent).join(', ');
}

export async function getPlacesChunk(
    placeIds: string[],
    selectFields: string = '*',
): Promise<{ data: any[] | null; error: PgErrorLike }> {
    if (placeIds.length === 0) return { data: [], error: null };
    let proj: string;
    try {
        proj = parsePlacesSelectFields(selectFields);
    } catch (err: any) {
        return { data: null, error: { message: String(err?.message ?? err) } };
    }
    const pool = getServicePool();
    try {
        const res = await pool.query(`SELECT ${proj} FROM public.places WHERE place_id = ANY($1::text[])`, [placeIds]);
        return { data: res.rows || [], error: null };
    } catch (err: any) {
        logger.error({ err: err }, 'db-places-pg: getPlacesChunkPg');
        return { data: null, error: { message: String(err?.message ?? err) } };
    }
}

export async function getPlacesTypes(): Promise<{ rows: { types: string[] | null }[]; error: PgErrorLike }> {
    const pool = getServicePool();
    try {
        const res = await pool.query(`SELECT types FROM public.places WHERE types IS NOT NULL`);
        return { rows: res.rows || [], error: null };
    } catch (err: any) {
        logger.error({ err: err }, 'db-places-pg: getPlacesTypesPg');
        return { rows: [], error: { message: String(err?.message ?? err) } };
    }
}

export async function getPlaceById(placeId: string): Promise<{ data: any | null; error: PgErrorLike }> {
    const pool = getServicePool();
    try {
        const res = await pool.query(`SELECT * FROM public.places WHERE place_id = $1 LIMIT 1`, [placeId]);
        if (!res.rows[0]) return { data: null, error: { message: 'not found', code: 'PGRST116' } };
        return { data: res.rows[0], error: null };
    } catch (err: any) {
        return { data: null, error: { message: String(err?.message ?? err) } };
    }
}

export async function getPlaceMetaById(placeId: string): Promise<{ data: { meta: Record<string, any> } | null; error: PgErrorLike }> {
    const pool = getServicePool();
    try {
        const res = await pool.query(`SELECT meta FROM public.places WHERE place_id = $1 LIMIT 1`, [placeId]);
        return { data: res.rows[0] ?? null, error: null };
    } catch (err: any) {
        return { data: null, error: { message: String(err?.message ?? err) } };
    }
}

export async function updatePlaceMeta(placeId: string, meta: unknown): Promise<{ error: PgErrorLike }> {
    const pool = getServicePool();
    try {
        await pool.query(`UPDATE public.places SET meta = $1::jsonb, updated_at = now() WHERE place_id = $2`, [
            jsonParam(meta),
            placeId,
        ]);
        return { error: null };
    } catch (err: any) {
        logger.error({ err: err }, 'db-places-pg: updatePlaceMetaPg');
        return { error: { message: String(err?.message ?? err) } };
    }
}

// ─── grid_search_runs ─────────────────────────────────────────────────────────

const GRID_RUN_INSERT_KEYS = new Set([
    'id',
    'user_id',
    'run_id',
    'request',
    'result',
    'status',
    'parent',
    'settings',
    'created_at',
    'updated_at',
]);

const GRID_RUN_JSONB_KEYS = new Set(['request', 'result', 'settings']);

function filterGridRunInsert(row: Record<string, unknown>): [string, unknown][] {
    return Object.entries(row).filter(([k, v]) => GRID_RUN_INSERT_KEYS.has(k) && v !== undefined);
}

export async function getGridSearchRunById(
    idOrRunId: string,
): Promise<{ data: any | null; error: PgErrorLike }> {
    const pool = getServicePool();
    try {
        const res = await pool.query(
            `SELECT * FROM public.grid_search_runs
             WHERE id::text = $1 OR run_id = $1
             LIMIT 1`,
            [idOrRunId],
        );
        return { data: res.rows[0] ?? null, error: null };
    } catch (err: any) {
        return { data: null, error: { message: String(err?.message ?? err) } };
    }
}

export async function getUserGridSearchRuns(userId: string): Promise<{ data: any[] | null; error: PgErrorLike }> {
    const pool = getServicePool();
    try {
        const res = await pool.query(
            `SELECT id, request, result, status, created_at, history
             FROM public.grid_search_runs
             WHERE user_id = $1::uuid AND parent IS NULL
             ORDER BY created_at DESC`,
            [userId],
        );
        return { data: res.rows || [], error: null };
    } catch (err: any) {
        return { data: null, error: { message: String(err?.message ?? err) } };
    }
}

export async function getChildGridSearchRuns(
    parentIds: string[],
): Promise<{ data: any[] | null; error: PgErrorLike }> {
    if (parentIds.length === 0) return { data: [], error: null };
    const pool = getServicePool();
    try {
        const res = await pool.query(
            `SELECT id, parent, request, result, status, created_at, history
             FROM public.grid_search_runs
             WHERE parent = ANY($1::uuid[])
             ORDER BY created_at ASC`,
            [parentIds],
        );
        return { data: res.rows || [], error: null };
    } catch (err: any) {
        return { data: null, error: { message: String(err?.message ?? err) } };
    }
}

export async function getGridSearchRunSettings(
    id: string,
    userId: string,
): Promise<{ data: any | null; error: PgErrorLike }> {
    const pool = getServicePool();
    try {
        const res = await pool.query(
            `SELECT id, user_id, settings FROM public.grid_search_runs
             WHERE id = $1::uuid AND user_id = $2::uuid
             LIMIT 1`,
            [id, userId],
        );
        if (!res.rows[0]) return { data: null, error: { message: 'not found', code: 'PGRST116' } };
        return { data: res.rows[0], error: null };
    } catch (err: any) {
        return { data: null, error: { message: String(err?.message ?? err) } };
    }
}

export async function updateGridSearchRunSettings(
    id: string,
    newSettings: unknown,
): Promise<{ data: { settings: unknown } | null; error: PgErrorLike }> {
    const pool = getServicePool();
    try {
        const res = await pool.query(
            `UPDATE public.grid_search_runs
             SET settings = $1::jsonb, updated_at = now()
             WHERE id = $2::uuid
             RETURNING settings`,
            [jsonParam(newSettings), id],
        );
        return { data: res.rows[0] ?? null, error: null };
    } catch (err: any) {
        return { data: null, error: { message: String(err?.message ?? err) } };
    }
}

export async function insertGridSearchRun(data: Record<string, unknown>): Promise<{ error: PgErrorLike }> {
    const pool = getServicePool();
    const entries = filterGridRunInsert(data);
    if (entries.length === 0) return { error: { message: 'insertGridSearchRunPg: no columns' } };
    const keys = entries.map(([k]) => k);
    const cols = keys.map(quoteIdent);
    const vals: unknown[] = [];
    const placeholders = keys.map((k, i) => {
        const raw = entries[i][1];
        if (GRID_RUN_JSONB_KEYS.has(k)) {
            vals.push(jsonParam(raw));
            return `$${vals.length}::jsonb`;
        }
        if (k === 'id' || k === 'user_id' || k === 'parent') {
            vals.push(raw);
            return `$${vals.length}::uuid`;
        }
        vals.push(raw);
        return `$${vals.length}`;
    });
    const sql = `INSERT INTO public.grid_search_runs (${cols.join(', ')}) VALUES (${placeholders.join(', ')})`;
    try {
        await pool.query(sql, vals);
        return { error: null };
    } catch (err: any) {
        logger.error({ err: err }, 'db-places-pg: insertGridSearchRunPg');
        return { error: { message: String(err?.message ?? err) } };
    }
}

const GRID_RUN_UPDATE_KEYS = new Set([
    'request',
    'result',
    'status',
    'settings',
    'updated_at',
    'parent',
]);

export async function updateGridSearchRun(
    id: string,
    updates: Record<string, unknown>,
): Promise<{ error: PgErrorLike }> {
    const pool = getServicePool();
    const entries = Object.entries(updates).filter(([k, v]) => GRID_RUN_UPDATE_KEYS.has(k) && v !== undefined);
    if (entries.length === 0) return { error: null };
    const setParts: string[] = [];
    const vals: unknown[] = [];
    let i = 1;
    for (const [k, v] of entries) {
        if (GRID_RUN_JSONB_KEYS.has(k)) {
            setParts.push(`${quoteIdent(k)} = $${i++}::jsonb`);
            vals.push(jsonParam(v));
        } else if (k === 'updated_at') {
            setParts.push(`${quoteIdent(k)} = $${i++}::timestamptz`);
            vals.push(v);
        } else {
            setParts.push(`${quoteIdent(k)} = $${i++}`);
            vals.push(v);
        }
    }
    vals.push(id);
    const sql = `UPDATE public.grid_search_runs SET ${setParts.join(', ')} WHERE id = $${i}::uuid`;
    try {
        await pool.query(sql, vals);
        return { error: null };
    } catch (err: any) {
        logger.error({ err: err }, 'db-places-pg: updateGridSearchRunPg');
        return { error: { message: String(err?.message ?? err) } };
    }
}

export async function getGridSearchRunForRetryExpand(
    id: string,
    userId: string,
): Promise<{ data: any | null; error: PgErrorLike }> {
    const pool = getServicePool();
    try {
        const res = await pool.query(
            `SELECT * FROM public.grid_search_runs WHERE id = $1::uuid AND user_id = $2::uuid LIMIT 1`,
            [id, userId],
        );
        if (!res.rows[0]) return { data: null, error: { message: 'not found', code: 'PGRST116' } };
        return { data: res.rows[0], error: null };
    } catch (err: any) {
        return { data: null, error: { message: String(err?.message ?? err) } };
    }
}

export async function deleteGridSearchRun(id: string, userId: string): Promise<{ error: PgErrorLike }> {
    const pool = getServicePool();
    try {
        await pool.query(`DELETE FROM public.grid_search_runs WHERE id = $1::uuid AND user_id = $2::uuid`, [
            id,
            userId,
        ]);
        return { error: null };
    } catch (err: any) {
        return { error: { message: String(err?.message ?? err) } };
    }
}

// ─── place_searches ────────────────────────────────────────────────────────────

export async function getPlaceSearchesByRunId(runId: string): Promise<{ data: any[] | null; error: PgErrorLike }> {
    const pool = getServicePool();
    try {
        const res = await pool.query(
            `SELECT input_hash, input_params, result_place_ids, created_at
             FROM public.place_searches
             WHERE run_id = $1`,
            [runId],
        );
        return { data: res.rows || [], error: null };
    } catch (err: any) {
        return { data: null, error: { message: String(err?.message ?? err) } };
    }
}

// ─── pgboss ───────────────────────────────────────────────────────────────────

export async function deletePgBossGridSearchJobs(boss: any, id: string): Promise<void> {
    try {
        const db = boss.db;
        if (db && typeof db.executeSql === 'function') {
            const sch = getPgBossSchemaName();
            await db.executeSql(`DELETE FROM ${sch}.job WHERE id = $1`, [id]);
            await db.executeSql(`DELETE FROM ${sch}.archive WHERE id = $1`, [id]);
        }
    } catch (err: any) {
        logger.warn(err, 'Failed to delete associated pgboss jobs');
    }
}

// ─── Pg-suffix aliases (for callers that import with the Pg suffix) ───────────

export {
    getLocationsByPlaceIds as getLocationsByPlaceIdsPg,
    getPlaceById as getPlaceByIdPg,
    getPlaceMetaById as getPlaceMetaByIdPg,
    updatePlaceMeta as updatePlaceMetaPg,
};
