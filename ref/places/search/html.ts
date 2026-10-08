import https from 'https'

import axios, { AxiosRequestConfig } from "axios"
import * as cheerio from "cheerio"
import * as path from 'path'
import { URL } from 'url'

import { Browser, Page } from 'puppeteer'
import puppeteerExtra from 'puppeteer-extra'
import StealthPlugin from 'puppeteer-extra-plugin-stealth'

const puppeteerExtraAny = puppeteerExtra as any
puppeteerExtraAny.use(StealthPlugin())

import { getLogger } from './context.js'
const log = () => getLogger()
import { LocalResult, LocationSiteMeta, Meta, Og, Image, Structured, Page as PageType } from './map_types.js'

export const STATS_SUFFIX = '_stats.json'
export const SESSION_EVENTS_SUFFIX = '_session.json'
export const TRACE_SUFFIX = '_trace.json'
export var scope: Scope

let instance: Scope
const debugResponses = false

//process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

export const extractEmail = (input: string): string | null => {
    const emailRegex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/;
    const match = input.match(emailRegex);
    return match ? match[0] : null;
}

export const meta = async (loc: LocalResult, options: any): Promise<LocationSiteMeta | void> => {
    if (!loc.website) {
        log().warn(`No website to retrieve meta data : ${loc.title}`)
        return
    }
    if (loc.meta) {
        return
    }
    try {
        const _meta: LocationSiteMeta = await parseHtml(loc.website, null, options) || {}
        loc.meta = _meta

        if (_meta.social) {
            loc.instagram = _meta.social.find(p => p.source === 'instagram')?.url
            loc.facebook = _meta.social.find(p => p.source === 'facebook')?.url
            loc.youtube = _meta.social.find(p => p.source === 'youtube')?.url
            loc.linkedin = _meta.social.find(p => p.source === 'linkedin')?.url
            loc.twitter = _meta.social.find(p => p.source === 'twitter')?.url
        }
        return _meta
    } catch (error: any) {
        log().error('Error retrieving meta data : ' + loc.website, error.message)
        if (error.status)
            loc.rejected = error.status === 404 || error.status === 403 || error.status === 999 || error.status === 503
    }
}

export const isValidUrl = (url: string) => {
    try {
        new URL(url);
        return true;
    } catch (error) {
        return false;
    }
}

const readMetaTags = ($: cheerio.CheerioAPI, name: string) => {
    return $(`meta[name="${name}"]`).attr('content') || $(`meta[property="${name}"]`).attr('content') || null;
};

