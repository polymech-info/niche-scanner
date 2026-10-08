import { describe, it, expect } from 'vitest';
import { EnricherRegistry, IEnricher, EnrichmentContext } from '../registry.js';
import { PlaceFull } from '@polymech/shared';

class MockEnricher implements IEnricher {
    name = 'mock';
    type = 'test';
    async enrich(location: PlaceFull, context: EnrichmentContext) {
        return { title: 'enriched' };
    }
}

describe('EnricherRegistry', () => {
    // Clear registry before each test if possible, but map is static.
    // We can rely on unique names or just testing existence.

    it('should register and retrieve an enricher', () => {
        const enricher = new MockEnricher();
        EnricherRegistry.register('test-mock', enricher);

        expect(EnricherRegistry.get('test-mock')).toBe(enricher);
    });

    it('should return undefined for unknown enricher', () => {
        expect(EnricherRegistry.get('unknown')).toBeUndefined();
    });

    it('should list all enrichers', () => {
        const initialCount = EnricherRegistry.getAll().length;
        EnricherRegistry.register('test-mock-2', new MockEnricher());
        expect(EnricherRegistry.getAll().length).toBeGreaterThanOrEqual(1);
    });
});
