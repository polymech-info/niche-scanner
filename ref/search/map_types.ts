import { SearchMetadata, SearchInformation, SearchParameters } from './types.js'

export interface GpsCoordinates {
    latitude: number;
    longitude: number;
}

export interface OperatingHours {
    friday?: string;
    saturday?: string;
    sunday?: string;
    monday?: string;
    tuesday?: string;
    wednesday?: string;
    thursday?: string;
}

export type LocalResult = {
    title?: string;
    place_id?: string;
    data_id?: string;
    data_cid?: string;
    reviews_link?: string;
    photos_link?: string;
    gps_coordinates?: GpsCoordinates;
    place_id_search?: string;
    provider_id?: string;
    rating?: number;
    reviews?: number;
    price?: string;
    type?: string;
    types?: string[];
    address?: string;
    open_state?: string;
    hours?: string;
    operating_hours?: OperatingHours;
    phone?: string;
    website?: string;
    description?: string;
    service_options?: { [key: string]: boolean };
    thumbnail?: string;
    email?: string;
    [key: string]: any
}


export interface SearchResult {
    search_metadata: SearchMetadata;
    search_information: SearchInformation;
    local_results: LocalResult[];
    search_parameters: SearchParameters;
}

/////////////////////////////////////////////////
//
// loc.meta
//
/////////////////////////////////////////////////
export interface LocationSiteMeta {
    // Normalized Metadata
    title?: string;
    description?: string;
    image?: string;
    url?: string;

    // Grouped Data
    social?: Page[];
    seo?: SeoData;

    // Crawling & Content
    pages?: Page[];
    externalLinks?: Page[];
    images?: Image[];
}

export interface SeoData {
    keywords?: string[];
    structured?: Structured[];
    og?: Og;
    metaTags?: Meta;
}

export interface Page {
    url: string
    source: string
    status: 'PENDING' | 'SEARCHING_EMAIL' | 'SEARCHED_EMAIL' | 'FAILED' | 'AXIOS_NO_EMAIL' | 'AXIOS_FAILED'
    error?: string
}

export interface Og {
    url?: string
    type?: string
    title?: string
    site_name?: string
    description?: string
    image?: string
    [key: string]: any
}

export interface Meta {
    url?: string
    title?: string
    description?: string
    image?: string
    type?: string
    site_name?: string
    keywords?: string[]
    [key: string]: any
}

export interface Image {
    src: string
}

export interface Structured {
    "@graph"?: Graph[]
    "@context"?: string
    "@type"?: string
    name?: string
    url?: string
    image?: string
    email?: string
    telephone?: string
    address?: string | object
    sameAs?: string[]
    openingHours?: string
    legalName?: string
    [key: string]: any
}

export interface Graph {
    "@id": string
    url?: string
    name?: string
    "@type": string
    isPartOf?: IsPartOf
    breadcrumb?: Breadcrumb
    inLanguage?: string
    dateModified?: string
    datePublished?: string
    potentialAction?: PotentialAction[]
    itemListElement?: ItemListElement[]
    description?: string
    [key: string]: any
}

export interface IsPartOf {
    "@id": string
}

export interface Breadcrumb {
    "@id": string
}

export interface PotentialAction {
    "@type": string
    target: any
    "query-input"?: QueryInput
}

export interface QueryInput {
    "@type": string
    valueName: string
    valueRequired: boolean
}

export interface ItemListElement {
    name: string
    "@type": string
    position: number
}

