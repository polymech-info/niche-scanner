import type {
  launch,
  WaitForOptions,
  Page,
  Browser,
} from "puppeteer"
import puppeteer from 'puppeteer';

// --- Lightweight stubs replacing langchain ---
class Document {
  pageContent: string
  metadata: Record<string, any>
  constructor(fields: { pageContent: string; metadata: Record<string, any> }) {
    this.pageContent = fields.pageContent
    this.metadata = fields.metadata
  }
}
abstract class BaseDocumentLoader {
  abstract load(): Promise<Document[]>
}
type DocumentLoader = BaseDocumentLoader
import pLimit from "p-limit"
export { Page, Browser }

export type PuppeteerGotoOptions = WaitForOptions & {
  referer?: string;
  referrerPolicy?: string;
};

/**
 * Type representing a function for evaluating JavaScript code on a web
 * page using Puppeteer. It takes a Page and Browser object as parameters
 * and returns a Promise that resolves to a string.
 */
export type PuppeteerEvaluate = (
  page: Page,
  browser: Browser
) => Promise<string>;

export type PuppeteerWebBaseLoaderOptions = {
  launchOptions?: any;
  gotoOptions?: PuppeteerGotoOptions;
  evaluate?: PuppeteerEvaluate;
};

/**
 * Class that extends the BaseDocumentLoader class and implements the
 * DocumentLoader interface. It represents a document loader for scraping
 * web pages using Puppeteer.
 * @example
 * ```typescript
 * const loader = new PuppeteerWebBaseLoader("https:exampleurl.com", {
 *   launchOptions: {
 *     headless: true,
 *   },
 *   gotoOptions: {
 *     waitUntil: "domcontentloaded",
 *   },
 * });
 * const screenshot = await loader.screenshot();
 * ```
 */
import { getLogger } from './context.js'
const log = () => getLogger()

// Singleton browser promise to prevent race conditions
let browserPromise: Promise<Browser> | null = null;
let idleTimer: NodeJS.Timeout | null = null;
const limit = (pLimit as any)(parseInt(process.env.EMAIL_SEARCH_MAX_PUPETEER_PAGES || '10'))
const IDLE_TIMEOUT_SECONDS = parseInt(process.env.EMAIL_SEARCH_PUPETEER_IDLE_TIMEOUT_SECONDS || '60');

const resetIdleTimer = () => {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(async () => {
    if (browserPromise) {
      log().info(`[Puppeteer] Browser idle timeout (${IDLE_TIMEOUT_SECONDS}s) reached, closing browser`);
      const browser = await browserPromise;
      await browser.close();
      browserPromise = null;
    }
  }, IDLE_TIMEOUT_SECONDS * 1000);
}

const launchBrowser = async (options?: PuppeteerWebBaseLoaderOptions): Promise<Browser> => {
  resetIdleTimer();
  if (browserPromise) return browserPromise;

  log().info('[Puppeteer] Launching browser...');
  browserPromise = (async () => {
    try {
      // Static import used above
      log().debug('[Puppeteer] Imports resolved. Starting launch...');
      const { launch } = puppeteer;

      const headlessEnv = process.env.EMAIL_SEARCH_HEADLESS;
      // Use 'new' for headless:true to avoid deprecation warning. Respect 'false' for debugging.
      const headlessMode = headlessEnv === 'false' ? false : 'new';

      // Wrap launch in a timeout to prevent infinite hangs
      const launchPromise = launch({
        headless: headlessMode as any, // Use user config or default to 'new'
        defaultViewport: null,
        args: ['--no-sandbox', '--disable-setuid-sandbox'], // CRITICAL: Prevent OS-level hangs
        ignoreDefaultArgs: ["--disable-extensions"],
        ...options?.launchOptions,
      });

      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Browser Launch Timeout (30s)')), 30000)
      );

      const b = await Promise.race([launchPromise, timeoutPromise]);

      log().info('[Puppeteer] Browser launched successfully');
      return b;
    } catch (e) {
      log().error(`[Puppeteer] Failed to launch browser: ${e}`);
      browserPromise = null; // CRITICAL: Reset promise so next attempt can retry
      throw e;
    }
  })();

  return browserPromise;
}

