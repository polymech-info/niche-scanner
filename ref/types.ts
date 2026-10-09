export interface RequestInfo {
    success: boolean;
    credits_used: number;
    credits_used_this_request: number;
    credits_remaining: number;
    credits_reset_at: Date;
}

export interface SearchParameters {
    q: string;
    engine: string;
}

export interface SearchMetadata {
    created_at: Date;
    processed_at: Date;
    total_time_taken: number;
    engine_url: string;
    html_url: string;
    json_url: string;
}

export interface SearchTab {
    position: number;
    text: string;
    link: string;
}

export interface SearchInformation {
    original_query_yields_zero_results: boolean;
    search_tabs: SearchTab[];
    total_results: number;
    time_taken_displayed: number;
    query_displayed: string;
}

export interface RelatedSearch {
    query: string;
    link: string;
    type: string;
}

export interface Source {
    link: string;
    displayed_link: string;
    title: string;
}

export interface RelatedQuestion {
    question: string;
    answer: string;
    source: Source;
    block_position: number;
}

export interface OtherPage {
    page: number;
    link: string;
}

export interface OtherPage2 {
    page: number;
    link: string;
}

export interface ApiPagination {
    next: string;
    other_pages: OtherPage2[];
}

export interface Pagination {
    current: number;
    next: string;
    other_pages: OtherPage[];
    api_pagination: ApiPagination;
}

export interface FirstIndexed {
    raw: string;
    parsed: number;
}

export interface Source2 {
    name: string;
    link: string;
    description: string;
    first_indexed: FirstIndexed;
}

export interface ConnectionSecure {
    raw: string;
    parsed: boolean;
}

export interface AboutThisResult {
    source: Source2;
    connection_secure: ConnectionSecure;
    your_search_and_this_result: string[];
    search_terms: string[];
    related_terms: string[];
}

export interface NestedResult {
    position: number;
    title: string;
    link: string;
    displayed_link: string;
    snippet: string;
}

export interface DetectedExtensions {
    rating: number;
    reviews: number;
}

export interface Top {
    detected_extensions: DetectedExtensions;
    extensions: string[];
}

export interface RichSnippet {
    top: Top;
}

export interface Expanded {
    title: string;
    link: string;
}

export interface Sitelinks {
    expanded: Expanded[];
}

export interface OrganicResult {
    position: number;
    title: string;
    link: string;
    domain: string;
    displayed_link: string;
    snippet: string;
    prerender: boolean;
    snippet_matched: string[];
    about_this_result: AboutThisResult;
    block_position: number;
    cached_page_link: string;
    nested_results: NestedResult[];
    rich_snippet: RichSnippet;
    prefix: string;
    sitelinks: Sitelinks;
    sitelinks_search_box?: boolean;
    missing_words: string[];
}

export interface IScaleserpResponse {
    request_info: RequestInfo;
    search_parameters: SearchParameters;
    search_metadata: SearchMetadata;
    search_information: SearchInformation;
    related_searches: RelatedSearch[];
    related_questions: RelatedQuestion[];
    pagination: Pagination;
    organic_results: OrganicResult[];
}

export interface IScaleserpSearch {
    api_key: string
    q: string
    blacklist?: string[]
}
