import { PlaceFull } from '@polymech/shared';
import { IEnricher, EnrichmentContext } from './registry.js';
import axios, { AxiosRequestConfig } from 'axios';
import * as cheerio from 'cheerio';
import { URL } from 'url';
import puppeteer from 'puppeteer';
import { Puppeteer } from '@scrapeless-ai/sdk';
import { CONFIG_DEFAULT } from '@polymech/commons';
import puppeteerExtra from 'puppeteer-extra';
import https from 'https';
import { logger } from '@/commons/logger.js';
import TurndownService from 'turndown';

const _td = new TurndownService({ headingStyle: 'atx', bulletListMarker: '-' });
// Remove noise elements before conversion
_td.remove(['script', 'style', 'noscript', 'svg', 'iframe', 'head'] as any[]);

/** Convert HTML → clean markdown. Removes JS/CSS/SVG noise. Passes plain text through. */
function htmlToText(raw: string | undefined): string | undefined {
    if (!raw) return undefined;
    if (!/<[a-zA-Z]/.test(raw)) return raw;
    try { return _td.turndown(raw); } catch { return raw; }
}


const puppeteerExtraAny = puppeteerExtra as any;

interface Og {
    [key: string]: string | undefined;
}

interface Meta {
    [key: string]: string | undefined;
}

interface Image {
    src: string;
}

interface PageType {
    url: string;
    source: string;
    status: string;
}

interface Structured {
    [key: string]: any;
}

interface LocationSiteMeta {
    title?: string;
    description?: string;
    image?: string;
    url?: string;
    social?: PageType[];
    seo?: {
        keywords?: string[];
        structured?: Structured[];
        og?: Og;
        metaTags?: Meta;
    };
    pages?: PageType[];
    externalLinks?: PageType[];
    images?: Image[];
    emails?: EmailFound[];
    bodyText?: string;
    bodyHtml?: string;
    httpStatus?: number;
    fetchError?: string;
}

interface EmailFound {
    email: string;
    source: string;
    foundAt: string;
    tool: string;
}

export class MetaEnricher implements IEnricher {
    name = 'meta';
    type = 'meta';

    async enrich(location: PlaceFull, context: EnrichmentContext): Promise<Partial<PlaceFull>> {
        if (!context.logger) {
            context.logger = logger;
        }
        if (!location.website) {
            if (context.logger) context.logger.debug({ placeId: location.place_id }, 'No website to enrich');
            return {};
        }

        try {
            // Check if already enriched
            if (!context.forceRefresh && location.raw_data?.meta?.title) {
                if (context.logger) context.logger.info({ website: location.website }, 'Meta already present, skipping enrichment');
                return { raw_data: { meta: location.raw_data.meta } };
            }

            if (context.logger) context.logger.info({ website: location.website }, 'Starting meta enrichment');
            const meta = await this.parseHtml(location.website, null, { headless: true }); // Default to headless puppeteer for better success rate

            const updates: Partial<PlaceFull> = {
                raw_data: {
                    ...location.raw_data,
                    meta: meta
                }
            };

            if (context.logger) {
                context.logger.info({
                    website: location.website,
                    socials: meta.social?.map(s => s.source),
                    title: meta.title ? 'Found' : 'Missing',
                    emails: meta.emails ? meta.emails.length : (meta.seo?.metaTags?.['email'] || 'None')
                }, 'Meta enrichment complete');
            }

            // Extract social links to main object if not present
            if (meta.social) {
                // We can't directly assign to unmapped fields if schema doesn't exist yet, 
                // but implementation plan said 'schemas.ts' might be updated.
                // For now, sticking to raw_data.meta is safe, but we can also return them 
                // and let the caller/schema handle it.
            }

            return updates;
        } catch (error: any) {
            if (context.logger) {
                context.logger.error(`Error enriching meta for ${location.website}: ${error.message}`);
            }
            return {}; // Return empty update on failure
        }
    }

    private isValidUrl(url: string) {
        try {
            new URL(url);
            return true;
        } catch (error) {
            return false;
        }
    }

    private readMetaTags($: cheerio.CheerioAPI, name: string) {
        return $(`meta[name="${name}"]`).attr('content') || $(`meta[property="${name}"]`).attr('content') || null;
    }

    private static browserPromise: Promise<puppeteer.Browser> | null = null;
    private static idleTimer: NodeJS.Timeout | null = null;
    private static IDLE_TIMEOUT_SECONDS = parseInt(process.env.ENRICHER_META_IDLE_TIMEOUT || '60');

