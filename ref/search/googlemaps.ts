import { substitute } from '@polymech/commons'
import { deepClone as clone } from '@polymech/core/objects'

import {
    zodSchema,
    IOptionsGoogleMaps,
    IOptionsGoogleMapsInput,
    ResolveFlags,
} from './googlemaps-zod.js'
export { zodSchema, ResolveFlags }
export type { IOptionsGoogleMaps, IOptionsGoogleMapsInput }

type GoogleMapsParameters = Record<string, any>

import { isArray } from '@polymech/core/primitives'
import pMap from 'p-map'

import { getLogger } from './context.js'
const log = () => getLogger()

import { SearchProviders } from './providers.js'
import { findEMail } from './email.js'
import { defaultEngine, defaultFromLocation, defaultGoogleDomain, defaultLanguage, PAGE_SIZE, SEARCH_AI_PROMPTS } from './constants.js'
import { meta } from './html.js'
import { reverse, REVERSE_DEFAULT } from './geo.js'

import { geocode_forward } from './geo.js'
import { GoogleMapResultInternal, type GoogleMapResult, type GoogleMapPhotos } from './google.js'
import axios from 'axios'

const queryExtras = ''

export const locationString = (coords: string, zoom: number = 13) => `@${coords},${zoom}z`

export const defaultParamsGoogleES = (query: string, mixin: any) => {
    return {
        location: defaultFromLocation,
        hl: defaultLanguage,
        gl: defaultLanguage,
        google_domain: defaultGoogleDomain,
        q: query,
        ...mixin
    }
}
export const defaultSearchParamsMapsES = (query: string, zoom: number, mixin: any = {}) => {
    return {
        engine: defaultEngine,
        type: 'search',
        q: query,
        ll: locationString('41.6911354,2.1652746', zoom),
        google_domain: defaultGoogleDomain,
        hl: defaultLanguage,
        ...mixin,
    }
}
/**
 * Raw SerpApi search — pagination only, no enrichment or filtering
 */
export const searchRaw = async (
    query: string,
    key: string,
    opts: IOptionsGoogleMaps,
): Promise<GoogleMapResult[]> => {
    const { results } = await searchRawWithStats(query, key, opts);
    return results;
}

/**
 * Raw SerpApi search with stats — returns results + apiCalls count
 */
export const searchRawWithStats = async (
    query: string,
    key: string,
    opts: IOptionsGoogleMaps,
): Promise<{ results: GoogleMapResult[]; apiCalls: number }> => {
    const googleParams = {
        ...opts,
        api_key: key,
        q: query + queryExtras,
        ll: opts.searchCoord
    } as GoogleMapsParameters

    let results: GoogleMapResult[] = []
    let pageIdx = 0
    let apiCalls = 0
    let start = 0
    const PAGE_SIZE_SERP = 20; // SerpApi Google Maps returns max 20 per page

    while (results.length < opts.limit) {
        const page = await SearchProviders.serpApi((googleParams as any).engine, {
            ...googleParams,
            start,
        })
        apiCalls++

        const localResults = page?.local_results || [];
        const placeResults = page?.place_results
            ? (isArray(page.place_results) ? page.place_results : [page.place_results])
            : [];
        const pageResults = [...localResults, ...placeResults];

        log().debug(`searchRaw "${query}" page=${pageIdx} start=${start} → ${pageResults.length} results (${localResults.length} local, ${placeResults.length} place)`)

        if (pageResults.length === 0) break; // No more results

        pageResults.forEach((r: any) => { r.page = pageIdx; });
        results.push(...pageResults);

        if (pageResults.length < PAGE_SIZE_SERP) break; // Last page (partial)

        pageIdx++
        start += PAGE_SIZE_SERP
    }

    log().debug(
        `searchRaw "${query}" with ${opts.searchCoord} / ${opts.searchFrom} @ ${opts.zoom} | ${results.length} raw results | ${apiCalls} API calls`,
    )

    return { results: results.slice(0, opts.limit), apiCalls }
}

/**
 * Geo enrichment — reverse geocoding via bigdatacloud
 */
export const geoEnrich = async (
    results: GoogleMapResult[],
    opts: IOptionsGoogleMaps,
): Promise<GoogleMapResult[]> => {
    let idx = 0
    await pMap(
        results,
        async (entry: any) => {
            idx++
            entry.position = entry.page * PAGE_SIZE + idx
            try {
                return reverse(entry, opts)
            } catch (e) {
                log().error(`Error reverse geocoding ${entry.title}`)
                entry.geo = REVERSE_DEFAULT
            }
        },
        { concurrency: opts.concurrency },
    )
    return results
}

/**
 * Default filters — city, country, continent, type, excludedTypes, gps_coordinates
 */
export const filterResults = (
    results: GoogleMapResult[],
    opts: IOptionsGoogleMaps,
): GoogleMapResult[] => {
    let filtered = results

    if (opts.filterCity) {
        filtered = filtered.filter((r) => r.geo?.city?.toLowerCase() === opts.filterCity!.toLowerCase())
    }
    if (opts.filterCountry) {
        filtered = filtered.filter((r) => r.geo?.countryName?.toLowerCase() === opts.filterCountry!.toLowerCase())
    }
    if (opts.filterContinent) {
        filtered = filtered.filter((r) => r.geo?.continent?.toLowerCase() === opts.filterContinent!.toLowerCase())
    }
    if (opts.filterType) {
        filtered = filtered.filter((r) => r.type === opts.filterType!)
    }
    if (opts.excludedTypes && opts.excludedTypes.length > 0) {
        filtered = filtered.filter((r) => {
            if (!r.types || r.types.length === 0) return true
            return !r.types.some(t => opts.excludedTypes!.includes(t))
        })
    }

    filtered = filtered.filter((r) => r.gps_coordinates)

    return filtered.slice(0, opts.limit)
}

