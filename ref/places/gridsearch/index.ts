import {
    getNames,
    getRegionNames,
    getBoundaryFromGpkg,
} from '@polymech/gadm';
import { distance as turfDistance, point as turfPoint, convex as turfConvex } from '@turf/turf';
import fs from 'fs';
import os from 'os';
import path from 'path';

// ────────── GID → name cache (file-backed) ──────────

const AREA_NAME_CACHE_PATH = path.join(os.tmpdir(), 'gadm-area-names.json');

// ────────── Level mapping ──────────

export type GridLevel = 'states' | 'provinces' | 'districts' | 'cities' | 'towns' | 'villages' | number;

const LEVEL_MAP: Record<string, number> = {
    states: 1,
    provinces: 1,
    districts: 2,
    cities: 3,
    towns: 4,
    villages: 5,
};

export function resolveLevel(level: GridLevel): number {
    if (typeof level === 'number') return Math.max(0, Math.min(level, 5));
    return LEVEL_MAP[level] ?? 3;
}

// ────────── Types ──────────

export interface GridArea {
    name: string;
    gid: string;
    level: number;
    center: { lat: number; lon: number };
    bbox?: [number, number, number, number]; // [minLon, minLat, maxLon, maxLat]
    geometry?: any; // GeoJSON Polygon | MultiPolygon
    areaSqKm?: number;
    maxDistanceKm?: number;
    stats?: any;
}

export interface GridSearchQuery {
    region: string;
    level: GridLevel;
    /** When true, compute sq km for each area from GADM polygons */
    includeArea?: boolean;
    /** When true, compute max distance (km) across each area's bbox diagonal */
    includeDistance?: boolean;
    /** BigDataCloud API key — if provided, reverse-geocodes n.a. area names */
    bigdataKey?: string;
    /** When true, include the full GeoJSON geometry for each area (can significantly increase file size) */
    includeGeometry?: boolean;
    /** When true, enrich each area with population & elevation from GeoNames */
    includeStats?: boolean;
    /** Maximum average elevation to include this area (Default: 700) */
    maxElevation?: number;
    /** Minimum people per sq km to include this area */
    minDensity?: number;
    /** Any additional query parameters (e.g. for downstream plugins like Google Maps) to persist in the JSON map */
    [key: string]: any;
}

export interface GridEnumerateResult {
    query: GridSearchQuery;
    region: {
        name: string;
        gid: string;
        level: number;
        center?: { lat: number; lon: number };
        bbox?: [number, number, number, number];
        areaSqKm?: number;
        maxDistanceKm?: number;
        geometry?: any;
    };
    areas: GridArea[];
    maxLevelAvailable: number;
    generatedAt: string;
}

// ────────── Centroid & BBox ──────────

export function getFeatureCenterAndBBox(feature: any): {
    center: { lat: number; lon: number },
    bbox: [number, number, number, number]
} | null {
    let minLat = Infinity, maxLat = -Infinity;
    let minLon = Infinity, maxLon = -Infinity;
    let hasCoords = false;

    const walk = (coords: any) => {
        if (typeof coords[0] === 'number') {
            const [lon, lat] = coords;
            if (lat < minLat) minLat = lat;
            if (lat > maxLat) maxLat = lat;
            if (lon < minLon) minLon = lon;
            if (lon > maxLon) maxLon = lon;
            hasCoords = true;
            return;
        }
        for (const c of coords) walk(c);
    };

    if (feature?.geometry?.coordinates) {
        walk(feature.geometry.coordinates);
    }

    if (!hasCoords) return null;
    return {
        center: {
            lat: +((minLat + maxLat) / 2).toFixed(6),
            lon: +((minLon + maxLon) / 2).toFixed(6),
        },
        bbox: [minLon, minLat, maxLon, maxLat]
    };
}

// ────────── Geodesic Area ──────────

const EARTH_RADIUS_KM = 6371.0088; // mean radius
const DEG2RAD = Math.PI / 180;

/** Geodesic area of a single ring [lon,lat][] using the spherical excess formula */
function ringAreaSqKm(ring: number[][]): number {
    const n = ring.length;
    if (n < 3) return 0;
    let sum = 0;
    for (let i = 0; i < n; i++) {
        const [lon1, lat1] = ring[i];
        const [lon2, lat2] = ring[(i + 1) % n];
        sum += (lon2 - lon1) * DEG2RAD * (2 + Math.sin(lat1 * DEG2RAD) + Math.sin(lat2 * DEG2RAD));
    }
    return Math.abs(sum * EARTH_RADIUS_KM * EARTH_RADIUS_KM / 2);
}

