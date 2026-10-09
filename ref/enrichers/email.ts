import { PlaceFull } from '@polymech/shared';
import { IEnricher, EnrichmentContext } from './registry.js';
import { IEmailScraper } from '../EmailScraper.js';
import { ScrapelessEmailScraper } from '../EmailScraperScrapeless.js';
import { LocalEmailScraper } from '../EmailScraperLocal.js';
import { CONFIG_DEFAULT } from '@polymech/commons';
import { logger as defaultLogger } from '@/commons/logger.js';
import { Page } from '../search/map_types.js';
import TurndownService from 'turndown';
import {
    EMAIL_SEARCH_TIMEOUT_MS,
    EMAIL_SEARCH_MAX_PAGES,
    EMAIL_SEARCH_PAGE_TIMEOUT_MS,
    EMAIL_SEARCH_PAGE_CONCURRENCY,
} from '../constants.js';

const _td = new TurndownService({ headingStyle: 'atx', bulletListMarker: '-' });
// Remove noise elements before conversion
_td.remove(['script', 'style', 'noscript', 'svg', 'iframe', 'head'] as any[]);

/** Strip raw HTML → clean markdown. Removes JS/CSS/SVG noise. Passes plain text through. */
function htmlToText(raw: string | undefined): string | undefined {
    if (!raw) return undefined;
    if (!/<[a-zA-Z]/.test(raw)) return raw;
    try { return _td.turndown(raw); } catch { return raw; }
}

// Asset/image extensions that look like TLDs to email regex
const ASSET_EXTENSIONS = new Set([
    'avif', 'webp', 'png', 'jpg', 'jpeg', 'gif', 'svg', 'ico', 'bmp', 'tiff',
    'woff', 'woff2', 'ttf', 'eot', 'otf',
    'css', 'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'map',
    'json', 'xml', 'csv', 'pdf', 'zip', 'gz', 'br',
    'mp4', 'webm', 'mp3', 'wav', 'ogg',
]);

export function isLikelyEmail(candidate: string): boolean {
    const parts = candidate.split('@');
    if (parts.length !== 2) return false;
    const [local, domain] = parts;

    // Domain must have at least one dot
    if (!domain.includes('.')) return false;

    // Check if TLD is actually an asset extension
    const tld = domain.split('.').pop()?.toLowerCase() || '';
    if (ASSET_EXTENSIONS.has(tld)) return false;

    // Reject if domain looks like a hash/dimension pattern (e.g., 120w.09fb431d)
    if (/^\d+\w?\.[0-9a-f]+$/i.test(domain)) return false;

    // Local part should not be purely numeric
    if (/^\d+$/.test(local)) return false;

    return true;
}

export interface EmailEnricherOptions {
    timeoutMs?: number;
    maxPages?: number;
    pageTimeoutMs?: number;
    concurrency?: number;
    abortAfter?: number;
    headless?: boolean;
}

export class EmailEnricher implements IEnricher {
    name = 'email';
    type = 'email';

    private scraper: IEmailScraper;
    private options: EmailEnricherOptions;

    constructor(options?: EmailEnricherOptions) {
        this.options = {
            timeoutMs: EMAIL_SEARCH_TIMEOUT_MS,
            maxPages: EMAIL_SEARCH_MAX_PAGES,
            pageTimeoutMs: EMAIL_SEARCH_PAGE_TIMEOUT_MS,
            concurrency: EMAIL_SEARCH_PAGE_CONCURRENCY,
            abortAfter: 1,
            headless: true,
            ...options,
        };

        // Auto-select scraper based on environment
        const config = CONFIG_DEFAULT() as any;
        const SCRAPELESS_KEY = config.scrapeless?.key || process.env.SCRAPELESS_KEY;
        const USE_SCRAPELESS = process.env.ENRICHER_EMAIL_SCRAPER === 'SCRAPELESS' && SCRAPELESS_KEY;

        this.scraper = USE_SCRAPELESS
            ? new ScrapelessEmailScraper()
            : new LocalEmailScraper();
    }

