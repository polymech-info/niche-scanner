import { logger } from '@/commons/logger.js';
import { getUserCached } from '@/commons/zitadel.js';
import * as turf from '@turf/turf';
import { getStatsForBBox, gidToCountryCode, GID_PREFIX_TO_CC } from './gridsearch/geonames.js';
import { searchRegions, getBoundary, getRegionNames, getHierarchyByPoint, getHierarchyByPointFromCache } from '@polymech/gadm';
import { reverse } from './search/geo.js';
import { resolveGadmName } from './regions.js';

import {
    getLocationsByPlaceIdsPg,
    getPlaceMetaByIdPg,
    updatePlaceMetaPg,
} from './db-places.js';

import {
    insertContactsBulkReturningIdsPg,
    insertContactSingleReturningIdPg,
    upsertContactGroupMembersIgnoreDuplicatesPg,
} from '../contacts/db-imap-pg.js';

import { PlacesLibrary } from './places.js';

import {
    getPlacesGridSearchesRoute,
    getPlacesTypesRoute,
    getPlacesGridSearchByIdRoute,
    getPlacesGridSearchRunStateRoute,
    postPlacesGridSearchRoute,
    postPlacesGridSearchRetryRoute,
    postPlacesGridSearchExpandRoute,
    postPlacesGridSearchControlRoute,
    postPlacesGridSearchMergeRoute,
    getPlacesGridSearchStreamRoute,
    getPlacesGridSearchExportRoute,
    deletePlacesGridSearchByIdRoute,
    getPlaceByIdRoute,
    getPlacePhotosRoute,
    patchPlacesGridSearchSettingsRoute,
    postPlacesGridSearchExportToContactsRoute,
    getLlmRegionInfoRoute,
    getPlaceInfoRoute,
    postLlmFiltersRunRoute,
    getLlmFiltersStreamRoute,
    getRegionSearchRoute,
    getRegionBoundaryRoute,
    getRegionReverseRoute,
    getRegionHierarchyRoute,
    getRegionNamesRoute,
} from './routes.js';


import {
    PLACES_JOB_OPTIONS,
    COST_PER_SEARCH,
    EMAIL_JOB_NAME,
    EMAIL_SEARCH_COST,
    GRIDSEARCH_JOB_NAME
}
    from './constants.js';

import { streamSSE } from 'hono/streaming';
import { EventBus } from '../EventBus.js';

import { PgBoss } from 'pg-boss';

import { LocationsWorker, PlacesJobData, GridSearchUdsWorker } from './pgboss.js';
import { AbstractProduct } from '../AbstractProduct.js';

import { GridSearchUdsManager } from './gridsearch-uds.js';
import {
    handleGetLlmRegionInfo,
    handleGetPlaceInfo,
    handlePostLlmFiltersRun,
    handleGetLlmFiltersStream,
} from './llm.js';

export class PlacesProduct extends AbstractProduct<PlacesJobData> {
    id = 'places';
    udsManager = new GridSearchUdsManager();
    workers = [LocationsWorker, GridSearchUdsWorker] as any[];
    jobOptions = PLACES_JOB_OPTIONS;
    private boss?: PgBoss;

    actions = {
        search: {
            costUnits: COST_PER_SEARCH,
            cancellable: true,
            description: 'Search for locations',
        },
        email: {
            costUnits: EMAIL_SEARCH_COST,
            cancellable: true,
            description: 'Find emails for locations'
        }
    };

    routes!: any[];