    private static resetIdleTimer() {
        if (MetaEnricher.idleTimer) clearTimeout(MetaEnricher.idleTimer);
        MetaEnricher.idleTimer = setTimeout(async () => {
            if (MetaEnricher.browserPromise) {
                // context.logger.info(`[Puppeteer] Browser idle timeout (${60}s) reached` // No Logger context here, use console or ignore
                try {
                    const browser = await MetaEnricher.browserPromise;
                    await browser.close();
                } catch (e) {
                    logger.error(`Error closing browser: ${e}`);
                }
                MetaEnricher.browserPromise = null;
            }
        }, MetaEnricher.IDLE_TIMEOUT_SECONDS * 1000);
    }

    private static async getBrowser(): Promise<puppeteer.Browser> {
        MetaEnricher.resetIdleTimer();
        if (MetaEnricher.browserPromise) return MetaEnricher.browserPromise;

        logger.info(`[Puppeteer] Launching new browser`);

        const config = CONFIG_DEFAULT() as any;
        const SCRAPELESS_KEY = config.scrapeless ? config.scrapeless.key : process.env.SCRAPELESS_KEY;
        const USE_SCRAPELESS = process.env.ENRICHER_META_SCRAPER === 'SCRAPELESS' && SCRAPELESS_KEY;

        MetaEnricher.browserPromise = (async () => {
            if (USE_SCRAPELESS) {
                logger.info(`[Puppeteer] Connecting to Scrapeless`);
                try {
                    return await Puppeteer.connect({
                        apiKey: SCRAPELESS_KEY,
                        sessionName: 'meta_enricher',
                        sessionTTL: 3600,
                        sessionRecording: false,
                        defaultViewport: null
                    }) as any;
                } catch (e) {
                    logger.error(`[Puppeteer] Failed to connect to Scrapeless, falling back to local: ${e}`);
                }
            }

            const browser = await puppeteerExtraAny.launch({
                headless: "new",
                args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
            });
            return browser;
        })();

        return MetaEnricher.browserPromise;
    }