export const getBrowser = () => browserPromise;
export const getPage = async (browser: Browser) => {
  // Always create a new page for concurrency
  log().debug('[Puppeteer] Creating new page');
  const page = await browser.newPage()
  log().debug('[Puppeteer] New page created');
  return page
}

export class PuppeteerWebBaseLoader
  extends BaseDocumentLoader
  implements DocumentLoader {
  options: PuppeteerWebBaseLoaderOptions | undefined;

  constructor(public webPath: string, options?: PuppeteerWebBaseLoaderOptions) {
    super();
    this.options = options ?? undefined;
  }

  static browser: Browser;

  static async _scrape(
    url: string,
    options?: PuppeteerWebBaseLoaderOptions
  ): Promise<string> {

    const browser = await launchBrowser(options)

    // PuppeteerWebBaseLoader.browser = browser // Static property usage is deprecated/incorrect with this pattern

    return limit(async () => {
      log().debug(`[Puppeteer] Entering limit (Active: ${limit.activeCount}, Pending: ${limit.pendingCount}) for ${url}`);
      try {
        const page = await getPage(browser)
        try {
          log().debug(`[Puppeteer] Navigating to ${url}`);
          await page.goto(url, {
            timeout: 5000,
            waitUntil: "domcontentloaded",
            ...options?.gotoOptions,
          });
          log().debug(`[Puppeteer] Navigated to ${url}, evaluating...`);

          const bodyHTML = options?.evaluate
            ? await options?.evaluate(page, browser)
            : await page.evaluate(() => document.body.innerHTML);

          log().debug(`[Puppeteer] Evaluated ${url}`);
          return bodyHTML
        } finally {
          await page.close()
        }
      } finally {
        log().debug(`[Puppeteer] Exiting limit (Active: ${limit.activeCount}, Pending: ${limit.pendingCount}) for ${url}`);
        resetIdleTimer();
      }
    })
  }

  /**
   * Method that calls the _scrape method to perform the scraping of the web
   * page specified by the webPath property.
   * @returns Promise that resolves to the scraped HTML content of the web page.
   */
  async scrape(): Promise<string> {
    return PuppeteerWebBaseLoader._scrape(this.webPath, this.options);
  }

  /**
   * Method that calls the scrape method and returns the scraped HTML
   * content as a Document object.
   * @returns Promise that resolves to an array of Document objects.
   */
  async load(): Promise<Document[]> {
    const text = await this.scrape();

    const metadata = { source: this.webPath };
    return [new Document({ pageContent: text, metadata })];
  }

  /**
   * Static class method used to screenshot a web page and return
   * it as a {@link Document} object where  the pageContent property
   * is the screenshot encoded in base64.
   *
   * @param {string} url
   * @param {PuppeteerWebBaseLoaderOptions} options
   * @returns {Document} A document object containing the screenshot of the page encoded in base64.
   */
  static async _screenshot(
    url: string,
    options?: PuppeteerWebBaseLoaderOptions
  ): Promise<Document> {
    const { launch } = puppeteer;

    const browser = await launch({
      headless: "new",
      defaultViewport: null,
      args: ["--no-screenshot"],
      ignoreDefaultArgs: ["--disable-extensions"],
      ...options?.launchOptions,
    });
    const page = await browser.newPage();

    await page.goto(url, {
      timeout: 180000,
      waitUntil: "domcontentloaded",
      ...options?.gotoOptions,
    });
    const screenshot = await page.screenshot();
    const base64 = screenshot.toString();
    const metadata = { source: url };
    return new Document({ pageContent: base64, metadata });
  }

  /**
   * Screenshot a web page and return it as a {@link Document} object where
   * the pageContent property is the screenshot encoded in base64.
   *
   * @returns {Promise<Document>} A document object containing the screenshot of the page encoded in base64.
   */
  async screenshot(): Promise<Document> {
    return PuppeteerWebBaseLoader._screenshot(this.webPath, this.options);
  }


}