    constructor() {
        super();
        this.routes = [

            //gadm routes
            { definition: getRegionSearchRoute, handler: this.handleGetRegionSearch.bind(this) },
            { definition: getRegionBoundaryRoute, handler: this.handleGetRegionBoundary.bind(this) },
            { definition: getRegionReverseRoute, handler: this.handleGetRegionReverse.bind(this) },
            { definition: getRegionHierarchyRoute, handler: this.handleGetRegionHierarchy.bind(this) },
            { definition: getRegionNamesRoute, handler: this.handleGetRegionNames.bind(this) },
            //places
            //{ definition: getLocationsByTypeRoute, handler: this.handleGetLocationsByType.bind(this) },
            { definition: getPlacesTypesRoute, handler: this.handleGetPlacesTypes.bind(this) },
            { definition: getPlacesGridSearchesRoute, handler: this.handleGetPlacesGridSearches.bind(this) },
            { definition: getPlacesGridSearchExportRoute, handler: this.handleGetPlacesGridSearchExport.bind(this) },
            { definition: getPlacesGridSearchByIdRoute, handler: this.handleGetPlacesGridSearchById.bind(this) },
            { definition: getPlacesGridSearchRunStateRoute, handler: this.handleGetPlacesGridSearchRunState.bind(this) },
            { definition: patchPlacesGridSearchSettingsRoute, handler: this.handlePatchPlacesGridSearchSettings.bind(this) },
            { definition: postPlacesGridSearchRoute, handler: this.handlePostPlacesGridSearch.bind(this) },
            { definition: postPlacesGridSearchRetryRoute, handler: this.handlePostPlacesGridSearchRetry.bind(this) },
            { definition: postPlacesGridSearchExpandRoute, handler: this.handlePostPlacesGridSearchExpand.bind(this) },
            { definition: postPlacesGridSearchControlRoute, handler: this.handlePostPlacesGridSearchControl.bind(this) },
            { definition: postPlacesGridSearchMergeRoute, handler: this.handlePostPlacesGridSearchMerge.bind(this) },
            { definition: postPlacesGridSearchExportToContactsRoute, handler: this.handlePostPlacesGridSearchExportToContacts.bind(this) },
            { definition: getPlacesGridSearchStreamRoute, handler: this.handleGetPlacesGridSearchStream.bind(this) },
            { definition: deletePlacesGridSearchByIdRoute, handler: this.handleDeletePlacesGridSearchById.bind(this) },
            { definition: getPlaceByIdRoute, handler: this.handleGetPlaceById.bind(this) },
            { definition: getPlacePhotosRoute, handler: this.handleGetPlacePhotos.bind(this) },
            { definition: getLlmRegionInfoRoute, handler: handleGetLlmRegionInfo },
            { definition: getPlaceInfoRoute, handler: handleGetPlaceInfo },
            { definition: postLlmFiltersRunRoute, handler: handlePostLlmFiltersRun },
            { definition: getLlmFiltersStreamRoute, handler: handleGetLlmFiltersStream },
        ];
    }

    async onStart(boss?: PgBoss) {
        this.udsManager.startWatchdog();

        if (boss) {
            this.boss = boss;
            logger.info('[PlacesProduct] PgBoss reference stored');

            // Should we run the worker consumers in this process/thread?
            // If we are in the main thread AND workers > 0, we skip consuming here because 
            // the dedicated worker threads will consume them.
            const { isMainThread } = await import('node:worker_threads');
            const workersConfig = (this as any).__config?.workers ?? 0;
            const shouldConsume = !isMainThread || workersConfig === 0;

            const instances = [];
            for (const WorkerClass of this.workers) {
                const worker = WorkerClass === GridSearchUdsWorker ? new WorkerClass(this.udsManager) : new WorkerClass();
                instances.push(worker);

                await boss.createQueue(worker.queueName);
                const options = { ...this.jobOptions, ...(worker.queueOptions || {}) };
                if ('teamSize' in worker && worker.teamSize) {
                    options.teamSize = worker.teamSize;
                }

                if (shouldConsume) {
                    await boss.work(worker.queueName, options, worker.handler.bind(worker) as any);
                    logger.info(`[PlacesProduct] Registered worker for queue: ${worker.queueName}`);
                }
            }
            this.workers = instances;
        } else {
            logger.warn('[PlacesProduct] PgBoss not available, job-based features will not work');
        }
    }

    protected async onStop() {
        this.udsManager.stopWatchdog();
        logger.info('[PlacesProduct] UDS manager watchdog stopped');
    }

    async handleCancelJob(c: any) {
        const { jobId } = c.req.valid('param');
        try {
            if (!this.boss) {
                logger.error('[PlacesProduct] Job system not initialized');
                return c.json({ error: 'Job system not initialized' }, 503);
            }
            await (this.boss as any).cancel(EMAIL_JOB_NAME, jobId);
            return c.json({ message: 'Job cancellation requested' }, 200);
        } catch (e: any) {
            logger.error({ err: e, jobId }, '[PlacesProduct] Failed to cancel job');
            return c.json({ error: 'Failed to cancel job' }, 500);
        }
    }

    hash(data: PlacesJobData) {
        const { userId, ...params } = data;
        return this.generateHash(params);
    }

    meta(userId: string) {
        return {
            cost: COST_PER_SEARCH,
            userId,
            timestamp: new Date().toISOString()
        };
    }

    private async resolveUserId(c: any): Promise<string | undefined> {
        // Prefer context userId injected by optionalAuthMiddleware
        const ctxUserId = c.get('userId');
        if (ctxUserId) return ctxUserId;

        // Fallback
        const authHeader = c.req.header('Authorization') || c.req.header('authorization');
        let token = authHeader?.replace(/bearer\s+/i, '');
        if (!token) {
            token = c.req.query('token');
        }
        if (token) {
            const user = await getUserCached(token);
            return user?.id;
        }
        return undefined;
    }



    async handleGetPlacesTypes(c: any) {
        try {
            const userId = await this.resolveUserId(c);
            if (!userId || userId === 'undefined') {
                return c.json({ data: [] }, 200);
            }

            const sortedTypes = await PlacesLibrary.getPlacesTypes();
            return c.json({ data: sortedTypes }, 200);
        } catch (e: any) {
            logger.error({ err: e }, '[PlacesProduct] Error getting types');
            return c.json({ error: String(e) }, 500);
        }
    }

