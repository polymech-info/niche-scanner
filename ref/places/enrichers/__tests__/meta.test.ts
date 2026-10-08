import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MetaEnricher } from '../meta.js';

// Mock axios and puppeteer if necessary, but for basic unit testing we might just want to 
// check the interface or mock the private methods if we could.
// Since parseHtml is private, we test enrich().

describe('MetaEnricher', () => {
    let enricher: MetaEnricher;

    beforeEach(() => {
        enricher = new MetaEnricher();
    });

    it('should have correct name and type', () => {
        expect(enricher.name).toBe('meta');
        expect(enricher.type).toBe('meta');
    });

    it('should return empty object if no website', async () => {
        const result = await enricher.enrich({ place_id: '1', title: 'test' } as any, { userId: 'u1' });
        expect(result).toEqual({});
    });

    // Deeper testing requires mocking parseHtml logic which uses external libs.
    // For this scope, ensuring it handles basic input covers the wiring.
});
