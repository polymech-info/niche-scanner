import { getJson as searchSerpAPI } from "serpapi"
import { search as searchScaleserp } from './scalesep.js'

export const SearchProviders = {
    scaleserp: searchScaleserp,
    serpApi: searchSerpAPI
}

export const cleanOptions = (opts: any) => {
    return {
        ...opts,
        openai: 'hidden',
        bigdata: 'hidden',
        api_key: 'hidden',
        geocode_key: 'hidden'
    }
}
