
import { IEmailScraper } from './EmailScraper.js';
import { LocalResult, Page } from './search/map_types.js';
import { logger } from '@/commons/logger.js';
import { Puppeteer } from '@scrapeless-ai/sdk';
import { CONFIG_DEFAULT } from '@polymech/commons';
import axios from 'axios';
import https from 'https';

export class ScrapelessEmailScraper implements IEmailScraper {

    private readonly EMAIL_REGEX = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
    private readonly IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp', '.ico', '.tiff', '.avif'];

    // Keywords that indicate a contact/about page — matched against URL **path** only
    private readonly CONTACT_KEYWORDS = ['contact', 'kontakt', 'contacto', 'contatto', 'imprint', 'impressum', 'about', 'help', 'support'];

    /**
     * Score a page URL by contact-relevance.
     * Only looks at the URL **path** (not domain) to avoid false matches like "polymech.info".
     */
    private contactScore(url: string): number {
        try {
            const pathname = new URL(url).pathname.toLowerCase();
            return this.CONTACT_KEYWORDS.some(k => pathname.includes(k)) ? 1 : 0;
        } catch {
            return 0;
        }
    }

    async findEmails(location: LocalResult, options: any, onProgress?: (page: Page) => Promise<void>): Promise<string[]> {
        const log = options?.logger || logger;
        log.info({ placeId: location.place_id, pagesCount: location.meta?.pages?.length }, '[ScrapelessEmailScraper] Starting search');

        if (!location.meta || !location.meta.pages) {
            log.warn({ placeId: location.place_id }, '[ScrapelessEmailScraper] No pages to search');
            return [];
        }

        const emails: Set<string> = new Set();
        const t0 = Date.now();
        const abortAfter = options.abortAfter || 1;
        const maxPages = options.maxPages || 15;
        const checkCancelled = options.checkCancelled;

        // Sort pages — contact pages first, but always include the homepage
        const allPages = [...location.meta.pages];
        const homepageUrl = location.website?.replace(/\/+$/, '') || '';
        const isHomepage = (url: string) => {
            try { return new URL(url).pathname.replace(/\/+$/, '') === ''; } catch { return false; }
        };
        // Separate homepage from the rest, sort rest by contact score
        const homepage = allPages.find(p => isHomepage(p.url));
        const rest = allPages
            .filter(p => !isHomepage(p.url))
            .sort((a: Page, b: Page) => this.contactScore(b.url) - this.contactScore(a.url))
            .slice(0, homepage ? maxPages - 1 : maxPages);
        const pagesToSearch = homepage ? [homepage, ...rest] : rest;

        log.info({
            pageOrder: pagesToSearch.map((p: Page) => ({ url: p.url, score: this.contactScore(p.url) })),
        }, '[ScrapelessEmailScraper] Page order');

        // ─── Phase 1: Axios-first pass (fast HTTP GET, no JS rendering) ───
        const axiosTimeout = options.axiosTimeout || 5000;
        const pagesNeedingBrowser: Page[] = [];

        for (let idx = 0; idx < pagesToSearch.length; idx++) {
            const page = pagesToSearch[idx];

            if (emails.size >= abortAfter) {
                log.info({ idx, url: page.url }, '[ScrapelessEmailScraper] Abort — enough emails from axios');
                break;
            }
            if (checkCancelled && await checkCancelled()) break;

            page.status = 'SEARCHING_EMAIL';
            (page as any).method = 'axios';
            if (onProgress) await onProgress(page);

            const pt0 = Date.now();
            try {
                const resp = await axios.get(page.url, {
                    timeout: axiosTimeout,
                    responseType: 'text',
                    validateStatus: () => true,
                    httpsAgent: new https.Agent({ rejectUnauthorized: false }),
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                    },
                    maxRedirects: 5,
                });
                (page as any).httpStatus = resp.status;
                const body = typeof resp.data === 'string' ? resp.data : String(resp.data || '');
                (page as any).bodyContent = body;
                const pageEmails = this.extractEmails(body);
                (page as any).emails = pageEmails;

                log.info({ idx, url: page.url, method: 'axios', httpStatus: resp.status, found: pageEmails.length, pageMs: Date.now() - pt0 }, '[ScrapelessEmailScraper] axios → done');

                if (pageEmails.length > 0) {
                    pageEmails.forEach(e => emails.add(e));
                    // Keep scraperLocation.emails in sync so timeout can capture partial results
                    location.emails = Array.from(emails);
                    page.status = 'SEARCHED_EMAIL';
                } else {
                    // No emails via axios — queue for Scrapeless (might need JS)
                    page.status = 'AXIOS_NO_EMAIL';
                    pagesNeedingBrowser.push(page);
                }
            } catch (err: any) {
                log.warn({ idx, url: page.url, method: 'axios', err: err.message, pageMs: Date.now() - pt0 }, '[ScrapelessEmailScraper] axios → FAILED');
                page.status = 'AXIOS_FAILED';
                (page as any).error = err.message;
                pagesNeedingBrowser.push(page);
            } finally {
                if (onProgress) await onProgress(page);
            }
        }

        log.info({
            axiosMs: Date.now() - t0,
            emailsFromAxios: emails.size,
            pagesNeedingBrowser: pagesNeedingBrowser.length,
        }, '[ScrapelessEmailScraper] Axios phase complete');

