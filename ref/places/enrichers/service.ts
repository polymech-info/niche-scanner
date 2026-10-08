import { EnricherRegistry } from './registry.js';
import { getLocationsByPlaceIds, upsertLocations } from '../db-places.js';
import { logger } from '../logger.js';
import pMap from 'p-map';

export interface StreamInterface {
    writeSSE(data: { event: string; data: string }): Promise<void>;
}

export class EnrichmentService {

    /**
     * Orchestrates the enrichment process for a list of places and enrichers.
     * Optionally streams progress and updates if a stream is provided.
     */
    async enrichAndStream(
        placeIds: string[],
        enricherNames: string[],
        userId: string,
        stream?: StreamInterface
    ) {
        const requestedEnrichers = enricherNames.map(name => EnricherRegistry.get(name)).filter(e => e !== undefined);

        if (requestedEnrichers.length === 0) {
            throw new Error('No valid enrichers found');
        }

        if (stream) {
            await stream.writeSSE({
                event: 'progress',
                data: JSON.stringify({
                    current: 0,
                    total: placeIds.length,
                    message: `Starting enrichment for ${placeIds.length} items`
                })
            });
        }

        // Fetch current data
        const existingLocations = await getLocationsByPlaceIds(placeIds);
        const locationMap = new Map(existingLocations.map((l: any) => [l.place_id, l]));

        // ... class definition ...

        let processed = 0;
        let successCount = 0;
        let failedCount = 0;

        await pMap(placeIds, async (placeId: string) => {
            const location = locationMap.get(placeId);
            if (!location) {
                logger.warn({ placeId }, 'Location not found for enrichment');
                failedCount++;
                return;
            }

            let updates: any = {};
            for (const enricher of requestedEnrichers) {
                try {
                    // Enricher handles its own timeouts/shared resources
                    const result = await enricher!.enrich(location, { userId, logger });
                    if (Object.keys(result).length > 0) {
                        logger.info({ placeId, enricher: enricher!.name, keys: Object.keys(result) }, 'Enricher found data');
                    } else {
                        logger.info({ placeId, enricher: enricher!.name }, 'Enricher found no new data');
                    }
                    updates = { ...updates, ...result };
                } catch (e: any) {
                    logger.error({ placeId, enricher: enricher!.name, err: e }, 'Enricher failed');
                }
            }

            if (Object.keys(updates).length > 0) {
                const updatedLocation = {
                    ...location,
                    ...updates,
                    raw_data: {
                        ...(location.raw_data || {}),
                        ...(updates.raw_data || {})
                    }
                };

                try {
                    logger.info({ placeId, updates }, 'Updating location in db');
                    await upsertLocations([updatedLocation]);
                    successCount++;

                    if (stream) {
                        await stream.writeSSE({
                            event: 'enrichment-update',
                            data: JSON.stringify({
                                place_id: placeId,
                                updates: updates
                            })
                        });
                    }
                } catch (e: any) {
                    logger.error({ placeId, err: e }, 'Failed to persist enrichment updates');
                    failedCount++;
                }
            } else {
                // No updates found, but technically processed successfully without error
                successCount++;
            }

            processed++;
            if (stream) {
                await stream.writeSSE({
                    event: 'progress',
                    data: JSON.stringify({
                        current: processed,
                        total: placeIds.length,
                        message: `Enriched ${processed} of ${placeIds.length}`
                    })
                });
            }
        }, { concurrency: parseInt(process.env.ENRICHER_META_CONCURRENCY || '5') });


        if (stream) {
            await stream.writeSSE({
                event: 'complete',
                data: JSON.stringify({
                    processed,
                    success: successCount,
                    failed: failedCount
                })
            });
        }

        return { processed, success: successCount, failed: failedCount };
    }
}

export const enrichmentService = new EnrichmentService();