    async enrich(location: PlaceFull, context: EnrichmentContext): Promise<Partial<PlaceFull>> {
        const log = context.logger || defaultLogger;

        if (!location.website) {
            log.debug({ placeId: location.place_id }, 'No website to search for emails');
            return {};
        }

        // Require meta.pages — MetaEnricher must run first
        const meta = (location as any).raw_data?.meta || (location as any).meta;
        if (!meta?.pages || !meta.pages.length) {
            log.warn({ placeId: location.place_id }, 'No meta.pages available — MetaEnricher must run first');
            return {};
        }

        // If MetaEnricher couldn't extract body text (JS-heavy SPA at domcontentloaded),
        // inject the home URL so the real browser can fetch it and give us usable body text.
        const homeUrl = location.website!.replace(/\/+$/, '');
        const homeAlreadyQueued = meta.pages.some(
            (p: any) => (p.url || p).replace(/\/+$/, '') === homeUrl
        );
        if (!meta.bodyText && !homeAlreadyQueued) {
            meta.pages = [{ url: location.website, source: 'home-probe' }, ...meta.pages];
            log.info({ placeId: location.place_id }, 'Injected home URL for body text capture (SPA fallback)');
        }

        log.info({
            placeId: location.place_id,
            website: location.website,
            pagesCount: meta.pages.length,
            existingEmails: meta.emails?.length || 0,
        }, 'Starting email enrichment');

        // Build a LocalResult-compatible object for the scraper
        const scraperLocation = {
            place_id: location.place_id,
            title: location.title,
            website: location.website,
            meta: meta,
            emails: [] as string[],
            email: undefined as string | undefined,
        } as any;

        let isCancelled = false;
        const checkCancelled = async () => isCancelled;

        const pageResults: Array<{ url: string; status: string; method?: string; error?: string; httpStatus?: number; emails?: string[]; bodyContent?: string }> = [];

        const searchPromise = this.scraper.findEmails(scraperLocation, {
            headless: this.options.headless,
            searchFrom: 'enricher',
            abortAfter: this.options.abortAfter,
            maxPages: this.options.maxPages,
            pageTimeout: this.options.pageTimeoutMs,
            concurrency: this.options.concurrency,
            checkCancelled,
            logger: log,
        }, async (page: Page) => {
            // Only record terminal statuses (skip SEARCHING_EMAIL which is the "start" notification)
            if (page.status === 'SEARCHING_EMAIL') return;
            pageResults.push({
                url: page.url,
                status: page.status,
                method: (page as any).method,
                error: (page as any).error,
                httpStatus: (page as any).httpStatus,
                emails: (page as any).emails,
                bodyContent: htmlToText((page as any).bodyContent),
            });
        });

        // Race against timeout
        let rawEmails: string[] = [];
        let timedOut = false;

        try {
            const result = await Promise.race([
                searchPromise,
                new Promise<never>((_, reject) => setTimeout(() => {
                    log.warn({
                        placeId: location.place_id,
                        timeoutMs: this.options.timeoutMs
                    }, 'Email enrichment timeout reached');
                    isCancelled = true;
                    timedOut = true;
                    reject(new Error('EmailEnricher:Timeout'));
                }, this.options.timeoutMs)),
            ]);
            if (result) rawEmails = result as string[];
        } catch (e: any) {
            if (e.message === 'EmailEnricher:Timeout') {
                // Proceed with partial results
                rawEmails = scraperLocation.emails || [];
            } else {
                log.error({ err: e.message, placeId: location.place_id }, 'Email enrichment failed');
                return {};
            }
        }

        // Apply isLikelyEmail filter
        const validEmails = [...new Set(rawEmails)].filter(isLikelyEmail);

        const scraperEmailsWithMetadata = validEmails.map(email => ({
            email,
            source: location.website || '',
            foundAt: new Date().toISOString(),
            tool: 'email-enricher',
        }));

        // Merge with existing meta emails (from MetaEnricher), dedup by email address
        const existingEmails: Array<{ email: string;[k: string]: any }> = (meta.emails || []).map(
            (e: any) => typeof e === 'string' ? { email: e, source: location.website || '', tool: 'meta' } : e
        );
        const seen = new Set(existingEmails.map((e: any) => e.email.toLowerCase()));
        const merged = [
            ...existingEmails,
            ...scraperEmailsWithMetadata.filter(e => !seen.has(e.email.toLowerCase())),
        ];

        log.info({
            placeId: location.place_id,
            fromMeta: existingEmails.length,
            fromScraper: scraperEmailsWithMetadata.length,
            merged: merged.length,
            timedOut,
            pagesSearched: pageResults.length,
        }, 'Email enrichment complete');

        // Promote home page bodyContent to meta.bodyText if MetaEnricher left it empty.
        // This fires when the real browser visited the home URL via the SPA fallback above.
        let bodyTextUpgrade: string | undefined;
        if (!meta.bodyText) {
            const homeResult = pageResults.find(
                pr => pr.url?.replace(/\/+$/, '') === homeUrl && pr.bodyContent
            );
            if (homeResult?.bodyContent) {
                bodyTextUpgrade = homeResult.bodyContent;
                log.info({ placeId: location.place_id }, 'Upgraded meta.bodyText from home page browser visit');
            }
        }

        return {
            raw_data: {
                ...location.raw_data,
                meta: {
                    ...meta,
                    ...(merged.length ? { emails: merged } : {}),
                    ...(bodyTextUpgrade ? { bodyText: bodyTextUpgrade } : {}),
                    pageResults,
                },
            },
        };
    }
}
