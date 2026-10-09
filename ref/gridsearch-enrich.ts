/**
 * Grid Search — Phase 3: Enrichment Pipeline
 *
 * Orchestrates MetaEnricher → EmailEnricher for each location produced by
 * Phase 2 (gridSearchGoogleMaps).  This is the canonical place to instantiate
 * and sequence enrichers — NOT in tests or API route handlers.
 *
 * Architecture:
 *   Phase 1  gridEnumerate()         — GADM tree walk, no cost
 *   Phase 2  gridSearchGoogleMaps()  — SerpAPI search per area
 *   Phase 3  gridSearchEnrich()      — enricher pipeline per location  ← this file
 */

import { MetaEnricher } from './enrichers/meta.js';
import { EmailEnricher } from './enrichers/email.js';
import type { LocationCacheProvider } from './gridsearch-googlemaps.js';

// ── Public types ─────────────────────────────────────────────────────────────

// Per-enricher option bags
export interface MetaEnricherConfig {
    timeoutMs?: number;
    /** Regexes matched against discovered page URLs — matching pages are forwarded to email scraping */
    contactPagePatterns?: RegExp[];
    /** Fallback probe paths appended to base URL when meta finds ≤1 contact pages */
    probePaths?: string[];
}

export interface EmailEnricherConfig {
    timeoutMs?: number;
    pageTimeoutMs?: number;
    maxPages?: number;
    abortAfter?: number;
}

/** A single enricher entry — either a plain name or a name + options override. */
export type EnricherSpec =
    | 'meta'
    | 'email'
    | { name: 'meta';  options?: MetaEnricherConfig }
    | { name: 'email'; options?: EmailEnricherConfig };

export interface PageError {
    url: string;
    /** 'SEARCHED_EMAIL' | 'FAILED' | 'AXIOS_NO_EMAIL' | … */
    status: string;
    method?: string;
    error?: string;
    httpStatus?: number;
    emails?: string[];
    /** Page body as markdown (for downstream qualification enrichers) */
    bodyContent?: string;
}

export type EnrichStatus =
    | 'OK'
    | 'NO_EMAIL'
    | 'META_TIMEOUT'
    | 'EMAIL_TIMEOUT'
    | 'FETCH_ERROR'
    | 'NO_PAGES'
    | 'ERROR';

export interface EnrichedNode {
    idx: number;
    title: string;
    placeId: string;
    website: string;
    address: string;
    type: string;
    gridArea: string;
    gridGid: string;
    pagesFound: number;
    pagesScraped: number;
    emails: string[];
    metaMs: number;
    emailMs: number;
    totalMs: number;
    status: EnrichStatus;
    error?: string;
    /** Keyed page bodies — `home` = markdown text of the home page.
     *  Set by MetaEnricher; upgraded by EmailEnricher for JS-rendered SPAs. */
    pages: Record<string, string>;
    /** Raw home-page HTML (kept for downstream processing) */
    bodyHtml?: string;
    httpStatus?: number;
    fetchError?: string;
    pageErrors: PageError[];
    /**
     * Deterministic hash of the enricher config that produced this node.
     * Used for cache invalidation — if the active config hash differs from
     * the stored hash the cached entry is skipped and the node is re-enriched.
     * Covers: which enrichers run, all effective timeouts, maxPages,
     * abortAfter, contactPagePatterns, and probePaths.
     */
    enricherHash?: string;
    /**
     * True when this node was served from the FileLocationCache (Phase 3).
     * Absent (undefined) on freshly-enriched nodes.
     */
    fromCache?: boolean;
}

export interface GridSearchEnrichOptions {
    /** Locations from Phase 2 (with `_gridArea` / `_gridGid` set) */
    locations: any[];

    // ── Enricher pipeline ─────────────────────────────────────────────
    /**
     * Which enrichers to run, in order.  Each entry is either a plain name
     * (`'meta'` | `'email'`) or an object that also carries per-enricher
     * option overrides.
     *
     * @example ['meta', 'email']                          // both, default options
     * @example ['meta']                                   // skip email
     * @example [{ name: 'meta', options: { timeoutMs: 3000 } }, 'email']
     *
     * @default ['meta', 'email']
     */
    enrichers?: EnricherSpec[];