    async handleGetPlacesGridSearches(c: any) {
        try {
            const userId = await this.resolveUserId(c);
            if (!userId || userId === 'undefined') {
                return c.json({ data: [] }, 200);
            }

            const finalResults = await PlacesLibrary.getPlacesGridSearches(userId);
            return c.json({ data: finalResults }, 200);
        } catch (error: any) {
            logger.error(error, 'Error listing places grid searches from DB');
            return c.json({ error: error.message }, 500);
        }
    }

    async handleGetPlacesGridSearchById(c: any) {
        const { id } = c.req.valid('param');
        let userId = await this.resolveUserId(c);
        if (userId === 'undefined') userId = undefined;
        try {
            const result = await PlacesLibrary.getPlacesGridSearchById(id, userId);
            return c.json({ data: result }, 200);
        } catch (error: any) {
            if (error.status) return c.json({ error: error.error }, error.status);
            logger.error(error, 'Error loading places grid search from DB');
            return c.json({ error: error.message }, 500);
        }
    }

    async handleGetPlacesGridSearchRunState(c: any) {
        const { id } = c.req.valid('param');
        let userId = await this.resolveUserId(c);
        if (userId === 'undefined') userId = undefined;
        try {
            const data = await PlacesLibrary.getPlacesGridSearchRunState(id, userId);
            return c.json({ data }, 200);
        } catch (error: any) {
            if (error.status) return c.json({ error: error.error }, error.status);
            logger.error(error, 'Error restoring places grid search run state');
            return c.json({ error: error.message }, 500);
        }
    }

    async handlePatchPlacesGridSearchSettings(c: any) {
        const { id } = c.req.valid('param');
        const body = c.req.valid('json');
        const userId = await this.resolveUserId(c);

        try {
            if (!userId || userId === 'undefined') {
                return c.json({ error: 'Unauthorized' }, 401);
            }

            const result = await PlacesLibrary.patchPlacesGridSearchSettings(id, userId, body);
            return c.json(result, 200);
        } catch (error: any) {
            if (error.status) return c.json({ error: error.error }, error.status);
            logger.error(error, 'Error updating settings');
            return c.json({ error: error.message }, 500);
        }
    }

    async handlePostPlacesGridSearch(c: any) {
        try {
            const body = await c.req.json();

            if (body.test === true) {
                return c.json({ ok: true }, 200);
            }

            const userId = await this.resolveUserId(c);
            if (!userId || userId === 'undefined') {
                return c.json({ error: 'Unauthorized' }, 401);
            }

            if (!this.boss) {
                return c.json({ error: 'Job system not initialized' }, 503);
            }
            logger.info({ userId, bodySpec: { guided: !!body.guided, enrich: body.enrichers?.length } }, '[PlacesProduct] Received gridsearch job request');
            const { jobId } = await PlacesLibrary.postPlacesGridSearch(userId, body, this.boss);
            return c.json({ message: 'Job submitted', jobId }, 202);
        } catch (e: any) {
            logger.error({ err: e }, '[PlacesProduct] Failed to submit grid search job');
            return c.json({ error: e.message }, 500);
        }
    }

    async handlePostPlacesGridSearchRetry(c: any) {
        try {
            const { id: runId } = c.req.valid('param');
            const userId = await this.resolveUserId(c);
            if (!userId || userId === 'undefined') {
                return c.json({ error: 'Unauthorized' }, 401);
            }

            if (!this.boss) {
                return c.json({ error: 'Job system not initialized' }, 503);
            }

            const { jobId } = await PlacesLibrary.postPlacesGridSearchRetry(runId, userId, this.boss);
            logger.info({ runId, newJobId: jobId }, '[PlacesProduct] Gridsearch job retried');
            EventBus.emit('job:progress', { jobId: runId, type: 'retry', data: 'Job restarting' });
            return c.json({ message: 'Job retried', jobId: runId }, 202);
        } catch (e: any) {
            if (e.status) return c.json({ error: e.error }, e.status);
            logger.error({ err: e }, '[PlacesProduct] Failed to retry grid search job');
            return c.json({ error: e.message }, 500);
        }
    }

    async handlePostPlacesGridSearchControl(c: any) {
        try {
            const { id: runId } = c.req.valid('param');
            const { action } = c.req.valid('json');
            const userId = await this.resolveUserId(c);
            if (!userId || userId === 'undefined') {
                return c.json({ error: 'Unauthorized' }, 401);
            }
            await PlacesLibrary.postPlacesGridSearchControl(runId, userId, action, this.udsManager);
            return c.json({ ok: true }, 202);
        } catch (e: any) {
            if (e.status) return c.json({ error: e.error }, e.status);
            logger.error({ err: e }, '[PlacesProduct] Grid search control failed');
            return c.json({ error: e.message }, 500);
        }
    }