    private async parseHtml(url: string, config: AxiosRequestConfig | null, options: any): Promise<LocationSiteMeta> {
        if (!/(^http(s?):\/\/[^\s$.?#].[^\s]*)/i.test(url)) return {} as LocationSiteMeta;

        let content = '';
        let bodyText = '';
        let httpStatus: number | undefined;
        let fetchError: string | undefined;

        if (options && options.headless) {
            try {
                const browser = await MetaEnricher.getBrowser();
                const page = await browser.newPage();
                try {
                    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

                    // Allow shorter timeout for meta tags
                    const timeout = options.timeout || 15000;

                    const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout });
                    httpStatus = response?.status?.() ?? undefined;
                    content = await page.content();
                    try {
                        bodyText = await page.evaluate(() => document.body.innerText);
                    } catch (e) {
                        // ignore
                    }
                    // Puppeteer innerText can be empty for JS-heavy SPAs — fall back to turndown
                    if (!bodyText && content) {
                        bodyText = htmlToText(content) || '';
                    }
                } finally {
                    await page.close();
                    MetaEnricher.resetIdleTimer();
                }
            } catch (e: any) {
                fetchError = e.message || String(e);
                // Fallback to axios if puppeteer fails (or specific connection/timeout error)
            }
        }

        if (!content) {
            try {
                const resp = await axios(url, {
                    ...config,
                    httpsAgent: new https.Agent({ rejectUnauthorized: false }),
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
                    },
                    timeout: 10000,
                    responseType: 'text',
                    validateStatus: () => true, // don't throw on 4xx/5xx
                });
                httpStatus = resp.status;
                content = typeof resp.data === 'string' ? resp.data : String(resp.data || '');
                // Convert full HTML to clean markdown for bodyText
                bodyText = htmlToText(content) || '';
            } catch (e: any) {
                fetchError = fetchError || e.message || String(e);
                return { httpStatus, fetchError } as LocationSiteMeta;
            }
        }

        const $ = cheerio.load(content);
        const og: Og = {};
        const meta: Meta = {};
        const images: Image[] = [];
        const links: string[] = [];
        let allLinks: string[] = [];

        // Final guardrail: if bodyText is still empty after both fetch paths,
        // use cheerio to extract visible text (strips scripts/styles properly)
        if (!bodyText) {
            $('script, style, noscript, svg, iframe').remove();
            bodyText = $('body').text().replace(/\s{2,}/g, ' ').trim();
        }

        const title = $('title').text();
        if (title) meta.title = title;

        const canonical = $('link[rel=canonical]').attr('href');
        if (canonical) meta.url = canonical;

        ['title', 'description', 'image'].forEach(s => {
            const val = this.readMetaTags($, s);
            if (val) meta[s] = val;
        });

        ['og:title', 'og:description', 'og:image', 'og:url', 'og:site_name', 'og:type'].forEach(s => {
            const val = this.readMetaTags($, s);
            if (val) og[s.split(':')[1]] = val;
        });

        $('img').each((i: number, el: any) => {
            let src = $(el).attr('src');
            if (src) {
                try {
                    src = new URL(src, url).href;
                    images.push({ src });
                } catch (e) {
                    // ignore invalid urls
                }
            }
        });

        const jsonLdArray: Structured[] = [];
        $('script[type="application/ld+json"]').each((_: number, element: any) => {
            const jsonLdContent = $(element).html();
            if (jsonLdContent) {
                try {
                    const jsonData = JSON.parse(jsonLdContent);
                    jsonLdArray.push(jsonData);
                } catch (e) {
                    // logger.error(`Error parsing JSON-LD: ${e.message} @ ${url}`);
                }
            }
        });

        $('a').each((index: number, element: any) => {
            let href = $(element).attr('href');
            if (href) {
                try {
                    href = new URL(href, url).href;

                    if (this.isValidUrl(href)) {
                        if (href.indexOf('contact') !== -1 && !links.includes(href)) {
                            links.push(href);
                        }
                        allLinks.push(href);
                    }
                } catch (e) {
                    // Ignore invalid URLs
                }
            }
        });
        allLinks = [...new Set(allLinks)];

        const socialLinks: PageType[] = [];
        const internalPages: PageType[] = [];
        const externalLinks: PageType[] = [];

        allLinks.forEach(link => {
            if (link.includes('instagram.com')) socialLinks.push({ url: link, source: 'instagram', status: 'PENDING' });
            else if (link.includes('facebook.com')) socialLinks.push({ url: link, source: 'facebook', status: 'PENDING' });
            else if (link.includes('linkedin.com')) socialLinks.push({ url: link, source: 'linkedin', status: 'PENDING' });
            else if (link.includes('youtube.com')) socialLinks.push({ url: link, source: 'youtube', status: 'PENDING' });
            else if (link.includes('twitter.com')) socialLinks.push({ url: link, source: 'twitter', status: 'PENDING' });
            else if (link.includes('mailto:')) { /* ignore mailto */ }
            else {
                try {
                    const baseUrl = new URL(url).hostname;
                    const linkUrl = new URL(link).hostname;
                    if (linkUrl === baseUrl || linkUrl.endsWith('.' + baseUrl)) {
                        internalPages.push({ url: link, source: 'site', status: 'PENDING' });
                    } else {
                        externalLinks.push({ url: link, source: 'external', status: 'PENDING' });
                    }
                } catch (e) {
                    externalLinks.push({ url: link, source: 'external', status: 'PENDING' });
                }
            }
        });

        // Email extraction
        const emailsFound: EmailFound[] = [];
        const genericEmailRegex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;

        // Asset/image extensions that look like TLDs to the regex
        const ASSET_EXTENSIONS = new Set([
            'avif', 'webp', 'png', 'jpg', 'jpeg', 'gif', 'svg', 'ico', 'bmp', 'tiff',
            'woff', 'woff2', 'ttf', 'eot', 'otf',
            'css', 'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'map',
            'json', 'xml', 'csv', 'pdf', 'zip', 'gz', 'br',
            'mp4', 'webm', 'mp3', 'wav', 'ogg',
        ]);

        const isLikelyEmail = (candidate: string): boolean => {
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

            // Local part should not be just a filename stem (e.g., 'latest', 'image', 'bg')
            if (/^\d+$/.test(local)) return false;

            return true;
        };

        let match;
        const uniqueEmails = new Set<string>();

        // Scan visible text
        while ((match = genericEmailRegex.exec(bodyText)) !== null) {
            if (isLikelyEmail(match[0])) uniqueEmails.add(match[0]);
        }
        // Scan full content (includes hidden, metatags, etc)
        if (!uniqueEmails.size) {
            while ((match = genericEmailRegex.exec(content)) !== null) {
                if (isLikelyEmail(match[0])) uniqueEmails.add(match[0]);
            }
        }

        uniqueEmails.forEach(email => {
            emailsFound.push({
                email,
                source: url,
                foundAt: new Date().toISOString(),
                tool: 'meta-enricher'
            });
        });

        return {
            title: meta.title || og.title,
            description: meta.description || og.description,
            image: meta.image || og.image,
            url: meta.url || og.url || url,
            social: socialLinks,
            seo: {
                keywords: ($('meta[property="og:keywords"]').attr("content") ||
                    $('meta[name="keywords"]').attr("content") || "").split(',').map((s: any) => s.trim()).filter((s: any) => s),
                structured: jsonLdArray,
                og,
                metaTags: meta
            },
            pages: internalPages,
            externalLinks: externalLinks,
            images,
            emails: emailsFound,
            bodyText: htmlToText(bodyText) || undefined,
            bodyHtml: content || undefined,
            httpStatus,
            fetchError,
        };
    }
}