/**
 * Full pipeline: search → geo enrich → filter → enrich (meta/photos/email)
 */
export const searchGoogleMap = async (
    query: string,
    key: string,
    opts: IOptionsGoogleMaps,
) => {
    let results = await searchRaw(query, key, opts)

    // Geo enrich before filtering (needed for geo filters, and always useful)
    await geoEnrich(results, opts)

    // Apply filters
    results = filterResults(results, opts)

    log().info(
        `found ${results.length} items for "${query}" (Zoom: ${opts.zoom} | Limit: ${opts.limit}) from "${opts.searchFrom}"`,
    )

    // Full enrichment (meta, email, photos) on final set
    await enrichResults(results, {}, opts)

    return results
}

const enrichResults = async (results: GoogleMapResult[], index: any, opts: IOptionsGoogleMaps): Promise<GoogleMapResultInternal[]> => {
    let idx = 0

    await pMap(
        results,
        async (entry: any) => {
            idx++
            entry.position = entry.page * PAGE_SIZE + idx
            try {
                if (index[entry.title] && index[entry.title].geo) {
                    entry.geo = index[entry.title].geo
                    return
                }
                return reverse(entry, opts)
            } catch (e) {
                log().error(`Error reverse geocoding ${entry.title}`)
                entry.geo = REVERSE_DEFAULT
            }
        },
        { concurrency: opts.concurrency },
    )

    if (opts.meta) {
        await pMap(
            results,
            (entry: any) => {
                if (entry.meta || !entry.website || entry.rejected) {
                    return
                }
                try {
                    if (index[entry.title] && index[entry.title].meta) {
                        entry.meta = index[entry.title].meta
                        return
                    }
                    return meta(entry, opts)
                } catch (e) {
                    // entry.meta = {}
                }
            },
            { concurrency: 1 },
        )
    }

    if (opts.findEMail && opts.meta) {
        await pMap(
            results,
            async (entry: any) => {
                if (index[entry.title] && index[entry.title].email) {
                    entry.email = index[entry.title].email
                    return
                }
                if (entry.meta && entry.website && !entry.email) {
                    try {
                        return findEMail(SEARCH_AI_PROMPTS.GET_EMAIL, entry.website, opts, entry)
                    } catch (e) {
                        log().error(`Error retrieving EMail data ${entry.title}`)
                    }
                }
            },
            { concurrency: 1 },
        )
    }
    if (opts.resolve?.includes(ResolveFlags.PHOTOS)) {
        await pMap(
            results,
            async (entry: GoogleMapResultInternal) => {
                if (entry.google_media || !entry.data_id) {
                    return
                }
                if (index[entry.title] && index[entry.title].google_media) {
                    entry.google_media = index[entry.title].google_media
                    return
                }
                try {
                    if (!entry.photos_link) return
                    const url = `${entry.photos_link}&api_key=${opts.api_key}`
                    const response = await axios.get(url)
                    const photos: GoogleMapPhotos = response.data
                    if (photos) {
                        entry.google_media = photos
                    }
                } catch (e) {
                    log().error(`Error retrieving photo data for ${entry.title}: ${e instanceof Error ? e.message : String(e)}`)
                }
            },
            { concurrency: 10 },
        )
    }

    return results as GoogleMapResultInternal[]
}

export const parse = (argv: IOptionsGoogleMaps): IOptionsGoogleMaps | undefined => {

    let opts = {
        ...defaultSearchParamsMapsES(argv.query, argv.zoom),
        ...argv,
        api_key: argv.api_key,
        geocode_key: argv.geocode_key,
        openai: (argv as any).openai,

        bigdata: (argv as any).bigdata || { key: '' }
    } as any

    opts = zodSchema().parse(opts)

    if (!opts.query) {
        log().warn(`No query specified`)
        return
    }
    if (!opts.api_key) {
        log().error('No Serpapi key found in config or options!')
        return
    }
    return opts
}

export const googleMaps = async (opts: IOptionsGoogleMapsInput): Promise<GoogleMapResultInternal[]> => {
    const parsed = parse(opts as any)
    if (!parsed) {
        log().error('Invalid options')
        return []
    }
    const _opts = parsed as any
    try {
        const searchFrom = substitute(false, _opts.searchFrom || '', (_opts as any).variables)
        if (searchFrom && _opts.geocode_key && !_opts.searchCoord) {
            const coords = await geocode_forward(searchFrom, _opts.geocode_key)
            if (coords) {
                _opts.searchCoord = locationString(coords, _opts.zoom)
            } else {
                log().error(`Error geocoding "${searchFrom}"`)
            }
        }
    } catch (error: any) {
        log().error(`Error geocoding "${_opts.searchFrom}" - ${error?.message || error}`)
    }

    try {
        const results = await searchGoogleMap(_opts.query, _opts.api_key, { ..._opts })
        return results as GoogleMapResultInternal[]
    } catch (error: any) {
        log().error('Error searching GoogleMaps : ' + (error?.message || error))
        return []
    }
}

