import { z } from '@hono/zod-openapi';
import { createRouteBody } from '@/commons/routes.js'

const tags = ['Places'];

export const RequestSchema = z.object({
    query: z.string().default(''),
    location: z.string().optional().default('barcelona, spain'),
    refresh: z.string().optional().default('false'),
    filterCountry: z.string().optional(),
    filterCity: z.string().optional(),
    filterContinent: z.string().optional(),
    filterType: z.string().optional(),
    limit: z.string().optional().default('250'),
    zoom: z.string().optional().describe('Map zoom level'),
    excludedTypes: z.union([z.string(), z.array(z.string())]).optional().transform((val) => {
        if (!val) return undefined;
        if (typeof val === 'string') return [val];
        return val;
    }),
}).loose()

export type CompetitorRequest = z.infer<typeof RequestSchema>;



export const getWikiSearchRoute = createRouteBody(
    'get',
    '/api/locations/wiki',
    tags,
    'Wikipedia geo search',
    'Search Wikipedia articles near given coordinates.',
    {
        query: z.object({
            lat: z.string().describe('Latitude'),
            lon: z.string().describe('Longitude'),
            radius: z.string().optional().default('10000').describe('Radius in meters (max 10000)'),
            limit: z.string().optional().default('10').describe('Limit results'),
        }),
    },
    {
        200: {
            description: 'Wiki geosearch results',
            content: {
                'application/json': {
                    schema: z.object({
                        data: z.array(z.any()),
                    }),
                },
            },
        },
        500: {
            description: 'Server error',
        },
    },
    true // public
);

export const getPlacesTypesRoute = createRouteBody(
    'get',
    '/api/places/types',
    tags,
    'List all known place types',
    'Get a unique list of all place types stored in the database.',
    {},
    {
        200: {
            description: 'List of types',
            content: {
                'application/json': {
                    schema: z.object({
                        data: z.array(z.string()),
                    }),
                },
            },
        },
        500: { description: 'Server error' },
    },
    false // private
);


export const getLlmRegionInfoRoute = createRouteBody(
    'get',
    '/api/locations/llm-info',
    tags,
    'LLM region info',
    'Get LLM-generated region information for a location.',
    {
        query: z.object({
            location: z.string().describe('Location name to get info for'),
            lang: z.string().optional().describe('UI language ISO 639-1 (e.g. es) — response strings follow this locale'),
        }),
    },
    {
        200: {
            description: 'LLM Region Info',
            content: {
                'application/json': {
                    schema: z.object({
                        data: z.any(),
                    }),
                },
            },
        },
        500: {
            description: 'Server error',
        },
    },
    true // public
);


export const getPlacesGridSearchesRoute = createRouteBody(
    'get',
    '/api/places/gridsearch',
    tags,
    'List stored GridSearches',
    'List all generated GridSearch files/runs.',
    {},
    {
        200: {
            description: 'List of grid searches',
            content: {
                'application/json': {
                    schema: z.object({
                        data: z.array(z.any()),
                    }),
                },
            },
        },
        500: { description: 'Server error' },
    },
    false // private
);

export const getPlacesGridSearchByIdRoute = createRouteBody(
    'get',
    '/api/places/gridsearch/{id}',
    tags,
    'Get a stored GridSearch',
    'Load a specific GridSearch JSON result by job id.',
    {
        params: z.object({
            id: z.string().describe('The job ID'),
        }),
    },
    {
        200: {
            description: 'GridSearch JSON content',
            content: {
                'application/json': {
                    schema: z.object({
                        data: z.any(),
                    }),
                },
            },
        },
        404: { description: 'Search not found' },
        500: { description: 'Server error' },
    },
    true // public — handler enforces is_public / ownership check
);

