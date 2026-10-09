
import { LocalResult, Page } from './search/map_types.js';

export interface IEmailScraper {
    findEmails(location: LocalResult, options: any, onProgress?: (page: Page) => Promise<void>): Promise<string[]>;
}

export class EmailScraperRegistry {
    private static scrapers: Map<string, IEmailScraper> = new Map();

    static register(name: string, scraper: IEmailScraper) {
        this.scrapers.set(name, scraper);
    }

    static get(name: string): IEmailScraper | undefined {
        return this.scrapers.get(name);
    }
}
