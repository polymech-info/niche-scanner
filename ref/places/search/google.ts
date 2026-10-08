import { LocationSiteMeta } from "./map_types.js"

export enum GoogleSearchUrls {
  EN = "https://www.google.com/",
  DE = "https://www.google.de/",
  FR = "https://www.google.fr/",
  ES = "https://www.google.es/",
  IT = "https://www.google.it/",
  PT = "https://www.google.pt/",
  RU = "https://www.google.ru/",
  JP = "https://www.google.co.jp/",
  ZH = "https://www.google.com.hk/",
  UK = "https://www.google.co.uk/"
}


export interface GpsCoordinates {
  latitude: number
  longitude: number
}

export interface OperatingHours {
  thursday: string
  friday: string
  saturday: string
  sunday: string
  monday: string
  tuesday: string
  wednesday: string
}

export interface Geo {
  latitude: number
  lookupSource: string
  longitude: number
  localityLanguageRequested: string
  continent: string
  continentCode: string
  countryName: string
  countryCode: string
  principalSubdivision: string
  principalSubdivisionCode: string
  city: string
  locality: string
  postcode: string
  plusCode: string
  localityInfo: LocalityInfo
}

export interface LocalityInfo {
  administrative: Administrative[]
  informative: Informative[]
}

export interface Administrative {
  name: string
  description: string
  isoName?: string
  order: number
  adminLevel: number
  isoCode?: string
  wikidataId: string
  geonameId: number
}

export interface Informative {
  name: string
  description?: string
  isoName?: string
  order: number
  isoCode?: string
  wikidataId?: string
  geonameId?: number
}

export interface GoogleMapResult {
  position: number
  title: string
  place_id: string
  data_id: string
  data_cid: string
  reviews_link: string
  photos_link: string
  gps_coordinates: GpsCoordinates
  place_id_search: string
  provider_id: string
  rating: number
  reviews: number
  type: string
  types: string[]
  address: string
  open_state: string
  hours: string
  operating_hours: OperatingHours
  website: string
  thumbnail: string
  geo: Geo
}

export interface GoogleMapResultEx extends GoogleMapResult {
  email?: string
}

/////////////////////////////////////////////
//
//  SerpApi -  Media (GoogleMapResult::photos_link ->)
//
/////////////////////////////////////////////

export interface GoogleMapPhotos {
  search_metadata: SearchMetadata
  search_parameters: SearchParameters
  categories: Category[]
  photos: Photo[]
  serpapi_pagination: SerpapiPagination
}

export interface SearchMetadata {
  id: string
  status: string
  json_endpoint: string
  created_at: string
  processed_at: string
  google_maps_photos_url: string
  raw_html_file: string
  prettify_html_file: string
  total_time_taken: number
}

export interface SearchParameters {
  engine: string
  data_id: string
  hl: string
}

export interface Category {
  title: string
  id: string
}

export interface Photo {
  thumbnail: string
  image: string
  photo_meta_serpapi_link: string
}

export interface SerpapiPagination {
  next: string
  next_page_token: string
}

/////////////////////////////////////////////
//
//  Internal Search Result Types
//
/////////////////////////////////////////////

export interface GoogleMapResultInternal extends GoogleMapResultEx {
  google_media?: GoogleMapPhotos,
  meta?: LocationSiteMeta
}