export const getPlacesGridSearchRunStateRoute = createRouteBody(
    'get',
    '/api/places/gridsearch/{id}/state',
    tags,
    'Get GridSearch run state',
    'Restore full state for a grid search run.',
    {
        params: z.object({
            id: z.string().describe('Job ID'),
        }),
    },
    {
        200: {
            description: 'Full run state',
            content: {
                'application/json': {
                    schema: z.object({
                        data: z.any(),
                    }),
                },
            },
        },
        404: { description: 'Run not found' },
        500: { description: 'Server error' },
    },
    false // private
);

export const postPlacesGridSearchRoute = createRouteBody(
    'post',
    '/api/places/gridsearch',
    tags,
    'Start GridSearch Pipeline',
    'Start a GridSearch pipeline job.',
    {
        query: z.object({
            background: z.enum(['true', 'false']).optional().default('true').describe('Run in background'),
        }),
        body: {
            content: {
                'application/json': {
                    schema: z.object({
                        guided: z.any().optional(),
                        search: z.any().optional(),
                        jobId: z.string().optional(),
                        test: z.boolean().optional()
                    }),
                },
            },
        },
    },
    {
        200: {
            description: 'Test successful',
            content: {
                'application/json': {
                    schema: z.object({
                        ok: z.boolean()
                    }),
                },
            },
        },
        202: {
            description: 'Job submitted to background worker',
            content: {
                'application/json': {
                    schema: z.object({
                        message: z.string(),
                        jobId: z.string(),
                    }),
                },
            },
        },
        500: { description: 'Server error' },
    },
    false // private
);

export const postPlacesGridSearchRetryRoute = createRouteBody(
    'post',
    '/api/places/gridsearch/{id}/retry',
    tags,
    'Retry GridSearch Job',
    'Retry a failed GridSearch pipeline job.',
    {
        params: z.object({
            id: z.string().describe('The job ID to retry'),
        }),
    },
    {
        202: {
            description: 'Job resubmitted to background worker',
            content: {
                'application/json': {
                    schema: z.object({
                        message: z.string(),
                        jobId: z.string(),
                    }),
                },
            },
        },
        404: { description: 'Run not found' },
        500: { description: 'Server error' },
    },
    false // private
);

export const postPlacesGridSearchExpandRoute = createRouteBody(
    'post',
    '/api/places/gridsearch/{id}/expand',
    tags,
    'Expand GridSearch Job',
    'Expand an existing GridSearch to new GADM regions, reusing search settings.',
    {
        params: z.object({
            id: z.string().describe('The parent run ID to expand'),
        }),
    },
    {
        202: {
            description: 'Expansion job submitted',
            content: {
                'application/json': {
                    schema: z.object({
                        message: z.string(),
                        jobId: z.string(),
                    }),
                },
            },
        },
        404: { description: 'Run not found' },
        500: { description: 'Server error' },
    },
    false // private
);

export const postPlacesGridSearchControlRoute = createRouteBody(
    'post',
    '/api/places/gridsearch/{id}/control',
    tags,
    'GridSearch pause / resume / cancel',
    'Send a control command to the in-process C++ worker for an active run.',
    {
        params: z.object({
            id: z.string().describe('The run / job ID'),
        }),
        body: {
            content: {
                'application/json': {
                    schema: z.object({
                        action: z.enum(['pause', 'resume', 'cancel']),
                    }),
                },
            },
        },
    },
    {
        202: {
            description: 'Control frame sent to worker',
            content: {
                'application/json': {
                    schema: z.object({
                        ok: z.boolean(),
                    }),
                },
            },
        },
        400: { description: 'Run is not active' },
        404: { description: 'Run not found' },
        500: { description: 'Server error' },
    },
    false // private
);

export const getPlacesGridSearchStreamRoute = createRouteBody(
    'get',
    '/api/places/gridsearch/{id}/stream',
    tags,
    'Stream GridSearch progress via SSE',
    'Server-Sent Events stream for real-time gridsearch pipeline progress.',
    {
        params: z.object({
            id: z.string().describe('The job ID'),
        }),
    },
    {
        200: {
            description: 'SSE stream of pipeline events',
            content: {
                'text/event-stream': {
                    schema: z.any(),
                },
            },
        },
        401: { description: 'Unauthorized' },
    },
    false // private
);