/** Compute sq km from a GeoJSON feature (Polygon or MultiPolygon) */
export function featureAreaSqKm(feature: any): number | null {
    const geom = feature?.geometry;
    if (!geom?.coordinates) return null;

    let total = 0;
    if (geom.type === 'Polygon') {
        total += ringAreaSqKm(geom.coordinates[0]);
        for (let i = 1; i < geom.coordinates.length; i++) {
            total -= ringAreaSqKm(geom.coordinates[i]);
        }
    } else if (geom.type === 'MultiPolygon') {
        for (const poly of geom.coordinates) {
            total += ringAreaSqKm(poly[0]);
            for (let i = 1; i < poly.length; i++) {
                total -= ringAreaSqKm(poly[i]);
            }
        }
    } else {
        return null;
    }
    return +total.toFixed(2);
}

/** Compute the true geometric diameter of a polygon (km). */
export function featureMaxDistanceKm(feature: any): number | null {
    if (!feature?.geometry) return null;

    const points: [number, number][] = [];
    const walk = (coords: any) => {
        if (typeof coords[0] === 'number') {
            points.push([coords[0], coords[1]]);
            return;
        }
        for (const c of coords) walk(c);
    };
    walk(feature.geometry.coordinates ?? []);
    if (points.length < 2) return null;

    const fc = {
        type: 'FeatureCollection' as const,
        features: points.map(p => ({
            type: 'Feature' as const,
            properties: {},
            geometry: { type: 'Point' as const, coordinates: p },
        })),
    };
    const hull = turfConvex(fc);
    if (!hull?.geometry) return null;

    const ring = hull.geometry.coordinates[0];
    let maxDist = 0;

    for (let i = 0; i < ring.length - 1; i++) {
        for (let j = i + 1; j < ring.length - 1; j++) {
            const d = turfDistance(turfPoint(ring[i]), turfPoint(ring[j]), { units: 'kilometers' });
            if (d > maxDist) maxDist = d;
        }
    }

    return maxDist > 0 ? +maxDist.toFixed(2) : null;
}

// ────────── GridSearch Class ──────────

