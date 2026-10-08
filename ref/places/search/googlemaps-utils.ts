
import * as path from 'path'
import { URL } from 'url'
import { isFile, resolve } from '@polymech/commons'
import { sync as read } from '@polymech/fs/read'
import { sync as exists } from '@polymech/fs/exists'

export type ParsedURL = {
    scheme: string
    host?: string
    path?: string
    query?: Record<string, string>
    fragment?: string
}

export const escapeFirstUrlSegment = (url: string): string => {
    const schemeEndIndex = url.indexOf('://') + 3;
    const restOfUrl = url.slice(schemeEndIndex);
    const questionMarkIndex = restOfUrl.indexOf('?');

    if (questionMarkIndex !== -1) {
        const firstSegment = restOfUrl.slice(0, questionMarkIndex);
        const escapedFirstSegment = encodeURIComponent(firstSegment);
        return url.slice(0, schemeEndIndex) + escapedFirstSegment + restOfUrl.slice(questionMarkIndex);
    } else {
        const escapedFirstSegment = encodeURIComponent(restOfUrl);
        return url.slice(0, schemeEndIndex) + escapedFirstSegment;
    }
}


export const handleFs = async (path: string): Promise<string | object | undefined> => {
    return read(path)
}

export const schemeHandlers: Record<string, (arg1: string, arg2?: URLSearchParams) => Promise<string | object | undefined>> = {
    'fs': handleFs,
    'default': handleFs
}

export const parseCustomUrl = async (url: string): Promise<string | object | undefined> => {
    if (!url.includes('://')) {
        const _path = path.resolve(resolve(url))
        if (exists(_path) && isFile(_path)) {
            return read(_path, 'json')
        }
    }
    const parsedUrl = new URL(escapeFirstUrlSegment(url))
    let scheme = parsedUrl.protocol.replace(':', '') || 'default'
    const handler = schemeHandlers[scheme]
    let result: string | object | undefined
    if (handler) {
        if (scheme === 'osr-ai') {
            result = await handler(parsedUrl.hostname, parsedUrl.searchParams)
        } else {
            result = await handler(parsedUrl.pathname)
        }
    }
    return result || url
}
export const resolvePath = (str: string, query: string, category: string, opts: any) => {
    return path.resolve(resolve(str, false,
        {
            QUERY: query,
            FROM: opts.searchFrom ? opts.searchFrom.split(',').map((s: string) => s.trim()).join('/') : 'barcelona, spain',
            ENGINE: opts.engine,
            DOMAIN: opts.google_domain,
            LANG: opts.language,
            COUNTRY: opts.country,
            AREA: opts.area,
            CATEGORY: category || 'unknown',
            ...opts.variables || {}
        }))
}

const cleanString = (str: string): string => {
    if (typeof str !== 'string') {
        return str
    }
    return str
        .replace(/\u202F/g, ' ') // narrow no-break space
        .replace(/\u2013/g, '-') // en dash
        .replace(/\u2019/g, "'") // right single quotation mark
}

export const cleanObjectStrings = (obj: any): any => {
    if (!obj) {
        return obj
    }
    if (Array.isArray(obj)) {
        return obj.map(item => cleanObjectStrings(item))
    }
    if (typeof obj === 'object') {
        return Object.entries(obj).reduce((acc, [key, value]) => {
            acc[key] = cleanObjectStrings(value)
            return acc
        }, {} as any)
    }
    if (typeof obj === 'string') {
        return cleanString(obj)
    }
    return obj
}
