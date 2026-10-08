import { spawn, ChildProcess } from 'node:child_process';
import { resolve, join } from 'node:path';
import { existsSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import net from 'node:net';
import { EventEmitter } from 'node:events';
import { createLogger } from '@/commons/logger.js';


import {
    GRIDSEARCH_UDS_PORT,
    GRIDSEARCH_UDS_PREFIX,
    GRIDSEARCH_UDS_TIMEOUT_MS,
    GRIDSEARCH_UDS_WATCHDOG_MS,
    GRIDSEARCH_UDS_ACK_TIMEOUT_MS,
    GRIDSEARCH_UDS_CONNECT_RETRIES,
    GRIDSEARCH_UDS_CONNECT_INTERVAL_MS
} from './constants.js';
import { getServiceDatabaseUrl } from '@/commons/postgres.js';
import { updateGridSearchRun } from './db-places.js';

const IS_WIN = process.platform === 'win32' || (process.platform as string) === 'msys' || (process.platform as string) === 'cygwin';
const PROCESS_RUN_ID = Math.random().toString(36).substring(2, 8);

function getUdsAddress(port: number): string | number {
    const sockDir = process.env.GRIDSEARCH_UDS_SOCK_DIR || tmpdir();
    return IS_WIN ? port : join(sockDir, `${GRIDSEARCH_UDS_PREFIX}-${port}-${PROCESS_RUN_ID}.sock`);
}

const logger = createLogger('gridsearch-uds');

/** Redact password; keep host + database name so logs show which Postgres UDS targets. */
function maskPostgresUrlForLog(url: string | undefined): string {
    if (!url?.trim()) {
        return '(unset — C++ uses server/cpp/config/postgres.toml, not DATABASE_URL)';
    }
    try {
        const u = new URL(url.replace(/^postgres(ql)?:/i, 'http:'));
        const db = (u.pathname || '').replace(/^\//, '') || '?';
        return `${u.hostname}:${u.port || '5432'}/${db}`;
    } catch {
        return '(invalid DATABASE_URL)';
    }
}

/** Buffer child-process stream into lines and log (C++ may emit partial chunks). */
function attachCppStreamLog(
    stream: NodeJS.ReadableStream | null,
    channel: 'stdout' | 'stderr',
    meta: Record<string, unknown>
): void {
    if (!stream) return;
    let buf = '';
    const emitLine = (line: string) => {
        const t = line.trim();
        if (!t) return;
        const payload = { ...meta, cppChannel: channel, line: t };
        if (channel === 'stderr') {
             logger.warn(payload, '[gridsearch-uds] cpp stderr');
        } else {
             logger.info(payload, '[gridsearch-uds] cpp stdout');
        }
    };
    stream.on('data', (chunk: Buffer) => {
        buf += chunk.toString('utf8');
        const parts = buf.split(/\r?\n/);
        buf = parts.pop() ?? '';
        for (const line of parts) emitLine(line);
    });
    stream.on('end', () => emitLine(buf));
}

/** Cache directory for GADM boundary files, passed to C++ worker */
const GRIDSEARCH_CACHE = resolve(
    process.cwd(),
    process.env.GRIDSEARCH_CACHE || '../packages/gadm/cache/gadm'
);

// ─── Per-user Worker Pool ────────────────────────────────────────────────────

/** Monotonic counter for port allocation: base 4000 + counter */
let portCounter = 0;

function nextPort(): number {
    return GRIDSEARCH_UDS_PORT + (portCounter++);
}

interface PooledWorker {
    proc: ChildProcess;
    socket: net.Socket;
    port: number;
    lastActive: number;
}

// ─── Worker Manager Class ──────────────────────────────────────────────────────
// Encapsulates the pool of active workers and the watchdog lifecycle.

export class GridSearchUdsManager {
    public readonly workerPool = new Map<string, PooledWorker>();
    private watchdogTimer: NodeJS.Timeout | null = null;

    /**
     * Starts the periodic UDS watchdog.
     * We unref() it so the background timer doesn't prevent Node process shutdown.
     */
    startWatchdog() {
        if (this.watchdogTimer) {
            clearInterval(this.watchdogTimer);
        }

        this.watchdogTimer = setInterval(() => {
            const now = Date.now();
            for (const [userId, worker] of this.workerPool.entries()) {
                try {
                    // Check if worker was heard from recently
                    if (now - worker.lastActive > GRIDSEARCH_UDS_TIMEOUT_MS) {
                        logger.error({ userId, port: worker.port }, `[gridsearch-uds] Worker unresponsive for ${GRIDSEARCH_UDS_TIMEOUT_MS}ms. Killing process.`);
                        worker.socket.destroy();
                        if (!worker.proc.killed) worker.proc.kill('SIGKILL');
                        this.workerPool.delete(userId);
                        continue;
                    }

                    // Ping worker
                    logger.debug({ userId, port: worker.port }, '[gridsearch-uds] Watchdog pinging worker');
                    writeFrame(worker.socket, { action: 'ping' });
                } catch (e) {
                    logger.error({ userId, err: e }, '[gridsearch-uds] Watchdog ping failed');
                }
            }
        }, GRIDSEARCH_UDS_WATCHDOG_MS);

        this.watchdogTimer.unref(); // Don't block process exit
    }

    /** Stops the watchdog interval, e.g., during graceful shutdown. */
    stopWatchdog() {
        if (this.watchdogTimer) {
            clearInterval(this.watchdogTimer);
            this.watchdogTimer = null;
        }
    }

    /**
     * Get or create a worker for a user.
     * If a worker already exists and is alive, reuse its socket.
     * Otherwise spawn a new one on the next available port.
     */
    async getOrCreateWorker(userId: string): Promise<{ socket: net.Socket; port: number; proc: ChildProcess }> {
        const existing = this.workerPool.get(userId);
        if (existing && !existing.proc.killed && !existing.socket.destroyed) {
            logger.info({ userId, port: existing.port }, '[gridsearch-uds] Reusing existing worker');
            return existing;
        }

        // Clean stale entry
        if (existing) {
            this.workerPool.delete(userId);
        }

        const port = nextPort();
        const worker = spawnGridsearchWorker(port, userId);
        const socket = await connectToWorker(port);

        const pooled: PooledWorker = { proc: worker.proc, socket, port, lastActive: Date.now() };
        this.workerPool.set(userId, pooled);

        // Explicit IPC health checking
        const healthReader = createFrameReader((msg) => {
            const p = this.workerPool.get(userId);
            if (!p) return;

            if (msg.type === 'pong') {
                p.lastActive = Date.now();
                logger.debug({ userId, port: p.port, ...msg.data }, '[gridsearch-uds] Worker pong received');
            } else if (msg.type === 'log' || msg.type === 'job_progress' || msg.type === 'ack') {
                p.lastActive = Date.now();
                logger.debug({ userId, port: p.port, msgType: msg.type }, '[gridsearch-uds] Worker active event (non-pong)');
            }
        });
        socket.on('data', healthReader);

        // Cleanup on close
        socket.on('close', () => {
            this.workerPool.delete(userId);
            logger.info({ userId, port }, '[gridsearch-uds] Worker removed from pool (socket closed)');
        });
        socket.on('error', (err) => {
            logger.error({ userId, port, err }, '[gridsearch-uds] Worker socket error (pool)');
        });
        worker.proc.on('exit', () => {
            this.workerPool.delete(userId);
        });

        return pooled;
    }

    /** For diagnostics — number of active workers in the pool */
    poolSize(): number {
        return this.workerPool.size;
    }
}

// ─── Resolve the C++ binary path ─────────────────────────────────────────────

/**
 * Resolves the polymech-cli executable path from GRIDSEARCH_PATH env var.
 * GRIDSEARCH_PATH is relative to the server root (e.g. "cpp/dist").
 */
export function resolveExePath(): string {
    const basePath = process.env.GRIDSEARCH_PATH || 'cpp/dist';
    const isAbsolute = /^[a-zA-Z]:[\\/]/.test(basePath) || basePath.startsWith('/');
    const dir = isAbsolute ? basePath : resolve(process.cwd(), basePath);
    const exeName = process.platform === 'win32' ? 'polymech-cli.exe' : 'polymech-cli';
    if (!existsSync(resolve(dir, exeName))) {
        throw new Error(`[gridsearch-uds] Binary not found at ${resolve(dir, exeName)}`);
    }
    return resolve(dir, exeName);
}

/**
 * Resolves the postgres.toml config path (sibling to dist directory).
 */
export function resolveConfigPath(): string {
    const basePath = process.env.GRIDSEARCH_PATH || 'cpp/dist';
    const isAbsolute = /^[a-zA-Z]:[\\/]/.test(basePath) || basePath.startsWith('/');
    const dir = isAbsolute ? basePath : resolve(process.cwd(), basePath);
    return resolve(dir, '..', 'config', 'postgres.toml');
}

// ─── IPC Binary Framing ──────────────────────────────────────────────────────

/**
 * Write a length-prefixed JSON frame to a socket/stream.
 * Format: [4-byte LE uint32 length][JSON utf8 body]
 */
export function writeFrame(stream: net.Socket, msg: any): void {
    const body = JSON.stringify(msg);
    const bodyBuf = Buffer.from(body, 'utf8');
    const lenBuf = Buffer.alloc(4);
    lenBuf.writeUInt32LE(bodyBuf.length, 0);
    stream.write(Buffer.concat([lenBuf, bodyBuf]));
}

/**
 * Creates a streaming binary frame parser.
 * Calls `onMessage(parsed)` for each complete length-prefixed JSON frame.
 */
export function createFrameReader(onMessage: (msg: any) => void): (chunk: Buffer) => void {
    let buffer = Buffer.alloc(0);

    return (chunk: Buffer) => {
        buffer = Buffer.concat([buffer, chunk]);

        while (buffer.length >= 4) {
            const bodyLen = buffer.readUInt32LE(0);
            const totalLen = 4 + bodyLen;

            if (buffer.length < totalLen) break; // need more data

            const bodyBuf = buffer.subarray(4, totalLen);
            buffer = buffer.subarray(totalLen);

            try {
                const msg = JSON.parse(bodyBuf.toString('utf8'));
                onMessage(msg);
            } catch (e: any) {
                logger.error({ err: e }, '[gridsearch-uds] Failed to parse IPC frame');
            }
        }
    };
}

// ─── Worker Spawn & Connect ──────────────────────────────────────────────────

export interface SpawnedWorker {
    proc: ChildProcess;
    port: number;
}

/**
 * Spawns the C++ gridsearch worker in UDS/named-pipe mode.
 * On Windows: uses TCP port. On Unix: would use a socket path.
 */
export function spawnGridsearchWorker(port: number, userId: string): SpawnedWorker {
    const exePath = resolveExePath();
    const address = getUdsAddress(port);
    const udsArg = String(address);
    if (!IS_WIN && typeof address === 'string' && existsSync(address)) {
        try {
            unlinkSync(address);
        } catch (e) {
            logger.warn({ err: e, path: address }, '[gridsearch-uds] Failed to unlink stale socket path');
        }
    }

    const basePath = process.env.GRIDSEARCH_PATH || 'cpp/dist';
    const isAbsolute = /^[a-zA-Z]:[\\/]/.test(basePath) || basePath.startsWith('/');
    const dir = isAbsolute ? basePath : resolve(process.cwd(), basePath);
    const cppDir = resolve(dir, '..');
    const argv = ['worker', '--uds', udsArg, '--daemon', '--user-uid', userId];
    /** C++ spdlog file sink; default to tmp so production users without writable server/logs/ do not SIGABRT. */
    const udsLogFile =
        process.env.POLYMECH_UDS_LOG_FILE ?? join(tmpdir(), `polymech-uds-${port}-${PROCESS_RUN_ID}.json`);

    logger.info({
        exePath,
        cppDir,
        cwd: cppDir,
        udsArg,
        udsLogFile,
        userId,
        port,
        argv,
        sockDir: process.env.GRIDSEARCH_UDS_SOCK_DIR || tmpdir(),
        gridsearchPath: process.env.GRIDSEARCH_PATH
    }, '[gridsearch-uds] Spawning UDS worker process');

    const proc = spawn(exePath, argv, {
        stdio: ['ignore', 'pipe', 'pipe'],
        cwd: cppDir,
        env: {
            ...process.env,
            POLYMECH_UDS_LOG_FILE: udsLogFile
        }
    });

    const streamMeta = { port, pid: proc.pid, udsArg };
    attachCppStreamLog(proc.stdout, 'stdout', streamMeta);
    attachCppStreamLog(proc.stderr, 'stderr', streamMeta);

    proc.on('error', (err) => {
        logger.error({ err, exePath, cppDir, port, udsArg }, '[gridsearch-uds] Worker process spawn error');
    });

    proc.on('exit', (code, signal) => {
        logger.warn({ code, signal, exePath, port, udsArg, pid: proc.pid }, '[gridsearch-uds] Worker process exited');
    });

    return { proc, port };
}

/**
 * Connects to the C++ worker via TCP socket with retries.
 * Returns the connected net.Socket.
 */
export async function connectToWorker(port: number, retries = GRIDSEARCH_UDS_CONNECT_RETRIES, intervalMs = GRIDSEARCH_UDS_CONNECT_INTERVAL_MS): Promise<net.Socket> {
    let lastError: Error | null = null;
    const address = getUdsAddress(port);

    logger.info({ port, address, retries }, '[gridsearch-uds] Attempting to connect to UDS worker');

    for (let i = 0; i < retries; i++) {
        try {
            const socket = await new Promise<net.Socket>((resolve, reject) => {
                const sock = IS_WIN
                    ? net.connect({ port: address as number, host: '127.0.0.1' })
                    : net.connect(address as string);

                sock.once('connect', () => resolve(sock));
                sock.once('error', reject);
            });
            logger.info({ port, attempt: i + 1 }, '[gridsearch-uds] Connected to worker successfully');
            return socket;
        } catch (e: any) {
            lastError = e;
            logger.info({
                port,
                address,
                attempt: i + 1,
                retries,
                message: e?.message,
                code: e?.code,
                errno: e?.errno,
                syscall: e?.syscall
            }, '[gridsearch-uds] Connection attempt failed');
            if (i < retries - 1) {
                await new Promise(r => setTimeout(r, intervalMs));
            }
        }
    }

    logger.error({ port, address, lastError }, '[gridsearch-uds] Exhausted all retries connecting to worker');
    throw new Error(`[gridsearch-uds] Failed to connect after ${retries} retries: ${lastError?.message}`);
}

// ─── Payload Building ────────────────────────────────────────────────────────

export interface GridsearchPayload {
    guided: any;
    search: any;
    enrich?: boolean;
    enrichers?: any[];
    excludeTypes?: string[];
    parentId?: string;
    jobId: string;
    configPath: string;
    /** Explicit libpq conninfo from DATABASE_URL — overrides postgres.toml on the C++ side. */
    databaseUrl?: string;
    cacheDir: string;
    viewportSearch?: boolean;
    viewportCenter?: { lat: number; lng: number };
    viewportZoom?: number;
}

/**
 * Builds the IPC payload for the C++ worker from the job data.
 */
export function buildPayload(opts: {
    guided: any;
    search: any;
    enrichers?: any[];
    excludeTypes?: string[];
    parentId?: string;
    jobId: string;
    viewportSearch?: boolean;
    viewportCenter?: { lat: number; lng: number };
    viewportZoom?: number;
}): GridsearchPayload {
    return {
        guided: opts.guided,
        search: opts.search,
        enrich: !!(opts.enrichers && opts.enrichers.length > 0),
        enrichers: opts.enrichers || [],
        excludeTypes: opts.excludeTypes || [],
        parentId: opts.parentId,
        jobId: opts.jobId,
        configPath: resolveConfigPath(),
        // Same DSN as getServicePool() — must match DB where grid_search_runs rows live.
        databaseUrl: getServiceDatabaseUrl(),
        cacheDir: GRIDSEARCH_CACHE,
        viewportSearch: opts.viewportSearch,
        viewportCenter: opts.viewportCenter,
        viewportZoom: opts.viewportZoom,
    };
}

/**
 * Sends the gridsearch payload to the worker via length-prefixed frame.
 */
export function sendGridsearchPayload(socket: net.Socket, payload: GridsearchPayload): void {
    writeFrame(socket, payload);
}

/**
 * Sends a cancel command to the worker for a specific job.
 */
export function sendCancelFrame(socket: net.Socket, jobId: string): void {
    writeFrame(socket, { action: 'cancel', jobId });
}

/** Pause, resume, or cancel the active pipeline for `jobId` on the user's UDS worker. */
export function sendGridSearchControlFrame(
    socket: net.Socket,
    jobId: string,
    action: 'pause' | 'resume' | 'cancel',
): void {
    writeFrame(socket, { action, jobId });
}

export async function sendGridSearchControl(
    manager: GridSearchUdsManager,
    userId: string,
    jobId: string,
    action: 'pause' | 'resume' | 'cancel',
): Promise<void> {
    const { socket } = await manager.getOrCreateWorker(userId);
    sendGridSearchControlFrame(socket, jobId, action);
}

// ─── Pipeline Orchestrator ───────────────────────────────────────────────────

export interface PipelineOptions {
    jobId: string;
    runId: string;
    userId: string;
    guided: any;
    search: any;
    enrichers?: any[];
    excludeTypes?: string[];
    parentId?: string;
    viewportSearch?: boolean;
    viewportCenter?: { lat: number; lng: number };
    viewportZoom?: number;
    /** EventEmitter to forward IPC events as job:progress */
    emitter?: EventEmitter;
    /** AbortSignal for cancellation */
    signal?: AbortSignal;
    /** UDS TCP port override */
    port?: number;
}

export interface PipelineResult {
    enrichResults: string[];
    totalEmails: number;
    totalPagesScraped: number;
    freshApiCalls: number;
    waypointCount: number;
    gridStats: any;
    searchStats: any;
    enumMs: number;
    searchMs: number;
    enrichMs: number;
    totalMs: number;
}

/**
 * Runs the full gridsearch pipeline via the C++ UDS worker.
 *
 * 1. Spawns the C++ worker process
 * 2. Connects via TCP socket
 * 3. Sends the gridsearch payload
 * 4. Streams IPC events, forwarding them to the EventEmitter
 * 5. On completion: upserts locations to `places` table, updates `grid_search_runs`
 * 6. Returns the final result summary
 */
export async function runGridsearchPipeline(manager: GridSearchUdsManager, opts: PipelineOptions): Promise<PipelineResult> {
    const { jobId, runId, userId, guided, search, enrichers, excludeTypes, parentId, emitter, signal, port, viewportSearch, viewportCenter, viewportZoom } = opts;

    // 1. Get or create worker from pool (one per user)
    const { socket, proc } = await manager.getOrCreateWorker(userId);

    // Wire up cancellation
    if (signal) {
        signal.addEventListener('abort', () => {
            sendCancelFrame(socket, jobId);
        }, { once: true });
    }

    // 2. Send payload
    const payload = buildPayload({ guided, search, enrichers, excludeTypes, parentId, jobId, viewportSearch, viewportCenter, viewportZoom });
    logger.info({
        jobId: runId,
        userId,
        dbTarget: maskPostgresUrlForLog(payload.databaseUrl),
        regions: guided?.areas?.map((a: any) => ({ name: a.name, gid: a.gid, level: a.level })),
        grid: guided?.settings,
        excludeTypes,
        search: {
            query: search?.q || search?.types?.join(', '),
            limit: search?.limitPerArea,
            enrich: payload.enrich,
            enrichers: payload.enrichers,
            viewportSearch,
            viewportCenter,
            viewportZoom
        }
    }, '[gridsearch-uds] Sending gridsearch payload to worker');

    sendGridsearchPayload(socket, payload);

    // 3. Stream events — resolve on IPC job_result/error (socket stays open for next job)
    return new Promise<PipelineResult>((resolve, reject) => {
        const enrichedPlaceIds = new Set<string>();
        let finalResult: any = null;
        let settled = false;
        let ackReceived = false;

        const ackTimer = setTimeout(() => {
            if (!ackReceived && !settled) {
                logger.error({ jobId }, '[gridsearch-uds] UDS Ack timeout (worker stuck or crashed)');
                settle('failed', new Error(`UDS worker failed to acknowledge job within ${GRIDSEARCH_UDS_ACK_TIMEOUT_MS}ms`));
            }
        }, GRIDSEARCH_UDS_ACK_TIMEOUT_MS);

        const settle = async (status: 'complete' | 'failed', err?: Error) => {
            if (settled) return;
            settled = true;
            clearTimeout(ackTimer);

            logger.info({ jobId: runId, status, error: err?.message, finalResultLen: JSON.stringify(finalResult)?.length }, '[gridsearch-uds] Pipeline settling');

            // Remove this job's data listener so next job gets its own
            socket.removeListener('data', onData);

            const result: PipelineResult = {
                enrichResults: Array.from(enrichedPlaceIds),
                totalEmails: finalResult?.totalEmails ?? 0,
                totalPagesScraped: finalResult?.totalPagesScraped ?? 0,
                freshApiCalls: finalResult?.freshApiCalls ?? 0,
                waypointCount: finalResult?.waypointCount ?? 0,
                gridStats: finalResult?.gridStats ?? {},
                searchStats: finalResult?.searchStats ?? {},
                enumMs: finalResult?.enumMs ?? 0,
                searchMs: finalResult?.searchMs ?? 0,
                enrichMs: finalResult?.enrichMs ?? 0,
                totalMs: finalResult?.totalMs ?? 0,
            };

            const wasCancelled = status === 'complete' && !!(finalResult && (finalResult as any).cancelled === true);
            const dbStatus: 'complete' | 'failed' | 'cancelled' =
                status === 'failed' ? 'failed' : wasCancelled ? 'cancelled' : 'complete';

            // Update child grid_search_runs row
            try {
                let dbResult: any = result;
                if (status === 'failed' && err) {
                    dbResult = { error: err.message, ...result };
                } else if (status === 'failed' && finalResult) { // C++ error object
                    dbResult = { error: finalResult, ...result };
                } else if (wasCancelled && finalResult) {
                    dbResult = { ...result, ...(typeof finalResult === 'object' ? finalResult : {}) };
                }

                const { error: runError } = await updateGridSearchRun(runId, { result: dbResult, status: dbStatus });
                if (runError) {
                    logger.error({ jobId, runId, error: runError }, '[gridsearch-uds] Failed to update grid_search_runs');
                }
            } catch (e) {
                logger.error({ jobId, runId, error: e }, '[gridsearch-uds] DB update error');
            }

            // If this is a child expand job, update parent status and close its SSE
            if (parentId && parentId !== runId) {
                try {
                    await updateGridSearchRun(parentId, {
                        status: dbStatus === 'complete' ? 'complete' : dbStatus,
                    });
                    logger.info({ parentId, runId, status: dbStatus }, '[gridsearch-uds] Updated parent status after child expand');
                } catch (e) {
                    logger.error({ parentId, runId, error: e }, '[gridsearch-uds] Failed to update parent status');
                }

                // Complete the parent SSE stream
                if (emitter) {
                    emitter.emit('job:complete', { jobId: parentId, result, status: dbStatus });
                }
            }

            if (emitter) {
                emitter.emit('job:complete', { jobId: runId, result, status: dbStatus });
            }

            if (status === 'failed') {
                reject(err || new Error(typeof finalResult === 'string' ? finalResult : 'Pipeline failed'));
            } else {
                resolve(result);
            }
        };

        const feedData = createFrameReader((msg) => {
            const eventType = msg.type;
            const data = msg.data !== undefined ? msg.data : (() => {
                const { type, ...rest } = msg;
                return rest;
            })();

            //logger.info({ jobId: runId, type: eventType }, '[gridsearch-uds] Received IPC frame');
            //console.log('[gridsearch-uds] Received IPC frame', eventType, data);

            if (eventType === 'ack') {
                //console.log('[gridsearch-uds] Received ack');
                ackReceived = true;
                clearTimeout(ackTimer);
                // Do not emit ack to SSE, it's internal
                return;
            }

            if (eventType === 'pong') {
                //console.log('[gridsearch-uds] Received pong');
                return; // Internal health check response
            }

            // Forward all events to EventBus for SSE streaming
            if (emitter && !settled) {
                //console.log('[gridsearch-uds] Emitting job:progress', eventType, data);
                emitter.emit('job:progress', {
                    jobId: runId,
                    type: eventType,
                    data,
                });
                // Also forward to parent stream so expand events appear live
                if (parentId && parentId !== runId) {
                    emitter.emit('job:progress', {
                        jobId: parentId,
                        type: eventType,
                        data,
                    });
                }
            }

            // Extract place ID depending on event type
            let extractedPlaceId: string | undefined;
            if (eventType === 'node' && data.placeId) {
                extractedPlaceId = data.placeId;
            } else if (eventType === 'location' && data.location?.place_id) {
                extractedPlaceId = data.location.place_id;
            }

            // Collect place IDs for result summary (from both search and enrichment phases)
            if (extractedPlaceId) {
                enrichedPlaceIds.add(extractedPlaceId);
            }

            // Pipeline finished — job_result carries final stats
            if (eventType === 'job_result') {
                finalResult = data;
                settle('complete');
            }

            // Pipeline error — boundary missing, config error, etc.
            if (eventType === 'error') {
                logger.error({ jobId, data }, '[gridsearch-uds] Pipeline error from C++');
                finalResult = data;
                settle('failed');
            }
        });

        const onData = (chunk: Buffer) => {
            //logger.debug({ jobId: runId, bytes: chunk.length }, '[gridsearch-uds] Raw socket chunk received');
            //console.log('[gridsearch-uds] Raw socket chunk received', chunk.length);
            feedData(chunk);
        };
        socket.on('data', onData);

        // Crash fallback: if the socket closes unexpectedly mid-job
        const onClose = () => {
            if (!settled) {
                logger.warn({ jobId }, '[gridsearch-uds] Socket closed unexpectedly during job');
                settle('failed');
            }
        };
        socket.once('close', onClose);

        socket.once('error', (err) => {
            logger.error({ jobId, err }, '[gridsearch-uds] Socket error during job');
            if (!settled) settle('failed', err);
        });

        // Crash fallback: if the worker process dies
        const onExit = (code: number | null) => {
            if (!settled && code !== 0) {
                logger.error({ jobId, code }, '[gridsearch-uds] Worker exited during job');
                socket.destroy();
            }
        };
        proc.once('exit', onExit);
    });
}
