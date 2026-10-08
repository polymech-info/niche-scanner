/**
 * Grid Search — Phase 1 + 2 State Persistence
 *
 * Persists raw per-area SerpAPI results AND enumeration results so repeated
 * test runs (or pgboss retries) can skip both GADM enumeration and SerpAPI
 * and replay entirely from a local dump.
 *
 * Architecture:
 *   - `GridSearchStateStore`       — thin interface
 *   - `NoopGridSearchStateStore`   — always misses (default)
 *   - `FileGridSearchStateStore`   — single JSON file per pipeline
 *
 * Phase 1 cache key: sanitize(region) + '__' + sanitize(level) + '__' + flags
 * Phase 2 cache key: roundedCoord(4dp) + zoom + sorted(types) + domain + language + limit
 */

import fs from 'fs';
import path from 'path';

// ── Per-area snapshot ─────────────────────────────────────────────────────────

/** Snapshot of a single GADM area's Phase 2 results. */
export interface GridAreaState {
    gid: string;
    areaName: string;
    /** Raw pre-filter SerpAPI results (no _gridArea/_gridGid tags yet). */
    results: any[];
    apiCalls: number;
    viewportSqKm?: number;
    cachedAt: string;
}

// ── Area search params (cache key components) ────────────────────────────────

/** All parameters that uniquely identify a SerpAPI area search. */
export interface AreaSearchParams {
    center: { lat: number; lon: number };
    zoom: number;
    types: string[];
    googleDomain: string;
    language: string;
    limit: number;
}

// ── Store interface ───────────────────────────────────────────────────────────

/**
 * Snapshot of a Phase 1 enumeration result.
 * Stores the full GridEnumerateResult so gridEnumerate() can be skipped.
 */
export interface GridEnumState {
    region: string;
    level: string | number;
    /** Serialised GridEnumerateResult — stored as opaque JSON. */
    result: any;
    cachedAt: string;
}

/**
 * Thin store contract for Phase 1 + Phase 2 state.
 */
export interface GridSearchStateStore {
    // ── Phase 1: Enumeration ──────────────────────────────────────────────────
    /** Return a cached enumeration result or `undefined` on miss. */
    getEnum(region: string, level: string | number, flags: string): Promise<GridEnumState | undefined> | GridEnumState | undefined;
    /** Persist the enumeration result for a (region, level, flags) triple. */
    saveEnum(region: string, level: string | number, flags: string, state: GridEnumState): Promise<void> | void;
    // ── Phase 2: SerpAPI areas ────────────────────────────────────────────────
    /** Return a cached area snapshot or `undefined` on miss. */
    getArea(params: AreaSearchParams): Promise<GridAreaState | undefined> | GridAreaState | undefined;
    /** Persist the result of a single area after SerpAPI completes. */
    saveArea(params: AreaSearchParams, state: GridAreaState): Promise<void> | void;
    /** Delete a cached area entry. Returns true if an entry was deleted. */
    invalidateArea(params: AreaSearchParams): Promise<boolean> | boolean;
    /** Human-readable label for log messages. */
    readonly label: string;
}

// ── Noop ──────────────────────────────────────────────────────────────────────

/** Always misses — disables state caching, always hits SerpAPI and GADM. */
export class NoopGridSearchStateStore implements GridSearchStateStore {
    readonly label = 'noop';
    getEnum(): undefined { return undefined; }
    saveEnum(): void { }
    getArea(): undefined { return undefined; }
    saveArea(): void { }
    invalidateArea(): boolean { return false; }
}

// ── Internal helpers ──────────────────────────────────────────────────────────

function sanitize(str: string): string {
    return str.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

/** Round to nearest grid step (~500 m at equator). */
const COORD_GRID = 0.005;
function snapCoord(v: number): string {
    return (Math.round(v / COORD_GRID) * COORD_GRID).toFixed(4);
}

/** Deterministic cache key from all search-affecting parameters. */
export function areaKey(p: AreaSearchParams): string {
    const lat = snapCoord(p.center.lat);
    const lon = snapCoord(p.center.lon);
    return [
        `${lat},${lon},z${p.zoom}`,
        p.types.map(sanitize).sort().join('+'),
        sanitize(p.googleDomain),
        sanitize(p.language),
        String(p.limit),
    ].join('__');
}

// ── File-backed ───────────────────────────────────────────────────────────────

interface StateFile {
    savedAt: string;
    enumResults: Record<string, GridEnumState>;
    areas: Record<string, GridAreaState>;
}

/**
 * File-backed Phase 2 state store.
 *
 * One JSON file per pipeline run:
 *   searches/grid-state-<pipeline-name>.json
 *
 * Area entries are keyed by (center, zoom, types, domain, language, limit)
 * and accumulated incrementally — a run aborted mid-way still benefits from the areas
 * already cached when it restarts.
 */
export class FileGridSearchStateStore implements GridSearchStateStore {
    readonly label: string;
    private readonly filePath: string;
    private state: StateFile;

    constructor(filePath: string) {
        this.filePath = filePath;
        this.label = filePath;
        this.state = this.load();
    }

    private load(): StateFile {
        try {
            if (fs.existsSync(this.filePath)) {
                const raw = JSON.parse(fs.readFileSync(this.filePath, 'utf-8'));
                if (raw?.areas && typeof raw.areas === 'object') {
                    return { enumResults: {}, ...raw };
                }
            }
        } catch { /* ignore corrupt file — start fresh */ }
        return { savedAt: new Date().toISOString(), enumResults: {}, areas: {} };
    }

    private flush(): void {
        try {
            fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
            this.state.savedAt = new Date().toISOString();
            fs.writeFileSync(this.filePath, JSON.stringify(this.state, null, 2), 'utf-8');
        } catch { /* ignore write errors */ }
    }

    getEnum(region: string, level: string | number, flags: string): GridEnumState | undefined {
        const key = [sanitize(String(region)), sanitize(String(level)), flags].join('__');
        return this.state.enumResults[key];
    }

    saveEnum(region: string, level: string | number, flags: string, state: GridEnumState): void {
        const key = [sanitize(String(region)), sanitize(String(level)), flags].join('__');
        this.state.enumResults[key] = state;
        this.flush();
    }

    getArea(params: AreaSearchParams): GridAreaState | undefined {
        return this.state.areas[areaKey(params)];
    }

    saveArea(params: AreaSearchParams, state: GridAreaState): void {
        this.state.areas[areaKey(params)] = state;
        this.flush();
    }

    invalidateArea(params: AreaSearchParams): boolean {
        const key = areaKey(params);
        if (this.state.areas[key]) {
            delete this.state.areas[key];
            this.flush();
            return true;
        }
        return false;
    }

    /** Number of area entries currently in the store. */
    size(): number {
        return Object.keys(this.state.areas).length;
    }
}