export const getPlacesGridSearchExportRoute = createRouteBody(
    'get',
    '/api/places/gridsearch/export',
    tags,
    'Export a stored GridSearch',
    'Export a GridSearch run result as MD or JSON.',
    {
        query: z.object({
            search: z.string().describe('The grid search run id'),
            format: z.enum(['md', 'json']).describe('Export format'),
        }),
    },
    {
        200: {
            description: 'Exported content',
            content: {
                'application/json': { schema: z.any() },
                'text/markdown': { schema: z.string() }
            },
        },
        404: { description: 'Search not found' },
        500: { description: 'Server error' },
    },
    true // public — handler enforces is_public / ownership check
);

export const deletePlacesGridSearchByIdRoute = createRouteBody(
    'delete',
    '/api/places/gridsearch/{id}',
    tags,
    'Delete a stored GridSearch',
    'Delete a specific GridSearch run by ID.',
    {
        params: z.object({
            id: z.string().describe('The job/run ID'),
        }),
    },
    {
        200: {
            description: 'Deleted successfully',
            content: {
                'application/json': {
                    schema: z.object({
                        success: z.boolean(),
                    }),
                },
            },
        },
        404: { description: 'Search not found' },
        500: { description: 'Server error' },
    },
    false // private
);

export const postPlacesGridSearchMergeRoute = createRouteBody(
    'post',
    '/api/places/gridsearch/{id}/merge',
    tags,
    'Merge Search Results',
    'Merge results from another search run into this one.',
    {
        params: z.object({
            id: z.string().describe('The target run ID'),
        }),
        body: {
            content: {
                'application/json': {
                    schema: z.object({
                        sourceId: z.string().describe('The source run ID to merge from'),
                    }),
                },
            },
        },
    },
    {
        200: {
            description: 'Merged successfully',
            content: {
                'application/json': {
                    schema: z.object({
                        success: z.boolean(),
                        mergedCount: z.number(),
                    }),
                },
            },
        },
        404: { description: 'Run not found' },
        500: { description: 'Server error' },
    },
    false // private
);

export const patchPlacesGridSearchSettingsRoute = createRouteBody(
    'patch',
    '/api/places/gridsearch/{id}/settings',
    tags,
    'Update GridSearch Settings',
    'Update sharing and public visibility settings for a GridSearch run.',
    {
        params: z.object({
            id: z.string().describe('The job/run ID'),
        }),
        body: {
            content: {
                'application/json': {
                    schema: z.object({
                        is_public: z.boolean().optional().describe('Whether the run is public'),
                        shared_with: z.array(z.string()).optional().describe('Array of user UUIDs who can access the run'),
                    }),
                },
            },
        },
    },
    {
        200: {
            description: 'Updated successfully',
            content: {
                'application/json': {
                    schema: z.object({
                        success: z.boolean(),
                        settings: z.any()
                    }),
                },
            },
        },
        403: { description: 'Unauthorized to modify settings' },
        404: { description: 'Search not found' },
        500: { description: 'Server error' },
    },
    false // private
);

export const postPlacesGridSearchExportToContactsRoute = createRouteBody(
    'post',
    '/api/places/gridsearch/{id}/export-to-contacts',
    tags,
    'Export Results to Contacts',
    'Resolve grid search results and import them into the contacts system.',
    {
        params: z.object({
            id: z.string().describe('The job/run ID'),
        }),
        body: {
            content: {
                'application/json': {
                    schema: z.object({
                        groupId: z.string().optional().describe('Optional contact group ID to assign'),
                        placeIds: z.array(z.string()).optional().describe('If set, only import these place IDs (e.g. current DataGrid filtered rows).'),
                        excludedTypes: z.array(z.string()).optional().describe('If placeIds omitted, skip rows whose types intersect this list (case-insensitive).'),
                    }),
                },
            },
        },
    },
    {
        200: {
            description: 'Export result',
            content: {
                'application/json': {
                    schema: z.object({
                        imported: z.number(),
                        skipped: z.number(),
                    }),
                },
            },
        },
        401: { description: 'Unauthorized' },
        404: { description: 'Search not found' },
        500: { description: 'Server error' },
    },
    false // private
);