function sanitizeTarget(str: string) {
    return str.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

export class GridSearch {
    private searchesDir: string;

    constructor(cwd: string = process.cwd()) {
        this.searchesDir = path.join(cwd, 'searches');
        if (!fs.existsSync(this.searchesDir)) {
            fs.mkdirSync(this.searchesDir, { recursive: true });
        }
    }

    private getHashFilename(opts: GridSearchQuery): string {
        const parts = opts.region.split(',').map(s => s.trim()).filter(Boolean);
        const name = parts[parts.length - 1];
        const countryHint = parts.length > 1 ? parts[0] : '';

        let fileBase = 'search-';
        if (countryHint) fileBase += sanitizeTarget(countryHint) + '-';
        fileBase += sanitizeTarget(name) + '-';
        fileBase += opts.level;

        return `${fileBase}.json`;
    }

    public getSearchPath(opts: GridSearchQuery): string {
        return path.join(this.searchesDir, this.getHashFilename(opts));
    }

    public listSavedSearches(): string[] {
        if (!fs.existsSync(this.searchesDir)) return [];
        return fs.readdirSync(this.searchesDir)
            .filter(f => f.endsWith('.json'))
            .map(f => path.join(this.searchesDir, f));
    }

    public loadSearch(filePathOrHash: string): GridEnumerateResult | null {
        let filePath = filePathOrHash;
        if (!filePath.endsWith('.json')) {
            filePath = path.join(this.searchesDir, filePath + '.json');
        } else if (!path.isAbsolute(filePath)) {
            filePath = path.join(this.searchesDir, filePath);
        }

        try {
            if (fs.existsSync(filePath)) {
                return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
            }
        } catch { }
        return null;
    }

    public deleteSearch(filePathOrHash: string): boolean {
        let filePath = filePathOrHash;
        if (!filePath.endsWith('.json')) {
            filePath = path.join(this.searchesDir, filePath + '.json');
        } else if (!path.isAbsolute(filePath)) {
            filePath = path.join(this.searchesDir, filePath);
        }

        try {
            if (fs.existsSync(filePath)) {
                fs.unlinkSync(filePath);
                return true;
            }
        } catch { }
        return false;
    }

    /**
     * Walk the GADM tree and enumerate sub-areas at the target level.
     * No SerpAPI calls — completely free. Uses local GeoPackage for centroids.
     */
    public async enumerate(opts: GridSearchQuery): Promise<GridEnumerateResult> {
        const { region, level } = opts;
        const targetLevel = resolveLevel(level);

        let regionGid: string;
        let regionName: string;

        // Direct GID provided (from UI dropdown selection) — skip name search
        if ((opts as any).gid) {
            regionGid = (opts as any).gid;
            regionName = region; // use the display name as-is
        } else {
            const parts = region.split(',').map(s => s.trim()).filter(Boolean);
            const name = parts[parts.length - 1];
            const countryHint = parts.length > 1 ? parts[0].toLowerCase() : undefined;

            let namesLookup;
            try {
                namesLookup = await getNames({ name, complete: true });
            } catch (e: any) {
                throw new Error(`Region not found: "${region}". ${e.message}`);
            }

            if (!namesLookup.rows || namesLookup.rows.length === 0) {
                throw new Error(`Region not found: "${region}".`);
            }

            const matchedLevel = namesLookup.level;
            let targetRow = namesLookup.rows[0];
            if (countryHint) {
                const countryMatch = namesLookup.rows.find(r => {
                    const name0 = String(r.NAME_0 || '').toLowerCase();
                    return name0 === countryHint || name0.startsWith(countryHint);
                });
                if (countryMatch) targetRow = countryMatch;
            }

            regionGid = String(targetRow[`GID_${matchedLevel}`] || '');
            regionName = String(targetRow[`NAME_${matchedLevel}`] || name);
        }

        if (!regionGid) {
            throw new Error(`Could not resolve GID for "${region}"`);
        }

        const namesResult = await getRegionNames({
            admin: regionGid,
            contentLevel: targetLevel,
            depth: 1,
        });

        if ('error' in namesResult) {
            throw new Error(`Failed to get sub-areas: ${namesResult.error}`);
        }

        const rows = namesResult.data;
        if (rows.length === 0) {
            throw new Error(`No sub-areas found at level '${level}' (level ${targetLevel}) for "${regionName}". Try a different level (e.g. states, cities).`);
        }

        const boundaries = await getBoundaryFromGpkg(regionGid, targetLevel);
        const featureMap = new Map<string, any>();
        if (boundaries?.features) {
            for (const f of boundaries.features) {
                const gid = f.properties[`GID_${targetLevel}`];
                if (gid) featureMap.set(gid, f);
            }
        }

        const seen = new Set<string>();
        const areas: GridArea[] = [];

        for (const row of rows) {
            const gid = String(row[`GID_${targetLevel}`] || '');
            const areaName = String(row[`NAME_${targetLevel}`] || '');
            if (!gid || seen.has(gid)) continue;
            seen.add(gid);

            const feature = featureMap.get(gid);
            const bounds = feature ? getFeatureCenterAndBBox(feature) : null;

            if (bounds) {
                const area: GridArea = {
                    name: areaName,
                    gid,
                    level: targetLevel,
                    center: bounds.center,
                    bbox: bounds.bbox,
                };
                if (opts.includeGeometry && feature?.geometry) {
                    area.geometry = feature.geometry;
                }
                areas.push(area);
            }
        }
        const regionData: GridEnumerateResult['region'] = {
            name: regionName, gid: regionGid, level: regionGid.split('.').length - 1,
        };
        if (opts.includeArea || opts.includeDistance) {
            const regionBoundary = await getBoundaryFromGpkg(regionGid);
            const regionFeature = regionBoundary?.features?.[0];
            if (regionFeature) {
                const regionOptBounds = getFeatureCenterAndBBox(regionFeature);
                if (regionOptBounds) {
                    // We can also attach the region bounds if we like, but for now just optional
                    (regionData as any).center = regionOptBounds.center;
                    (regionData as any).bbox = regionOptBounds.bbox;
                }
                if (opts.includeGeometry && regionFeature.geometry) {
                    regionData.geometry = regionFeature.geometry;
                }
            }
        }

        const result: GridEnumerateResult = {
            query: opts,
            region: regionData,
            areas,
            maxLevelAvailable: targetLevel,
            generatedAt: new Date().toISOString()
        };

        fs.writeFileSync(this.getSearchPath(opts), JSON.stringify(result, null, 2), 'utf-8');

        return result;
    }
}