    async handlePostPlacesGridSearchExpand(c: any) {
        try {
            const { id: runId } = c.req.valid('param');
            const body = await c.req.json();
            const userId = await this.resolveUserId(c);
            if (!userId || userId === 'undefined') {
                return c.json({ error: 'Unauthorized' }, 401);
            }

            if (!this.boss) {
                return c.json({ error: 'Job system not initialized' }, 503);
            }

            const { childRunId, freshAreasCount, totalAreasCount } = await PlacesLibrary.postPlacesGridSearchExpand(runId, userId, body, this.boss);

            logger.info({ runId, childRunId, freshAreas: freshAreasCount, totalAreas: totalAreasCount }, '[PlacesProduct] Gridsearch expand submitted');
            EventBus.emit('job:progress', { jobId: runId, type: 'expand', data: { freshAreas: freshAreasCount, childRunId } });
            return c.json({ message: 'Expansion submitted', jobId: runId }, 202);
        } catch (e: any) {
            if (e.status) return c.json({ error: e.error }, e.status);
            logger.error({ err: e }, '[PlacesProduct] Failed to expand grid search');
            return c.json({ error: e.message }, 500);
        }
    }

    async handleGetPlacesGridSearchStream(c: any) {
        const { id: jobId } = c.req.valid('param');
        const userId = await this.resolveUserId(c);
        if (!userId || userId === 'undefined') {
            return c.json({ error: 'Unauthorized' }, 401);
        }

        return streamSSE(c, async (stream) => {
            let closed = false;
            stream.onAbort(() => { closed = true; });

            // Location event buffer for batched hydration
            const locationBuffer: { event: any; payload: any }[] = [];
            const LOCATION_BATCH_SIZE = 10;

            const flushLocationBuffer = async () => {
                if (closed || locationBuffer.length === 0) return;
                const batch = locationBuffer.splice(0);

                // Collect place_ids that exist in the batch
                const pids = batch
                    .map(b => b.payload?.location?.place_id)
                    .filter(Boolean);

                let rowMap = new Map<string, any>();
                if (pids.length > 0) {
                    const data = await getLocationsByPlaceIdsPg(pids);
                    if (data) {
                        rowMap = new Map(data.map(p => [p.place_id, p]));
                    }
                }

                for (const item of batch) {
                    const pid = item.payload?.location?.place_id;
                    let merged = item.payload;

                    if (pid && rowMap.has(pid)) {
                        const freshRow = rowMap.get(pid)!;
                        const { meta, ...topLevel } = freshRow;
                        const validTopLevel = Object.fromEntries(Object.entries(topLevel).filter(([, v]) => v != null));
                        const { pages, pageErrors, bodyHtml, ...cleanMeta } = meta || {};
                        merged = {
                            ...merged,
                            location: {
                                ...merged.location,
                                ...cleanMeta,
                                ...validTopLevel,
                                place_id: pid,
                            },
                        };
                    }

                    try {
                        await stream.writeSSE({
                            event: 'location',
                            data: JSON.stringify(merged),
                        });
                    } catch { /* client disconnected */ }
                }
            };

            const onProgress = async (event: any) => {
                if (closed || event.jobId !== jobId) return;
                try {
                    let payload = event.data || {};

                    // Buffer location events for batched hydration
                    if (event.type === 'location') {
                        locationBuffer.push({ event, payload });
                        if (locationBuffer.length >= LOCATION_BATCH_SIZE) {
                            await flushLocationBuffer();
                        }
                        return;
                    }

                    // Flush any pending locations before non-location events
                    if (locationBuffer.length > 0) {
                        await flushLocationBuffer();
                    }

                    // For node events (enriched places), resolve from the places table
                    if (event.type === 'node' && payload) {
                        const pid = payload.placeId || payload.place_id;
                        if (pid) {
                            const rows = await getLocationsByPlaceIdsPg([pid]);
                            const freshRow = rows[0] ?? null;

                            if (freshRow) {
                                const { meta, ...topLevel } = freshRow;
                                const validTopLevel = Object.fromEntries(Object.entries(topLevel).filter(([, v]) => v != null));
                                const { pages, pageErrors, bodyHtml, ...cleanMeta } = meta || {};
                                payload = {
                                    ...payload,
                                    ...cleanMeta,
                                    ...validTopLevel,
                                    place_id: pid,
                                    types: topLevel.types || cleanMeta?.types || payload.types || (payload.type ? [payload.type] : []),
                                };
                            } else {
                                // Normalize field names even without DB row
                                payload = { ...payload, place_id: pid };
                            }
                        }
                    }

                    // For job_result events, hydrate enrichResults from the places table
                    if (event.type === 'job_result' && Array.isArray(payload.enrichResults) && payload.enrichResults.length > 0) {
                        const isIds = typeof payload.enrichResults[0] === 'string';
                        const placeIds: string[] = isIds
                            ? payload.enrichResults
                            : payload.enrichResults.map((r: any) => r.placeId || r.place_id).filter(Boolean);

                        if (placeIds.length > 0) {
                            // Query in chunks of 50 to avoid URI-length limits
                            const chunkSize = 50;
                            const allRows: any[] = [];
                            for (let i = 0; i < placeIds.length; i += chunkSize) {
                                const chunk = placeIds.slice(i, i + chunkSize);
                                const data = await getLocationsByPlaceIdsPg(chunk);
                                if (data) allRows.push(...data);
                            }

                            const rowMap = new Map(allRows.map(p => [p.place_id, p]));

                            payload.enrichResults = placeIds.map((pid: string) => {
                                const freshRow = rowMap.get(pid);
                                if (freshRow) {
                                    const { meta, ...topLevel } = freshRow;
                                    const validTopLevel = Object.fromEntries(Object.entries(topLevel).filter(([, v]) => v != null));
                                    const { pages, pageErrors, bodyHtml, ...cleanMeta } = meta || {};
                                    return { ...cleanMeta, ...validTopLevel, place_id: pid };
                                }
                                return { place_id: pid };
                            });

                            // Recalculate totalEmails from hydrated data
                            payload.totalEmails = payload.enrichResults.reduce(
                                (acc: number, node: any) => acc + (node.emails?.length || 0), 0
                            );
                        }
                    }

                    await stream.writeSSE({
                        event: event.type || 'progress',
                        data: JSON.stringify(payload),
                    });
                } catch { /* client disconnected */ }
            };

            const onComplete = async (event: any) => {
                if (event.jobId !== jobId) return;
                try {
                    await stream.writeSSE({ event: 'complete', data: JSON.stringify(event.result || {}) });
                } catch { /* client disconnected */ }
                closed = true;
            };

            const onFailed = async (event: any) => {
                if (event.jobId !== jobId) return;
                try {
                    await stream.writeSSE({ event: 'failed', data: JSON.stringify({ error: event.error }) });
                } catch { /* client disconnected */ }
                closed = true;
            };

            EventBus.on('job:progress', onProgress);
            EventBus.on('job:complete', onComplete);
            EventBus.on('job:failed', onFailed);

            // Keep-alive loop
            while (!closed) {
                await stream.writeSSE({ event: 'ping', data: '' });
                await new Promise(r => setTimeout(r, 15000));
            }

            EventBus.off('job:progress', onProgress);
            EventBus.off('job:complete', onComplete);
            EventBus.off('job:failed', onFailed);
        });
    }