export const getPlaceByIdRoute = createRouteBody(
    'get',
    '/api/places/{place_id}',
    tags,
    'Get place details',
    'Retrieve details for a specific place by place ID.',
    {
        params: z.object({
            place_id: z.string().describe('Google place_id'),
        }),
    },
    {
        200: {
            description: 'Place details',
            content: {
                'application/json': {
                    schema: z.object({
                        data: z.any(),
                    }),
                },
            },
        },
        404: { description: 'Place not found' },
        500: { description: 'Server error' },
    },
    false // private
);

export const getPlacePhotosRoute = createRouteBody(
    'get',
    '/api/places/{place_id}/photos',
    tags,
    'Get place photos via SerpAPI',
    'Fetch Google Maps photos for a place on-the-fly using the user\'s SerpAPI key.',
    {
        params: z.object({
            place_id: z.string().describe('Google place_id'),
        }),
    },
    {
        200: {
            description: 'Photos data',
            content: {
                'application/json': {
                    schema: z.object({
                        data: z.any(),
                    }),
                },
            },
        },
        404: { description: 'Place not found or no photos' },
        500: { description: 'Server error' },
    },
    false // private
);

export const getPlaceInfoRoute = createRouteBody(
    'get',
    '/api/places/{place_id}/place-info',
    tags,
    'LLM place info',
    'Get LLM-generated business summary from place emails and scraped site content.',
    {
        params: z.object({
            place_id: z.string().describe('Google place_id'),
        }),
        query: z.object({
            lang: z.string().optional().describe('UI language ISO 639-1 (e.g. es) — response strings follow this locale'),
            runId: z.string().optional().describe('Grid search run id — loads request for potentialCustomer scoring'),
            context: z.string().max(8000).optional().describe('User override text for Potential customer scoring (replaces grid request in prompt)'),
        }),
    },
    {
        200: {
            description: 'LLM place info JSON',
            content: {
                'application/json': {
                    schema: z.object({
                        data: z.any(),
                    }),
                },
            },
        },
        404: { description: 'Place not found' },
        500: { description: 'Server error' },
        502: { description: 'LLM returned no content' },
    },
    false // private
);

export const postLlmFiltersRunRoute = createRouteBody(
    'post',
    '/api/places/llm-filters/run',
    tags,
    'Run AI grid filters',
    'Enqueue LLM evaluation for places and filters; returns runId. Results merge into places.meta.llm_grid_filters.',
    {
        body: {
            content: {
                'application/json': {
                    schema: z.object({
                        placeIds: z.array(z.string()).min(1),
                        filterIds: z.array(z.string()).min(1),
                        lang: z.string().optional(),
                    }),
                },
            },
        },
    },
    {
        202: {
            description: 'Run started',
            content: {
                'application/json': {
                    schema: z.object({
                        data: z.object({ runId: z.string() }),
                    }),
                },
            },
        },
        400: { description: 'Bad request' },
        401: { description: 'Unauthorized' },
        500: { description: 'Server error' },
    },
    false,
);

export const getLlmFiltersStreamRoute = createRouteBody(
    'get',
    '/api/places/llm-filters/stream',
    tags,
    'SSE for AI grid filter run',
    'Subscribe to progress for a runId from POST /api/places/llm-filters/run. Use ?token= for browser EventSource.',
    {
        query: z.object({
            runId: z.string().min(1),
        }),
    },
    {
        200: {
            description: 'text/event-stream',
            content: {
                'text/event-stream': {
                    schema: z.string(),
                },
            },
        },
        400: { description: 'Bad request' },
        401: { description: 'Unauthorized' },
    },
    false,
);

