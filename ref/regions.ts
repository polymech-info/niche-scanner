import { getBoundary } from '@polymech/gadm';
import * as turf from '@turf/turf';
import { reverse } from './search/geo.js';
import { CONFIG_DEFAULT } from '@polymech/commons';
import { logger } from '@/commons/logger.js';

export async function resolveGadmName(gid: string, fallbackName: string): Promise<{ name: string, geo?: any }> {
    try {
        const config = CONFIG_DEFAULT() as any;
        const boundaryResult = await getBoundary(gid, undefined, undefined, { pop: true, built: false });

        if ('features' in boundaryResult && boundaryResult.features && boundaryResult.features.length > 0) {
            const feature = boundaryResult.features[0];
            let lon: number, lat: number;

            // Prefer GHS pop center if available, otherwise fallback to turf center
            if (feature.properties && feature.properties.ghsPopCenter) {
                lon = feature.properties.ghsPopCenter[0];
                lat = feature.properties.ghsPopCenter[1];
            } else {
                const center = turf.center(feature as any);
                lon = center.geometry.coordinates[0];
                lat = center.geometry.coordinates[1];
            }

            const bigdataKey = process.env.BIG_DATA_KEY || config.bigdata?.key;

            const loc: any = {
                gps_coordinates: { latitude: lat, longitude: lon }
            };

            await reverse(loc, { bigdata: { key: bigdataKey } });

            if (loc.geo) {
                const resolvedName = loc.geo.city || loc.geo.locality || loc.geo.principalSubdivision;
                if (resolvedName) {
                    return { name: resolvedName, geo: loc.geo };
                }
            }
        }
    } catch (e: any) {
        logger.error(e, `Failed to reverse geocode ${gid}`);
    }

    return { name: fallbackName };
}