    async handleGetPlacesGridSearchExport(c: any) {
        const { search, format } = c.req.valid('query');
        let userId = await this.resolveUserId(c);
        if (userId === 'undefined') userId = undefined;

        try {
            const reportData = await PlacesLibrary.getPlacesGridSearchExportData(search, userId);
            const { generateMdReport, generateJsonReport } = await import('./reports.js');

            if (format === 'md') {
                const mdStr = generateMdReport(reportData);
                return c.text(mdStr, 200, {
                    'Content-Type': 'text/markdown',
                    'Content-Disposition': `attachment; filename="${reportData.pipelineName}.md"`
                });
            } else {
                const jsonObj = generateJsonReport(reportData);
                return c.json(jsonObj, 200);
            }
        } catch (error: any) {
            if (error.status) return c.json({ error: error.error }, error.status);
            logger.error({ error: error.message, stack: error.stack }, 'Error exporting grid search in places API');
            return c.json({ error: error.message }, 500);
        }
    }

    async handleDeletePlacesGridSearchById(c: any) {
        const { id } = c.req.valid('param');
        const userId = await this.resolveUserId(c);
        try {
            if (!userId || userId === 'undefined') {
                return c.json({ error: 'Unauthorized' }, 401);
            }

            await PlacesLibrary.deletePlacesGridSearchById(id, userId, this.boss);
            return c.json({ success: true }, 200);
        } catch (error: any) {
            if (error.status) return c.json({ error: error.error }, error.status);
            logger.error(error, 'Error deleting grid search from DB');
            return c.json({ error: error.message }, 500);
        }
    }

    async handleGetPlaceById(c: any) {
        const { place_id } = c.req.valid('param');
        try {
            const merged = await PlacesLibrary.getPlaceById(place_id);
            return c.json({ data: merged }, 200);
        } catch (error: any) {
            if (error.status) return c.json({ error: error.error }, error.status);
            logger.error(error, 'Error fetching place by ID');
            return c.json({ error: error.message }, 500);
        }
    }