export const getRegionSearchRoute = createRouteBody(
    'get',
    '/api/regions/search',
    tags,
    'Search regions',
    'Search for geographic regions using GADM data.',
    {
        query: z.object({
            query: z.string().describe('Region name to search for'),
            content_level: z.string().optional().describe('Filter by content level (e.g. 1)'),
            geojson: z.string().optional().describe('Include GeoJSON geometry (true/false)'),
            country: z.string().optional().describe('Country filter (Admin code or name)'),
        }),
    },
    {
        200: {
            description: 'Search results',
            content: {
                'application/json': {
                    schema: z.object({
                        data: z.array(z.any()),
                    }),
                },
            },
        },
        500: {
            description: 'Server error',
        },
    },
    true // public
);

export const getRegionBoundaryRoute = createRouteBody(
    'get',
    '/api/regions/boundary/{id}',
    tags,
    'Get region boundary',
    'Get GeoJSON boundary for a specific region by GADM ID.',
    {
        params: z.object({
            id: z.string().describe('GADM ID of the region'),
        }),
        query: z.object({
            name: z.string().optional().describe('Region Name (Required for GADM fetch)'),
            targetLevel: z.string().optional().describe('Target subdivision level to fetch polygons for (defaults to exact region bounds)'),
            enrich: z.string().optional().describe('true to include GeoNames enrichment (sqkm, population)'),
            pop: z.enum(['true', 'false']).optional().describe('true to include GHS population enrichment'),
            built: z.enum(['true', 'false']).optional().describe('true to include GHS built-up enrichment'),
            minGhsPop: z.coerce.number().optional().describe('Minimum GHS population to include feature'),
            minGhsBuilt: z.coerce.number().optional().describe('Minimum GHS built-up weight to include feature'),
        }),
    },
    {
        200: {
            description: 'GeoJSON boundary',
            content: {
                'application/json': {
                    schema: z.object({
                        data: z.any(), // GeoJSON object
                    }),
                },
            },
        },
        404: {
            description: 'Region not found',
        },
        500: {
            description: 'Server error',
        },
    },
    true // public
);

export const getRegionReverseRoute = createRouteBody(
    'get',
    '/api/regions/reverse',
    tags,
    'Reverse geocode',
    'Reverse geocode coordinates to region information.',
    {
        query: z.object({
            lat: z.string().describe('Latitude'),
            lon: z.string().describe('Longitude'),
        }),
    },
    {
        200: {
            content: {
                'application/json': {
                    schema: z.object({
                        data: z.any().describe('Reverse geocoding result')
                    }),
                },
            },
            description: 'Reverse geocoding successful',
        },
        500: {
            content: {
                'application/json': {
                    schema: z.object({
                        error: z.string(),
                    }),
                },
            },
            description: 'Server error',
        },
    },
    true // public
);

export const getRegionHierarchyRoute = createRouteBody(
    'get',
    '/api/regions/hierarchy',
    tags,
    'GADM Hierarchy by point',
    'Get exact GADM hierarchy containing coordinates.',
    {
        query: z.object({
            lat: z.string().describe('Latitude'),
            lon: z.string().describe('Longitude'),
        }),
    },
    {
        200: {
            content: {
                'application/json': {
                    schema: z.object({
                        data: z.array(z.any()),
                    }),
                },
            },
            description: 'Hierarchy found',
        },
        500: {
            description: 'Server error',
        },
    },
    true // public
);

export const getRegionNamesRoute = createRouteBody(
    'get',
    '/api/regions/names',
    tags,
    'Get region names',
    'Get region names for a given admin code.',
    {
        query: z.object({
            admin: z.string().describe('Admin code (e.g. FRA, FRA.1_1)'),
            content_level: z.string().describe('Content level (e.g. 2)').default('2'),
            resolveNames: z.string().optional().describe('Resolve unknown names with BigDataCloud (true/false)'),
        }),
    },
    {
        200: {
            description: 'Region names results',
            content: {
                'application/json': {
                    schema: z.object({
                        data: z.array(z.any()),
                    }),
                },
            },
        },
        500: {
            description: 'Server error',
        },
    },
    true // public
);

