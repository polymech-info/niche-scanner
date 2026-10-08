import { Job } from 'pg-boss';
import { AbstractWorker } from '@/jobs/boss/AbstractWorker.js';
import { Worker } from '@/commons/decorators.js';
import { JOB_NAME, COST_PER_SEARCH, GRIDSEARCH_JOB_NAME } from './constants.js';
import { EventBus } from '../EventBus.js';
import { logger } from '@/commons/logger.js';
import { runGridsearchPipeline, type PipelineResult } from './gridsearch-uds.js';
import { updateGridSearchRun } from './db-places.js';
import { SearchParameters } from './types.js';

// ─── Places Find Worker (single location lookup) ────────────────────────────

export interface PlacesJobData extends SearchParameters {
    userId: string;
}

@Worker(JOB_NAME)
export class LocationsWorker extends AbstractWorker<PlacesJobData> {
    readonly queueName = JOB_NAME;

    calculateCost(job: Job<PlacesJobData>, result: any): number {
        return COST_PER_SEARCH + (result?.length || 0) * 0.1;
    }
    protected async process(job: Job<PlacesJobData>) {
        const { userId, ...params } = job.data;
        // return { count: results.length, placeIds: results.map((r: any) => r.place_id) };
    }
}

// ─── Gridsearch UDS Worker (C++ native pipeline) ────────────────────────────

export interface GridSearchJobData {
    userId: string;
    runId: string;
    guided?: any;
    search?: any;
    enrichers?: any[];
    excludeTypes?: string[];
    parentId?: string;
    viewportSearch?: boolean;
    viewportCenter?: { lat: number; lng: number };
    viewportZoom?: number;
}

@Worker(GRIDSEARCH_JOB_NAME)
export class GridSearchUdsWorker extends AbstractWorker<GridSearchJobData> {
    readonly queueName = GRIDSEARCH_JOB_NAME;

    udsManager: import('./gridsearch-uds.js').GridSearchUdsManager;

    constructor(udsManager: any) {
        super();
        this.emitter = EventBus;
        this.udsManager = udsManager;
    }

    calculateCost(job: Job<GridSearchJobData>, result?: PipelineResult): number {
        return (result?.freshApiCalls ?? 0) * COST_PER_SEARCH;
    }

    protected async process(job: Job<GridSearchJobData>): Promise<PipelineResult> {

        const { userId, runId, guided, search, enrichers, excludeTypes, parentId, viewportSearch, viewportCenter, viewportZoom } = job.data;

        logger.info({ jobId: job.id, runId }, '[GridSearchUdsWorker] Starting UDS pipeline', {
            userId,
            guided,
            search,
            enrichers,
            excludeTypes,
            parentId,
            viewportSearch,
            viewportCenter,
            viewportZoom,
        });

        try {
            const result = await runGridsearchPipeline(this.udsManager, {
                jobId: job.id,
                runId,
                userId,
                guided,
                search,
                enrichers,
                excludeTypes,
                parentId,
                viewportSearch,
                viewportCenter,
                viewportZoom,
                emitter: EventBus,
            });

            logger.info({
                jobId: job.id,
                runId,
                totalMs: result.totalMs,
                nodes: result.enrichResults.length,
                emails: result.totalEmails,
            }, '[GridSearchUdsWorker] Pipeline complete');

            return result;
        } catch (e: any) {
            logger.error({ jobId: job.id, error: e }, '[GridSearchUdsWorker] Pipeline failed');

            // Explicitly mark as failed in DB so UI stops "searching"
            try {
                //const { updateGridSearchRunPg } = await import('./db-places.js');
                await updateGridSearchRun(runId, {
                    status: 'failed',
                    result: { error: e.message || 'Worker UDS failure' },
                });
            } catch (dbErr) {
                logger.error({ jobId: job.id, error: dbErr }, '[GridSearchUdsWorker] DB update failed during pipeline error handling');
            }

            throw e;
        }
    }
}