    async handleGetPlacePhotos(c: any) {
        const { place_id } = c.req.valid('param');

        try {
            // 1. Check if we already have google_media cached in the DB
            const { data: dbRow } = await getPlaceMetaByIdPg(place_id);

            const dbMeta = dbRow?.meta as any;
            const existingMedia = dbMeta?.google_media;
            if (existingMedia?.photos?.length) {
                return c.json({ data: existingMedia }, 200);
            }

            // 2. Get SerpAPI key from .env
            const apiKey = process.env.SERPAPI_KEY;
            if (!apiKey) {
                return c.json({ error: 'SERPAPI_KEY is not configured in .env' }, 500);
            }

            // 3. Look up the data_id via google_maps engine (place_id search)
            let dataId = dbMeta?.data_id;
            if (!dataId) {
                const lookupUrl = `https://serpapi.com/search.json?engine=google_maps&place_id=${encodeURIComponent(place_id)}&api_key=${apiKey}`;
                const lookupRes = await fetch(lookupUrl);
                if (!lookupRes.ok) {
                    const errText = await lookupRes.text();
                    logger.error({ status: lookupRes.status, errText }, '[PlacesProduct] SerpAPI lookup failed');
                    return c.json({ error: 'Failed to look up place on SerpAPI' }, 502);
                }
                const lookupData = await lookupRes.json();
                dataId = lookupData.place_results?.data_id;
                if (!dataId) {
                    return c.json({ error: 'Could not resolve data_id for this place' }, 404);
                }
            }

            // 4. Fetch photos via google_maps_photos engine
            const photosUrl = `https://serpapi.com/search.json?engine=google_maps_photos&data_id=${encodeURIComponent(dataId)}&api_key=${apiKey}`;
            logger.info({ place_id, dataId }, '[PlacesProduct] Fetching photos via SerpAPI');
            const photosRes = await fetch(photosUrl);
            if (!photosRes.ok) {
                const errText = await photosRes.text();
                logger.error({ status: photosRes.status, errText }, '[PlacesProduct] SerpAPI photos fetch failed');
                return c.json({ error: 'Failed to fetch photos from SerpAPI' }, 502);
            }
            const photosData = await photosRes.json();

            // 5. Cache google_media back into the DB meta for future requests
            if (photosData?.photos?.length && dbMeta) {
                const updatedMeta = { ...dbMeta, google_media: photosData, data_id: dataId };
                await updatePlaceMetaPg(place_id, updatedMeta);
            }

            return c.json({ data: photosData }, 200);
        } catch (error: any) {
            logger.error(error, 'Error fetching place photos');
            return c.json({ error: error.message }, 500);
        }
    }

    async handlePostPlacesGridSearchExportToContacts(c: any) {
        const { id } = c.req.valid('param');
        const body = c.req.valid('json') as { groupId?: string; placeIds?: string[]; excludedTypes?: string[] };
        const { groupId, placeIds, excludedTypes } = body;
        const userId = await this.resolveUserId(c);

        try {
            if (!userId || userId === 'undefined') {
                return c.json({ error: 'Unauthorized' }, 401);
            }

            const reportData = await PlacesLibrary.getPlacesGridSearchExportData(id, userId);
            let results = reportData.enrichResults?.length ? reportData.enrichResults : (reportData.searchResult?.results || []);

            if (Array.isArray(placeIds)) {
                if (placeIds.length === 0) {
                    results = [];
                } else {
                    const want = new Set(placeIds.map((x) => String(x)));
                    results = results.filter((r: any) => {
                        const pid = r?.place_id ?? r?.placeId ?? r?.id;
                        return pid != null && want.has(String(pid));
                    });
                }
            } else if (Array.isArray(excludedTypes) && excludedTypes.length > 0) {
                const excludedSet = new Set(excludedTypes.map((t) => String(t).toLowerCase()));
                results = results.filter((r: any) => {
                    const types = r?.types || [];
                    return !types.some((t: string) => excludedSet.has(String(t).toLowerCase()));
                });
            }

            if (!results.length) {
                return c.json({ imported: 0, skipped: 0 }, 200);
            }

            const { parseJsonContact } = await import('../contacts/utils.js');
            const contacts = results.map(parseJsonContact).filter(Boolean);

            if (!contacts.length) {
                return c.json({ imported: 0, skipped: results.length }, 200);
            }

            const rows = contacts.map((ct: any) => ({ ...ct, owner_id: userId }));
            let insertedContacts: any[] = [];

            const CHUNK_SIZE = 200;
            for (let i = 0; i < rows.length; i += CHUNK_SIZE) {
                const chunk = rows.slice(i, i + CHUNK_SIZE);
                try {
                    const ids = await insertContactsBulkReturningIdsPg(chunk);
                    insertedContacts.push(...ids);
                } catch (err: any) {
                    logger.warn({ err: err.message }, '[PlacesProduct] Bulk contact insert failed, falling back to singular');
                    for (const row of chunk) {
                        const id = await insertContactSingleReturningIdPg(row);
                        if (id) insertedContacts.push({ id });
                        else logger.error({}, '[PlacesProduct] Individual contact insert failed');
                    }
                }
            }

            const numImported = insertedContacts.length;

            if (numImported > 0 && groupId) {
                const groupMembers = insertedContacts.map(ic => ({ group_id: groupId, contact_id: ic.id }));
                try { await upsertContactGroupMembersIgnoreDuplicatesPg(groupMembers); }
                catch (gErr: any) { logger.error({ err: gErr.message }, '[PlacesProduct] Failed to add imported contacts to group'); }
            }

            if (numImported > 0) {
                try {
                    const { flushContactsCache } = await import('../contacts/index.js');
                    await flushContactsCache(userId);
                } catch (e) {
                    logger.warn({ err: (e as any).message }, '[PlacesProduct] Failed to flush contacts cache');
                }
            }

            return c.json({ imported: numImported, skipped: results.length - numImported }, 200);

        } catch (error: any) {
            if (error.status) return c.json({ error: error.error }, error.status);
            logger.error({ error: error.message, stack: error.stack }, '[PlacesProduct] Error exporting to contacts');
            return c.json({ error: error.message }, 500);
        }
    }