    // ── Default enricher timeouts (overridable per-enricher via `enrichers`) ──
    metaTimeoutMs?: number;
    emailTimeoutMs?: number;
    emailPageTimeoutMs?: number;
    emailMaxPages?: number;
    /** Stop email search after this many emails found per location */
    emailAbortAfter?: number;

    // ── Page selection (top-level fallbacks — prefer meta enricher options) ──
    /** @deprecated Prefer { name: 'meta', options: { contactPagePatterns } } */
    contactPagePatterns?: RegExp[];
    /** @deprecated Prefer { name: 'meta', options: { probePaths } } */
    probePaths?: string[];

    // ── Time budget ───────────────────────────────────────────────────
    /** Stop enriching after this many ms (0 = no limit) */
    enrichBudgetMs?: number;

    // ── Callbacks ─────────────────────────────────────────────────────
    /** Called once a location is fully enriched (cache or fresh) */
    onNode?: (node: EnrichedNode) => void;
    /** Called when a location's enrichment fails or produces an error status */
    onNodeError?: (node: EnrichedNode, error: string) => void;
    /** Called for each page visited by EmailEnricher */
    onNodePage?: (
        location: any,
        url: string,
        bodyContent: string | undefined,
        status: string,
        error?: string,
    ) => void;

    // ── Cache ─────────────────────────────────────────────────────────
    cache?: LocationCacheProvider<EnrichedNode>;

    /** AbortSignal to cancel enrichment */
    signal?: AbortSignal;
    /** Checking function to pause enrichment */
    isPaused?: () => boolean;

    logger?: any;
}

// ── Internal helpers ─────────────────────────────────────────────────────────

function resolveEnrichers(specs: EnricherSpec[]) {
    let metaCfg: MetaEnricherConfig  | null = null;
    let emailCfg: EmailEnricherConfig | null = null;
    for (const spec of specs) {
        const name   = typeof spec === 'string' ? spec : spec.name;
        const opts   = typeof spec === 'string' ? {} : (spec.options ?? {});
        if (name === 'meta')  metaCfg  = opts as MetaEnricherConfig;
        if (name === 'email') emailCfg = opts as EmailEnricherConfig;
    }
    return { metaCfg, emailCfg };
}

const DEFAULT_CONTACT_PATTERNS: RegExp[] = [
    /contact/i, /kontakt/i, /contacto/i, /contacta/i, /impression/i,
    /about/i, /impress/i, /impressum/i, /datenschutz/i, /privacy/i,
    /legal/i, /team/i, /nosotros/i, /empresa/i, /sobre/i,
];

const DEFAULT_PROBE_PATHS: string[] = [
    '/contact', '/contacto', '/kontakt', '/contacta',
    '/about', '/about-us', '/impressum',
];

function fmtMs(ms: number): string {
    if (ms < 1000) return `${ms}ms`;
    return `${(ms / 1000).toFixed(1)}s`;
}

// ── Enricher config hash ─────────────────────────────────────────────────────

/**
 * Compute a short deterministic hash of the active enricher config.
 * Any change to which enrichers run or their effective options produces
 * a different hash, causing the FileLocationCache to miss and re-enrich.
 *
 * Uses djb2 (no crypto dependency).
 */
