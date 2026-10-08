import { describe, it, expect, beforeAll } from 'vitest';
import {
    ensureServersRunning,
    loginTestUser,
    testServerBaseUrl,
    getTestAuthHeaders,
    type TestAuth,
} from '../../../__tests__/test-commons.js';
import { createLogger } from '../../../commons/logger.js';

const testLogger = createLogger('gridsearch-uds-e2e');

const BARCELONA_PRESET = {
    guided: {
        areas: [
            {
                gid: 'ESP.6.2.6_1',
                name: 'n.a. (106)',
                level: 3,
                raw: {
                    level: 3,
                    gadmName: 'n.a. (106)',
                    gid: 'ESP.6.2.6_1',
                },
            },
        ],
        settings: {
            gridMode: 'centers',
            pathOrder: 'snake',
            groupByRegion: true,
            cellSize: 10,
            cellOverlap: 0,
            centroidOverlap: 0,
            ghsFilterMode: 'OR',
            maxCellsLimit: 50000,
            maxElevation: 1000,
            minDensity: 10,
            minGhsPop: 26,
            minGhsBuilt: 154,
            allowMissingGhs: false,
            bypassFilters: true,
        },
    },
    search: {
        types: ['carpentry'],
        filterCountry: 'Spain',
        googleDomain: 'google.es',
        limitPerArea: 2,
        useCache: true,
    },
    enrichers: [],
};

describe('GridSearch UDS Pipeline — E2E', () => {
    let auth: TestAuth | null = null;

    beforeAll(async () => {
        await ensureServersRunning();
        auth = await loginTestUser();
        if (!auth) {
            testLogger.warn('loginTestUser returned null — set ZITADEL_SERVER_ACCESS_TOKEN or SERVICE_USER_ZITADEL_*');
        }
    });

    it('should submit job, stream IPC events via SSE, and complete', async () => {
        if (!auth) {
            testLogger.warn('Skipping — no auth token');
            return;
        }

        const crypto = await import('crypto');
        const jobId = crypto.randomUUID();
        const base = testServerBaseUrl;

        const resStream = await fetch(`${base}/api/places/gridsearch/${jobId}/stream`, {
            headers: getTestAuthHeaders(auth.token),
        });

        expect(resStream.status).toBe(200);
        expect(resStream.headers.get('Content-Type')).toContain('text/event-stream');
        if (!resStream.body) throw new Error('No streaming body');

        const reader = resStream.body.getReader();
        const decoder = new TextDecoder();

        let complete = false;
        let failed = false;
        const eventTypes = new Set<string>();
        let eventCount = 0;

        const streamPromise = (async () => {
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                const text = decoder.decode(value);
                for (const line of text.split('\n')) {
                    if (line.startsWith('event: ')) {
                        const type = line.slice(7).trim();
                        eventTypes.add(type);
                        eventCount++;
                        testLogger.info({ n: eventCount, type }, 'SSE event');
                    }
                }
                if (text.includes('event: complete')) {
                    complete = true;
                    break;
                }
                if (text.includes('event: failed')) {
                    failed = true;
                    break;
                }
            }
        })();

        const resJob = await fetch(`${base}/api/places/gridsearch`, {
            method: 'POST',
            headers: getTestAuthHeaders(auth.token, { json: true }),
            body: JSON.stringify({
                ...BARCELONA_PRESET,
                jobId,
            }),
        });

        expect(resJob.status).toBe(202);
        const jobData: { jobId?: string } = await resJob.json();
        expect(jobData.jobId).toBeDefined();
        testLogger.info({ jobId: jobData.jobId }, 'Job submitted');

        await streamPromise;

        testLogger.info({ eventCount, types: [...eventTypes], complete, failed }, 'Stream summary');

        expect(complete || failed).toBe(true);
        if (complete) {
            expect(eventCount).toBeGreaterThan(0);
            expect(eventTypes.has('grid-ready')).toBe(true);
        }

        try {
            const { boss, startBoss } = await import('@/jobs/boss/client.js');
            if (boss) {
                await startBoss();
                const queues = await boss.getQueues();
                if (queues.some((q: any) => q.name === 'places-gridsearch-pipeline')) {
                    await boss.deleteJob('places-gridsearch-pipeline', jobId);
                }
            }
        } catch (err: unknown) {
            testLogger.warn({ err }, 'Best-effort job cleanup skipped');
        }

        testLogger.info('UDS pipeline E2E complete');
    }, 600_000);
});