    async handlePostPlacesGridSearchMerge(c: any) {
        const { id: targetId } = c.req.valid('param');
        const { sourceId } = c.req.valid('json');
        const userId = await this.resolveUserId(c);

        try {
            if (!userId || userId === 'undefined') {
                return c.json({ error: 'Unauthorized' }, 401);
            }

            const mergedCount = await PlacesLibrary.mergeGridSearches(targetId, sourceId, userId);
            return c.json({ success: true, mergedCount }, 200);
        } catch (error: any) {
            if (error.status) return c.json({ error: error.error }, error.status);
            logger.error(error, '[PlacesProduct] Error merging grid searches');
            return c.json({ error: error.message }, 500);
        }
    }

    async handleGetRegionSearch(c: any) {
        const { query, content_level, geojson, country } = c.req.valid('query');
        try {
            const result = await searchRegions({
                query,
                contentLevel: content_level ? parseInt(content_level) : undefined,
                geojson: geojson === 'true',
                country: country || undefined,
            });

            if (result.error) {
                return c.json({ error: result.error }, 400);
            }
            return c.json(result, 200);

        } catch (error: any) {
            logger.error(error, 'Error searching regions');
            return c.json({ error: error.message || 'Internal Server Error' }, 500);
        }
    }

    async handleGetRegionBoundary(c: any) {
        const { id } = c.req.valid('param');
        const { targetLevel, enrich, cache, pop, built, minGhsPop, minGhsBuilt } = c.req.valid('query');

        try {
            const doEnrich = enrich === 'true';
            const noCache = cache !== 'false';

            let parsedTargetLevel: number | undefined = undefined;
            if (targetLevel !== undefined) {
                parsedTargetLevel = parseInt(targetLevel);
            }

            const noopCache = {
                get: (key: string): Promise<any> => Promise.resolve(undefined),
                set: (key: string, value: any): Promise<void> => Promise.resolve(),
            }

            const popOption = pop === 'false' ? false : (pop === 'true' || pop === undefined ? true : pop);
            const builtOption = built === 'false' ? false : (built === 'true' || built === undefined ? true : built);

            // We no longer pass includeOuter=true to avoid expensive Turf.js dissolves
            // If parsedTargetLevel = gidLevel, it will just fetch the boundary directly.
            // If parsedTargetLevel > gidLevel, it fetches subdivisions directly.
            const forceNoCache = true;
            //console.log(`Requesting Boundary for ${id} at level ${parsedTargetLevel}`)
            const result = await getBoundary(id, parsedTargetLevel, forceNoCache ? noopCache : undefined,
                {
                    pop: popOption,
                    built: builtOption
                });

            if ('error' in result) {
                return c.json({ error: result.error }, 404);
            }

            // Apply GHS min filters if features are present
            if (result.features) {
                if (minGhsPop !== undefined) {
                    result.features = result.features.filter((f: any) => (f.properties.ghsPopulation || 0) >= minGhsPop);
                }
                if (minGhsBuilt !== undefined) {
                    result.features = result.features.filter((f: any) => (f.properties.ghsBuiltWeight || 0) >= minGhsBuilt);
                }
            }

            if (doEnrich && result.features) {
                for (const feature of result.features) {
                    const areaSqMeters = turf.area(feature as any);
                    const areaSqkm = Math.round(areaSqMeters / 1000000);

                    const bbox = turf.bbox(feature as any) as [number, number, number, number];
                    const gid = feature.properties.GID_0 || id.split('.')[0];
                    const countryCode = gidToCountryCode(gid);

                    feature.properties.areaSqkm = areaSqkm;

                    if (countryCode) {
                        const stats = getStatsForBBox(countryCode, bbox);
                        feature.properties.population = stats.totalPopulation;
                        feature.properties.placeCount = stats.placeCount;
                        feature.properties.avgElevation = stats.avgElevation;
                    }

                }
            }

            return c.json(result, 200);

        } catch (error: any) {
            logger.error(error, 'Error fetching boundary');
            return c.json({ error: error.message || 'Internal Server Error' }, 500);
        }
    }