export const parseHtml = async (url: string, config: AxiosRequestConfig | null, options: any): Promise<LocationSiteMeta> => {

    if (!/(^http(s?):\/\/[^\s$.?#].[^\s]*)/i.test(url)) return {} as LocationSiteMeta;

    let content = '';
    let currentUrl = url;

    if (options && options.headless) {
        try {
            const browser = await puppeteerExtraAny.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
            const page = await browser.newPage();
            await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
            await page.goto(url, { waitUntil: 'networkidle2', timeout: options.timeout || 30000 });
            content = await page.content();
            currentUrl = page.url();
            await browser.close();
        } catch (e: any) {
            log().error(`Puppeteer failed for ${url}: ${e.message}`);
        }
    }

    if (!content) {
        try {
            const { data } = await axios(url, {
                ...config,
                httpsAgent: new https.Agent({ rejectUnauthorized: false }),
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
                },
                timeout: 10000
            });
            content = data;
        } catch (e: any) {
            log().error(`Axios failed for ${url}: ${e.message}`);
            return {} as LocationSiteMeta;
        }
    }

    const $ = cheerio.load(content)
    const og: Og = {}
    const meta: Meta = {}
    const images: Image[] = []
    const links: string[] = []
    let allLinks: string[] = []

    const title = $('title').text()
    if (title)
        meta.title = title;

    const canonical = $('link[rel=canonical]').attr('href')
    if (canonical) {
        meta.url = canonical
    }

    ['title', 'description', 'image'].forEach(s => {
        const val = readMetaTags($, s);
        if (val) meta[s] = val;
    });

    ['og:title', 'og:description', 'og:image', 'og:url', 'og:site_name', 'og:type'].forEach(s => {
        const val = readMetaTags($, s);
        if (val) og[s.split(':')[1]] = val;
    })

    $('img').each((i, el) => {
        let src = $(el).attr('src')
        if (src) {
            try {
                src = new URL(src, url).href;
                images.push({ src });
            } catch (e) {
                // ignore invalid urls
            }
        }
    })

    const jsonLdArray: Structured[] = [];
    $('script[type="application/ld+json"]').each((_, element) => {
        const jsonLdContent = $(element).html();
        if (jsonLdContent) {
            try {
                const jsonData = JSON.parse(jsonLdContent);
                jsonLdArray.push(jsonData);
            } catch (e: any) {
                log().error(`Error parsing JSON-LD: ${e.message} @ ${url}`);
            }
        }
    })
    $('a').each((index, element) => {
        let href = $(element).attr('href')
        if (href) {
            try {
                href = new URL(href, url).href;

                if (isValidUrl(href)) {
                    if (href.indexOf('contact') !== -1 && !links.includes(href)) {
                        links.push(href)
                    }
                    allLinks.push(href)
                }
            } catch (e) {
                // Ignore invalid URLs
            }
        }
    })
    allLinks = [...new Set(allLinks)]

    const socialLinks: PageType[] = []
    const internalPages: PageType[] = []
    const externalLinks: PageType[] = []

    allLinks.forEach(link => {
        if (link.includes('instagram.com')) socialLinks.push({ url: link, source: 'instagram', status: 'PENDING' })
        else if (link.includes('facebook.com')) socialLinks.push({ url: link, source: 'facebook', status: 'PENDING' })
        else if (link.includes('linkedin.com')) socialLinks.push({ url: link, source: 'linkedin', status: 'PENDING' })
        else if (link.includes('youtube.com')) socialLinks.push({ url: link, source: 'youtube', status: 'PENDING' })
        else if (link.includes('twitter.com')) socialLinks.push({ url: link, source: 'twitter', status: 'PENDING' })
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
    })

    const ret: LocationSiteMeta = {
        title: meta.title || og.title,
        description: meta.description || og.description,
        image: meta.image || og.image,
        url: meta.url || og.url || url,

        social: socialLinks,

        seo: {
            keywords: ($('meta[property="og:keywords"]').attr("content") ||
                $('meta[name="keywords"]').attr("content") || "").split(',').map(s => s.trim()).filter(s => s),
            structured: jsonLdArray,
            og,
            metaTags: meta
        },

        pages: internalPages,
        externalLinks: externalLinks,
        images
    }
    return ret
}

export const getScope = (cliArgs?: any) => {
    if (!instance) {
        instance = new Scope();
        instance.args = cliArgs;
    }
    return instance;
}

export async function capture_responses(scope: Scope, page: Page) {
    try {
        // await page.setRequestInterception(true);
    } catch (e) {
        log().error(`error intercepting responses: ${e}`);
    }
    scope.responses = [];
    page.on('response', response => {
        try {
            const isJson = (response.headers()['content-type'] || '').startsWith('application/json;') === true;
            const url = response.url();

            if (response.status() === 200) {
                if (isJson) {
                    // capture_response(scope.responses, response as any);
                }
                if (scope.onResponse) {
                    scope.onResponse(response, scope);
                }
            } else {
                debugResponses && log().error(`Error loading ${url} : ${response.status()}`);
            }
        } catch (e) {
            debugResponses && log().error('Error parsing response');
        }
    });
}

export class Scope {
    browser!: Browser
    context!: any
    page!: Page
    args!: any;
    requests: any[] = []
    responses: any[] = []
    eventBeacons: any[] = []
    mutationBeacons: any[] = []
    sessionSuffix: string = ''
    onResponse: any
    onRequest: any
    async init() {
        this.sessionSuffix = ' - ' + new Date().getTime();
        const args = [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-infobars',
            '--window-position=0,0',
            '--ignore-certifcate-errors',
            '--ignore-certifcate-errors-spki-list',
            '--user-agent="Mozilla/5.0 (Macintosh; Intel Mac OS X 10_12_6) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/65.0.3312.0 Safari/537.36"',
            `--user-data-dir=${path.resolve('../chrome')}`
        ];

        this.browser = await puppeteerExtraAny.launch({
            ... this.args,
            args: args
        });
        this.page = await this.browser.newPage();

        this.page.on('console', msg => {
            // error('Browser error:', msg);
        });
        this.page.on('error', msg => log().error(`Browser Error: ${msg}`));
        this.page.on('pageerror', msg => log().error(`Browser Page Error: ${msg}`));
        this.page.on('requestfailed', msg => log().error(`Browser Page Request Error: ${msg}`));

        const page2 = this.page as any;
    }
}

export const body = async (url: string) => {
    const options = {
        headless: true,
        url: url
    }
    let timeout = 8000

    if (!scope) {
        try {
            scope = await getScope(options)
            await scope.init()
        } catch (e) {
            debugger;
            log().error(`Invalid scope - abort: ${e}`);
            return;
        }
        scope.page.on("pageerror", function (err) {
            log().error(`page-error! ${err}`);
        })
        scope.page.on("error", function (err) {
            log().error(`brower-error! ${err}`);
        })
        scope.page.on('console', msg => {
            if ((msg as any)._type === 'error') {
                log().error(`Browser error: ${msg}`);
                (scope.page as any).isError = true;
            }
        })
    }

    const parse = (resolve: any) => {
        scope.page.content().then((c) => {
            if (!c) {
                log().error(`error user page ${url}`)
                resolve(null);
                return;
            }
            const $ = cheerio.load(c as string, {
                xmlMode: true
            })
            const links: string[] = []
            $('a').each((index, element) => {
                const href = $(element).attr('href');
                if (href && href.indexOf('contact') !== -1) {
                    links.push(href)
                }
            })
            resolve({ html: c, text: $('body').text(), links })
        })
    }
    return new Promise((resolve) => {
        scope.page.goto(url, {
            timeout: timeout,
            waitUntil: 'networkidle0'
        }).then((v) => {
            parse(resolve)
        }).catch((e) => {
            log().error(`error loading page: ${e}`)
        })
    })
}
