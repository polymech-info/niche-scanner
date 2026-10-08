import { getLogger } from './context.js'
const log = () => getLogger()
import pMap from 'p-map'
import { htmlToText } from "html-to-text"
import { LocalResult, Page } from './map_types.js'
import { isValidUrl } from './html.js'

const emailRegex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g
const mailtoRegex = /^mailto:([^\s@]+@[^\s@]+\.[^\s@]+)$/i

import { PuppeteerWebBaseLoader as loader, getBrowser } from './pupeteer.js'

// --- Lightweight stubs replacing langchain ---
interface DocChunk {
    pageContent: string
    metadata: Record<string, any>
}

/** Split HTML docs into plain-text chunks (replaces RecursiveCharacterTextSplitter + HtmlToTextTransformer) */
function splitAndTransform(docs: DocChunk[], chunkSize = 4000, chunkOverlap = 200): DocChunk[] {
    const result: DocChunk[] = []
    for (const doc of docs) {
        const text = htmlToText(doc.pageContent, {})
        if (text.length <= chunkSize) {
            result.push({ pageContent: text, metadata: { ...doc.metadata } })
            continue
        }
        for (let i = 0; i < text.length; i += chunkSize - chunkOverlap) {
            result.push({
                pageContent: text.slice(i, i + chunkSize),
                metadata: { ...doc.metadata },
            })
        }
    }
    return result
}


export const puppeteerLoader = async (url: string, headless: boolean, location: LocalResult, checkCancelled?: () => Promise<boolean>) => {
    if (isValidUrl(url) === false || url.indexOf('mailto') !== -1) {
        return []
    }

    if (checkCancelled && await checkCancelled()) {
        log().info('Cancelled before loading ' + url);
        return [];
    }

    let loaderWithOptions
    try {        // Function to detect a valid URL
        loaderWithOptions = new loader(
            url,
            {
                launchOptions: {
                    headless,
                    ignoreHTTPSErrors: true
                },

                gotoOptions: {
                    timeout: location.pageTimeout || 15000,
                    waitUntil: "networkidle0",
                },
                async evaluate(page, browser) {
                    if (checkCancelled && await checkCancelled()) {
                        const pid = browser.process()?.pid;
                        log().warn(`Cancellation requested inside evaluate for process ${pid}`);
                        // Do not close browser, it is shared. Page will be closed by finally block in pupeteer.ts
                        throw new Error('CancelledByUser');
                    }
                    const result = await page.evaluate(() => document.body.innerHTML)
                    // await browser.close()
                    return result
                }
            }
        )
        // Race load against cancellation
        let isFinished = false;
        const loadPromise = loaderWithOptions.load().finally(() => {
            isFinished = true;
        });

        const cancelPromise = new Promise<never>(async (_, reject) => {
            if (!checkCancelled) return;
            // Poll for cancellation
            while (!isFinished) {
                await new Promise(r => setTimeout(r, 1000));
                if (await checkCancelled()) {
                    const browser = await getBrowser();
                    if (browser) {
                        const pid = browser.process()?.pid;
                        log().info(`Cancellation confirmed for process ${pid}`);
                    }

                    reject(new Error('CancelledByUser'));
                    break;
                }
            }
        });

        const docs = await Promise.race([loadPromise, cancelPromise]);
        const ret = splitAndTransform(docs as DocChunk[])
        return ret
    } catch (error) {
        if (error instanceof Error && error.message === 'CancelledByUser') {
            throw error;
        }
        log().warn('Error loading page: ' + url + ' - ' + (error instanceof Error ? error.message : String(error)))
        location.rejected = true
        // loader.browser && loader.browser.close()

        return []
    }
}
const extractEmailAddresses = (text: string): string[] => {
    const lines = text.split(/\r?\n/)
    const emailAddresses: string[] = []
    const imageExtensions = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp', '.ico', '.tiff', '.avif'];

    for (const line of lines) {
        const matches = line.match(emailRegex)
        if (matches) {
            for (const match of matches) {
                // Filter out image filenames often found in srcset (e.g. image@2x.png)
                const lowerMatch = match.toLowerCase();
                const isImage = imageExtensions.some(ext => lowerMatch.endsWith(ext));
                if (!isImage) {
                    emailAddresses.push(match);
                }
            }
        }
    }
    return emailAddresses
}