    async handleGetRegionNames(c: any) {
        const { admin, content_level, depth, resolveNames } = c.req.valid('query');
        try {
            const result = await getRegionNames({
                admin,
                contentLevel: content_level ? parseInt(content_level) : undefined,
                depth: depth || 1,
            });

            if ('error' in result) {
                return c.json({ error: result.error }, 400);
            }

            if (resolveNames === 'true' && result.data && Array.isArray(result.data)) {
                const itemsToResolve = result.data.filter((item: any) => {
                    const nameKey = Object.keys(item).find(k => k.startsWith('NAME_'));
                    if (!nameKey) return false;
                    const val = item[nameKey];
                    return typeof val === 'string' && (val.toLowerCase().startsWith('n.a.') || val.toLowerCase() === 'unknown');
                });

                const resolveBatch = async (batch: any[]) => {
                    await Promise.all(batch.map(async (item) => {
                        const gidKey = Object.keys(item).find(k => k.startsWith('GID_'));
                        if (!gidKey) return;
                        const gid = item[gidKey];
                        const nameKey = Object.keys(item).find(k => k.startsWith('NAME_'));
                        const fallbackName = nameKey ? item[nameKey] : 'Unknown';

                        const resolved = await resolveGadmName(gid, fallbackName);
                        item.LABEL = resolved.name;
                        if (resolved.geo) {
                            item.GEO = resolved.geo;
                        }
                    }));
                };

                const chunkSize = 5;
                for (let i = 0; i < itemsToResolve.length; i += chunkSize) {
                    await resolveBatch(itemsToResolve.slice(i, i + chunkSize));
                }
            }

            return c.json(result, 200);

        } catch (error: any) {
            logger.error(error, 'Error fetching region names');
            return c.json({ error: error.message || 'Internal Server Error' }, 500);
        }
    }

    async handleGetRegionReverse(c: any) {
        const { lat, lon } = c.req.valid('query');
        try {
            // Mock LocalResult structure expected by reverse()
            const loc: any = {
                gps_coordinates: {
                    latitude: parseFloat(lat),
                    longitude: parseFloat(lon)
                }
            };

            // Use 'reverse' from search package
            // It expects opts.bigdata.key. We try to read it from env.
            logger.info({ lat, lon }, `Reverse geocoding request for BIG_DATA_KEY: ${process.env.BIG_DATA_KEY}`);
            await reverse(loc, { bigdata: { key: process.env.BIG_DATA_KEY } });
            if (loc.geo) {
                return c.json({ data: loc.geo }, 200);
            } else {
                return c.json({ error: 'Reverse geocoding failed' }, 404);
            }
        } catch (error: any) {
            logger.error({ error: error.message }, 'Error reverse geocoding');
            return c.json({ error: `Reverse geocoding failed: ${error.status} | ${error.message}` }, 403);
        }
    }

    async handleGetRegionHierarchy(c: any) {
        const { lat, lon } = c.req.valid('query');
        try {
            const latitude = parseFloat(lat);
            const longitude = parseFloat(lon);
            let results: any = null;
            // 1. Try Cache-based approach first (avoids SQLite)
            try {
                // Reverse geocode to find country intuitively via BigDataCloud
                const loc: any = { gps_coordinates: { latitude, longitude } };
                await reverse(loc, { bigdata: { key: process.env.BIG_DATA_KEY } });
                const countryCode = loc.geo?.countryCode;
                if (countryCode) {
                    let iso3 = countryCode.toUpperCase();
                    if (iso3.length === 2) {
                        for (const [key, val] of Object.entries(GID_PREFIX_TO_CC)) {
                            if (val === iso3) {
                                iso3 = key;
                                break;
                            }
                        }
                    }
                    if (iso3) {
                        const cacheDirs = [];
                        if (process.env.GRIDSEARCH_CACHE) {
                            cacheDirs.push(process.env.GRIDSEARCH_CACHE);
                        }
                        results = await getHierarchyByPointFromCache(latitude, longitude, iso3, cacheDirs);

                        if (results && results.length > 0) {
//                            logger.info({ levelsCount: results.length, firstGid: results[0]?.gid }, `[HierarchyAPI] Retrieved hierarchy from JSON cache!`);
                        } else {
                            results = null;
                        }
                    }
                }
            } catch (cacheErr) {
                logger.warn(cacheErr, '[HierarchyAPI] Cache-based hierarchy resolution threw exception');
                results = null;
            }

            // 2. Fallback to SQLite using the native bindings
            if (!results) {
                logger.info(`[HierarchyAPI] Falling back to SQLite getHierarchyByPoint`);
                results = getHierarchyByPoint(latitude, longitude);
            }

            if (results && results.length > 0) {
                return c.json({ data: results }, 200);
            } else {
                logger.warn(`[HierarchyAPI] Completely failed to find hierarchy (both cache and DB empty)`);
                return c.json({ data: [] }, 200);
            }
        } catch (error: any) {
            logger.error(error, 'Error getting region hierarchy');
            return c.json({ error: error.message || 'Internal Server Error' }, 500);
        }
    }
}