function computeEnricherHash(cfg: {
    runMeta: boolean;
    runEmail: boolean;
    metaTimeoutMs: number;
    contactPagePatterns: RegExp[];
    probePaths: string[];
    emailTimeoutMs: number;
    emailPageTimeoutMs: number;
    emailMaxPages: number;
    emailAbortAfter: number;
}): string {
    const key = JSON.stringify({
        meta:         cfg.runMeta,
        email:        cfg.runEmail,
        metaTo:       cfg.runMeta  ? cfg.metaTimeoutMs      : null,
        patterns:     cfg.runMeta  ? cfg.contactPagePatterns.map(r => r.source) : null,
        probes:       cfg.runMeta  ? cfg.probePaths          : null,
        emailTo:      cfg.runEmail ? cfg.emailTimeoutMs      : null,
        emailPageTo:  cfg.runEmail ? cfg.emailPageTimeoutMs  : null,
        maxPages:     cfg.runEmail ? cfg.emailMaxPages        : null,
        abortAfter:   cfg.runEmail ? cfg.emailAbortAfter      : null,
    });
    let h = 5381;
    for (let i = 0; i < key.length; i++) {
        h = Math.imul((h << 5) + h, 1) ^ key.charCodeAt(i);
    }
    return (h >>> 0).toString(16);
}

// ── Phase 3 ──────────────────────────────────────────────────────────────────