export const findEMail = async (question: string, url: string, opts: { headless?: boolean, searchFrom?: string, [key: string]: any }, location: LocalResult) => {
    // for some weird reason only the user knows :)
    if (url.match(emailRegex) || url.match(mailtoRegex) || url.indexOf('mailto') !== -1) {
        log().warn('Email found in URL: ' + url)
        return false
    }
    let pageUrl = url
    let docs = await puppeteerLoader(pageUrl, opts.headless ?? false, { ...location, pageTimeout: opts.pageTimeout }, opts.checkCancelled) as any
    let emails: string[] = []
    docs.forEach((d: any) => {
        if (d.pageContent && d.pageContent.indexOf('@') !== -1) {
            const mails = extractEmailAddresses(d.pageContent)
            if (mails) {
                emails.push(...mails)
            }
        }
    })
    emails = [...new Set(emails)]
    location.emails = emails
    if (emails.length) {
        location.email = emails[0]
    }
    location.email && log().debug(`Found email for ${url} / ${location.title} : ${location.type} : ${location.email} : ${opts.searchFrom}`)
    return emails
}


export const findEmailEach = async (location: LocalResult, opts: { headless?: boolean, searchFrom?: string, abortAfter?: number, checkCancelled?: () => Promise<boolean>, [key: string]: any }, onProgress?: (page: Page) => Promise<void>) => {
    if (!location.meta || !location.meta.pages) {
        return []
    }

    const emails: string[] = []
    const abortAfter = opts.abortAfter ?? 1

    const concurrency = opts.concurrency || 2
    const maxPages = opts.maxPages || 15
    const contactKeywords = ['contact', 'kontakt', 'contacto', 'contatto', 'info', 'imprint', 'impressum', 'help', 'support', 'about'];

    // Sort pages: prioritize contact pages
    const pagesToSearch = location.meta.pages.sort((a: any, b: any) => {
        const urlA = a.url.toLowerCase();
        const urlB = b.url.toLowerCase();

        const scoreA = contactKeywords.some(k => urlA.includes(k)) ? 1 : 0;
        const scoreB = contactKeywords.some(k => urlB.includes(k)) ? 1 : 0;

        return scoreB - scoreA; // Descending order (contact pages first)
    }).slice(0, maxPages)

    await pMap(pagesToSearch, async (page: Page) => {
        log().debug(`[findEmailEach] Processing page: ${page.url}`);
        if (opts.checkCancelled && await opts.checkCancelled()) {
            log().info(`[findEmailEach] Cancellation requested for ${location.title}`);
            return
        }
        if (emails.length >= abortAfter) {
            return
        }

        if (page.status !== 'PENDING') {
            return
        }

        page.status = 'SEARCHING_EMAIL'
        try {
            const pageEmails = await findEMail('find email', page.url, opts, location)
            if (pageEmails && Array.isArray(pageEmails)) {
                emails.push(...pageEmails)
            }
            page.status = 'SEARCHED_EMAIL'
            log().debug(`[findEmailEach] Finished page: ${page.url}`);
        } catch (error: any) {
            if (error.message === 'CancelledByUser') {
                throw error;
            }
            page.status = 'FAILED'
            page.error = error.message
            log().error(`Error scraping email from ${page.url}: ${error?.message || error}`)
        }

        if (onProgress) {
            log().info(`[findEmailEach] Progress for ${location.title}`);
            await onProgress(page)
        }
    }, { concurrency, stopOnError: false })

    // Update location emails
    if (emails.length > 0) {
        const uniqueEmails = [...new Set([...(location.emails || []), ...emails])]
        location.emails = uniqueEmails
        if (uniqueEmails.length > 0) {
            location.email = uniqueEmails[0]
        }
    }

    return emails
}
