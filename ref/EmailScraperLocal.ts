
import { IEmailScraper } from './EmailScraper.js';
import { LocalResult, Page, findEmailEach } from '@polymech/search';
import { logger } from '@/commons/logger.js';

export class LocalEmailScraper implements IEmailScraper {
    async findEmails(location: LocalResult, options: any, onProgress?: (page: Page) => Promise<void>): Promise<string[]> {
        logger.info(`[LocalEmailScraper] Starting search for ${location.place_id}`);
        // We delegate to the existing findEmailEach from @polymech/search
        // options should match what findEmailEach expects
        return findEmailEach(location, options, onProgress);
    }
}