export async function gridSearchEnrich(
    opts: GridSearchEnrichOptions,
): Promise<{ nodes: EnrichedNode[]; totalEmails: number; totalPagesScraped: number }> {
    const {
        locations,
        enrichers: enricherSpecs = ['meta', 'email'],
        metaTimeoutMs = 20_000,
        emailTimeoutMs = 30_000,
        emailPageTimeoutMs = 10_000,
        emailMaxPages = 8,
        emailAbortAfter = 1,
        contactPagePatterns = DEFAULT_CONTACT_PATTERNS,
        probePaths = DEFAULT_PROBE_PATHS,
        enrichBudgetMs = 0,
        onNode,
        onNodeError,
        onNodePage,
        cache,
        logger: log,
    } = opts;

    // Resolve which enrichers are active and their per-spec overrides
    const { metaCfg, emailCfg } = resolveEnrichers(enricherSpecs);
    const runMeta  = metaCfg  !== null;
    const runEmail = emailCfg !== null;

    // Effective options — per-spec overrides win over top-level defaults
    const effectiveMetaTimeoutMs       = metaCfg?.timeoutMs            ?? metaTimeoutMs;
    const effectiveContactPagePatterns = metaCfg?.contactPagePatterns   ?? contactPagePatterns;
    const effectiveProbePaths          = metaCfg?.probePaths            ?? probePaths;
    const effectiveEmailTimeoutMs      = emailCfg?.timeoutMs            ?? emailTimeoutMs;
    const effectiveEmailPageTimeout    = emailCfg?.pageTimeoutMs        ?? emailPageTimeoutMs;
    const effectiveEmailMaxPages       = emailCfg?.maxPages             ?? emailMaxPages;
    const effectiveEmailAbortAfter     = emailCfg?.abortAfter           ?? emailAbortAfter;

    // Hash of the current enricher config — used to invalidate stale cache entries
    const currentEnricherHash = computeEnricherHash({
        runMeta,
        runEmail,
        metaTimeoutMs:      effectiveMetaTimeoutMs,
        contactPagePatterns: effectiveContactPagePatterns,
        probePaths:         effectiveProbePaths,
        emailTimeoutMs:     effectiveEmailTimeoutMs,
        emailPageTimeoutMs: effectiveEmailPageTimeout,
        emailMaxPages:      effectiveEmailMaxPages,
        emailAbortAfter:    effectiveEmailAbortAfter,
    });

    const metaEnricher  = runMeta  ? new MetaEnricher()  : null;
    const emailEnricher = runEmail ? new EmailEnricher({
        timeoutMs:    effectiveEmailTimeoutMs,
        maxPages:     effectiveEmailMaxPages,
        pageTimeoutMs: effectiveEmailPageTimeout,
        abortAfter:   effectiveEmailAbortAfter,
    }) : null;

    const nodes: EnrichedNode[] = [];
    let totalEmails = 0;
    let totalPagesScraped = 0;
    const enrichT0 = Date.now();

    for (let i = 0; i < locations.length; i++) {
        if (opts.signal?.aborted) {
            log?.info('Enrichment aborted');
            break;
        }

        while (opts.isPaused && opts.isPaused() && !opts.signal?.aborted) {
            await new Promise(r => setTimeout(r, 1000));
        }

        if (opts.signal?.aborted) {
            log?.info('Enrichment aborted');
            break;
        }

        // ── Time budget ───────────────────────────────────────────────
        if (enrichBudgetMs > 0 && Date.now() - enrichT0 >= enrichBudgetMs) {
            log?.info({ elapsed: Date.now() - enrichT0, processed: i }, 'Enrichment budget reached');
            break;
        }

        const loc = locations[i] as any;
        const locT0 = Date.now();
        const gridArea = loc._gridArea || '?';
        const gridGid  = loc._gridGid  || '?';

        // ── Cache hit ─────────────────────────────────────────────────
        if (cache && loc.place_id) {
            const cached = await cache.get(loc.place_id);
            if (cached && cached.enricherHash === currentEnricherHash) {
                const node: EnrichedNode = { ...cached, idx: i + 1, gridArea, gridGid, fromCache: true };
                nodes.push(node);
                if (node.emails.length > 0) totalEmails += node.emails.length;
                totalPagesScraped += node.pagesScraped;
                onNode?.(node);
                continue;
            }
            // Hash mismatch — enricher config changed, fall through to re-enrich
        }

        const node: EnrichedNode = {
            idx: i + 1,
            title: loc.title || '?',
            placeId: loc.place_id || '',
            website: loc.website || '',
            address: loc.address || '—',
            type: loc.type || '—',
            gridArea,
            gridGid,
            pagesFound: 0,
            pagesScraped: 0,
            emails: [],
            metaMs: 0,
            emailMs: 0,
            totalMs: 0,
            status: 'NO_EMAIL',
            pages: {},
            pageErrors: [],
            enricherHash: currentEnricherHash,
        };

        let metaTimedOut = false;
        const metaT0 = Date.now();

        try {
            // ── Step A: MetaEnricher ──────────────────────────────────
            let metaResult: any = undefined;
            if (runMeta && metaEnricher) {
                const metaTimeout = new Promise<null>(r => setTimeout(() => r(null), effectiveMetaTimeoutMs));
                metaResult = await Promise.race([
                    metaEnricher.enrich(
                        { place_id: loc.place_id, title: loc.title, website: loc.website } as any,
                        { userId: 'pipeline', logger: log },
                    ),
                    metaTimeout,
                ]);
                node.metaMs = Date.now() - metaT0;
                metaTimedOut = metaResult === null;
            }

            const meta = (metaResult as any)?.raw_data?.meta;
            node.pagesFound = meta?.pages?.length || 0;

            if (meta) {
                if (meta.bodyText) node.pages.home = meta.bodyText;
                node.bodyHtml   = meta.bodyHtml;
                node.httpStatus = meta.httpStatus;
                node.fetchError = meta.fetchError;
            }

            // ── Early exit: MetaEnricher found emails in HTML ─────────
            if (meta?.emails?.length) {
                node.emails = meta.emails.map((e: any) => typeof e === 'string' ? e : e.email);
                totalEmails += node.emails.length;
                node.status   = 'OK';
                node.totalMs  = Date.now() - locT0;
                nodes.push(node);
                if (cache) await cache.set(loc.place_id, node);
                onNode?.(node);
                continue;
            }

            // ── Build page list for EmailEnricher ─────────────────────
            let pages: any[] = [];
            if (meta?.pages?.length) {
                pages = meta.pages
                    .map((p: any) => ({ url: p.url || p, ...(typeof p === 'object' ? p : {}) }))
                    .filter((p: any) => effectiveContactPagePatterns.some(rx => rx.test(p.url)));
            }

            if (pages.length < 2) {
                const base = loc.website.replace(/\/+$/, '');
                const existing = new Set(pages.map((p: any) => p.url));
                for (const path of effectiveProbePaths) {
                    const url = base + path;
                    if (!existing.has(url)) { pages.push({ url, source: 'probe' }); existing.add(url); }
                }
            }
            node.pagesFound = pages.length;

            if (pages.length === 0 || !runEmail || !emailEnricher) {
                node.status  = metaTimedOut ? 'META_TIMEOUT' : (!runEmail ? 'NO_EMAIL' : 'NO_PAGES');
                node.totalMs = Date.now() - locT0;
                nodes.push(node);
                if (cache) await cache.set(loc.place_id, node);
                onNode?.(node);
                continue;
            }

            // ── Step B: EmailEnricher ─────────────────────────────────
            const emailT0 = Date.now();
            const locationWithMeta = {
                place_id: loc.place_id,
                title: loc.title,
                website: loc.website,
                raw_data: {
                    ...(metaResult?.raw_data || {}),
                    meta: { ...(meta || {}), pages },
                },
            };

            const emailResult = await emailEnricher.enrich(locationWithMeta as any, {
                userId: 'pipeline',
                logger: log,
            });
            node.emailMs = Date.now() - emailT0;

            const emailMeta = (emailResult as any).raw_data?.meta;

            if (emailMeta?.emails?.length) {
                node.emails = emailMeta.emails.map((e: any) => typeof e === 'string' ? e : e.email);
                totalEmails += node.emails.length;
            }

            // Promoted home bodyText (SPA fallback from EmailEnricher)
            if (emailMeta?.bodyText && emailMeta.bodyText.length > (node.pages.home?.length ?? 0)) {
                node.pages.home = emailMeta.bodyText;
            }

            node.pagesScraped = emailMeta?.pages?.filter((p: any) =>
                p.status === 'SEARCHED_EMAIL' || p.status === 'FAILED'
            )?.length || 0;
            totalPagesScraped += node.pagesScraped;

            if (emailMeta?.pageResults) {
                const homeUrl = loc.website?.replace(/\/+$/, '') || '';
                node.pageErrors = emailMeta.pageResults.map((pr: any) => {
                    // Upgrade pages.home if real browser got a richer result
                    if (homeUrl && pr.url) {
                        const prBase = pr.url.replace(/\/+$/, '');
                        const body = pr.bodyContent as string | undefined;
                        if (prBase === homeUrl && body && body.length > (node.pages.home?.length ?? 0)) {
                            node.pages.home = body;
                        }
                    }
                    return {
                        url: pr.url, status: pr.status, method: pr.method,
                        error: pr.error, httpStatus: pr.httpStatus,
                        emails: pr.emails, bodyContent: pr.bodyContent,
                    };
                });

                if (onNodePage) {
                    for (const pr of node.pageErrors) {
                        onNodePage(loc, pr.url, pr.bodyContent, pr.status, pr.error);
                    }
                }
            }

            const emailTimedOut = node.emailMs >= effectiveEmailTimeoutMs - 1_000;
            node.status =
                node.emails.length > 0 ? 'OK'
                : node.fetchError      ? 'FETCH_ERROR'
                : emailTimedOut        ? 'EMAIL_TIMEOUT'
                : metaTimedOut         ? 'META_TIMEOUT'
                :                        'NO_EMAIL';

        } catch (err: any) {
            node.error   = err.message;
            node.status  = 'ERROR';
            node.metaMs  = node.metaMs || (Date.now() - metaT0);
        }

        node.totalMs = Date.now() - locT0;
        nodes.push(node);
        if (cache) await cache.set(loc.place_id, node);
        onNode?.(node);

        // Fire error callback for failed/problematic statuses
        if (node.status === 'ERROR' || node.status === 'FETCH_ERROR' || node.status === 'META_TIMEOUT' || node.status === 'EMAIL_TIMEOUT') {
            onNodeError?.(node, node.error || node.fetchError || `Enrichment ${node.status}`);
        }

        log?.info({
            idx: i + 1, title: loc.title, status: node.status,
            emails: node.emails.length, pagesScraped: node.pagesScraped,
            metaMs: node.metaMs, emailMs: node.emailMs,
        }, `[${i + 1}] Done`);
    }

    return { nodes, totalEmails, totalPagesScraped };
}
