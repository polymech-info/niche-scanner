import axios from 'axios'
import https from 'https'
import { getLogger } from './context.js'
const log = () => getLogger()
import { LocalResult } from './map_types.js'
const httpsAgent = new https.Agent({ rejectUnauthorized: false })
export const REVERSE_DEFAULT = { continent: 'unknown', countryName: 'unknown', city: 'unknown' }

export const geocode_forward = async (query: string, key: string) => {
    const url = `https://geocode.maps.co/search?q=${query}&api_key=${key}`
    return new Promise<string>((resolve, reject) => {
        axios.get(url)
            .then(response => {
                if (response.data.length === 0) {
                    return false
                }
                resolve(`${response.data[0].lat},${response.data[0].lon}`)
            })
            .catch(error => {
                reject(error);
            })
    })
}
export const reverse = async (loc: LocalResult, opts: any) => {
    try {
        if (!opts.bigdata) {
            opts.bigdata = { key: '' }
        }
        const key = process.env.BIG_DATA_KEY || opts.bigdata.key
        const q = `https://api.bigdatacloud.net/data/reverse-geocode?latitude=${loc.gps_coordinates?.latitude}&longitude=${loc.gps_coordinates?.longitude}&localityLanguage=en&key=${key}`
        return axios.get(q, { httpsAgent }).then((d) => {
            loc['geo'] = d.data || REVERSE_DEFAULT
        })
    } catch (e: any) {
        (loc as any)['geo'] = REVERSE_DEFAULT
        log().error(`Error reverse geocoding: ${e.message}`)
    }
}