        // ─── Phase 2: Scrapeless browser for remaining pages (if needed) ───
        if (emails.size < abortAfter && pagesNeedingBrowser.length > 0) {
            const config = CONFIG_DEFAULT() as any;
            const SCRAPELESS_KEY = config.scrapeless ? config.scrapeless.key : process.env.SCRAPELESS_KEY;

            if (!SCRAPELESS_KEY) {
                log.warn('[ScrapelessEmailScraper] No Scrapeless key — skipping REST API phase');
            } else {
                const pageTimeout = options.pageTimeout || 15000;

                for (let idx = 0; idx < pagesNeedingBrowser.length; idx++) {
                    const page = pagesNeedingBrowser[idx];

                    if (emails.size >= abortAfter) {
                        log.info({ idx, url: page.url }, '[ScrapelessEmailScraper] Abort — enough emails');
                        break;
                    }
                    if (checkCancelled && await checkCancelled()) break;

                    page.status = 'SEARCHING_EMAIL';
                    (page as any).method = 'scrapeless_rest';
                    if (onProgress) await onProgress(page);

                    const pt0 = Date.now();
                    try {
                        log.info({ idx, url: page.url }, '[ScrapelessEmailScraper] Requesting Scrapeless Web Unlocker...');
                        const response = await axios.post('https://api.scrapeless.com/api/v2/unlocker/request', {
                            actor: "unlocker.webunlocker",
                            input: {
                                url: page.url,
                                jsRender: {
                                    enabled: true,
                                    headless: true
                                }
                            }
                        }, {
                            headers: {
                                'x-api-token': SCRAPELESS_KEY,
                                'Content-Type': 'application/json'
                            },
                            timeout: pageTimeout + 5000 // Give API some buffer
                        });

                        (page as any).httpStatus = response.status;
                        log.info({ idx, url: page.url, method: 'scrapeless_rest', fetchMs: Date.now() - pt0, httpStatus: response.status }, '[ScrapelessEmailScraper] → loaded');

                        // Scrapeless Web Unlocker returns rendered HTML in response.data.data
                        let bodyContent = '';
                        if (response.data?.data && typeof response.data.data === 'string') {
                            bodyContent = response.data.data;
                        } else {
                            bodyContent = typeof response.data === 'string' ? response.data : JSON.stringify(response.data);
                        }
                        
                        (page as any).bodyContent = bodyContent;

                        const pageEmails = this.extractEmails(bodyContent);
                        (page as any).emails = pageEmails;
                        log.info({ idx, url: page.url, method: 'scrapeless_rest', found: pageEmails.length, emails: pageEmails, pageMs: Date.now() - pt0 }, '[ScrapelessEmailScraper] → done');

                        if (pageEmails.length > 0) {
                            pageEmails.forEach(e => emails.add(e));
                            // Keep scraperLocation.emails in sync
                            location.emails = Array.from(emails);
                        }
                        page.status = 'SEARCHED_EMAIL';
                    } catch (err: any) {
                        log.warn({ idx, url: page.url, method: 'scrapeless_rest', err: err.message, response: err.response?.data, pageMs: Date.now() - pt0 }, '[ScrapelessEmailScraper] → FAILED');
                        page.status = 'FAILED';
                        (page as any).error = err.message;
                    } finally {
                        if (onProgress) await onProgress(page);
                    }
                }
            }
        }

        log.info({ totalMs: Date.now() - t0, emailsTotal: emails.size }, '[ScrapelessEmailScraper] Done');
        return Array.from(emails);
    }

    private extractEmails(text: string): string[] {
        const seen = new Set<string>();
        const results: string[] = [];

        const addEmail = (email: string) => {
            const lower = email.toLowerCase().trim();
            if (!lower) return;
            if (this.IMAGE_EXTENSIONS.some(ext => lower.endsWith(ext))) return;
            if (seen.has(lower)) return;
            // Basic sanity: must have @ and at least one dot after @
            if (!lower.includes('@') || !lower.split('@')[1]?.includes('.')) return;
            seen.add(lower);
            results.push(email.trim());
        };

        // 1. Standard email regex
        const matches = text.match(this.EMAIL_REGEX);
        if (matches) {
            for (const m of matches) addEmail(m);
        }

        // 2. ROT13 encoded emails (WordPress Email Encoder / EEB plugin)
        //    Pattern: data-enc-email="vasb[at]cynfgvpbfyyberaf.pbz"
        const rot13Pattern = /data-enc-email="([^"]+)"/gi;
        let rot13Match;
        while ((rot13Match = rot13Pattern.exec(text)) !== null) {
            const decoded = rot13Match[1]
                .replace(/\[at\]/gi, '@')
                .replace(/\[dot\]/gi, '.')
                .replace(/[a-zA-Z]/g, (c) => {
                    const base = c <= 'Z' ? 65 : 97;
                    return String.fromCharCode(((c.charCodeAt(0) - base + 13) % 26) + base);
                });
            addEmail(decoded);
        }

        // 3. [at] / [dot] / (at) / (dot) substitutions in visible text
        const atDotPattern = /[a-zA-Z0-9._%+-]+\s*[\[(]\s*at\s*[\])]\s*[a-zA-Z0-9.-]+\s*[\[(]\s*dot\s*[\])]\s*[a-zA-Z]{2,}/gi;
        const atDotMatches = text.match(atDotPattern);
        if (atDotMatches) {
            for (const m of atDotMatches) {
                const cleaned = m
                    .replace(/\s*[\[(]\s*at\s*[\])]\s*/gi, '@')
                    .replace(/\s*[\[(]\s*dot\s*[\])]\s*/gi, '.');
                addEmail(cleaned);
            }
        }

        return results;
    }
}
