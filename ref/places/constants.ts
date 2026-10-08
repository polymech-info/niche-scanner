import os from 'node:os';

// Locations Constants
export const COST_PER_SEARCH = parseInt(process.env.LOCATIONS_COST || '1');
export const TIMEOUT_MS_LOCATIONS = parseInt(process.env.LOCATIONS_TIMEOUT_MS || '300000');
export const MAX_CONCURRENCY_LOCATIONS = 1; // Kept hardcoded as it wasn't requested to be moved, but could be.

export const PLACES_JOB_OPTIONS = {
    expireInSeconds: parseInt(process.env.LOCATIONS_JOB_EXPIRE_SECONDS || '600'),
    retryLimit: 0,
    retryBackoff: false,
    retryDelayMax: parseInt(process.env.LOCATIONS_JOB_RETRY_DELAY_MAX || '1000')
};

// Email Constants
export const EMAIL_SEARCH_COST = parseInt(process.env.EMAIL_SEARCH_COST || '5');
export const EMAIL_MAX_BATCH_SIZE = parseInt(process.env.MAX_PLACES_PER_REQUEST || '100');

export const EMAIL_META_TIMEOUT_MS = parseInt(process.env.EMAIL_META_TIMEOUT_SECONDS || '30') * 1000;
export const EMAIL_SEARCH_TIMEOUT_MS = parseInt(process.env.EMAIL_SEARCH_TIMEOUT_SECONDS || '60') * 1000;
export const EMAIL_SEARCH_PAGE_TIMEOUT_MS = parseInt(process.env.EMAIL_SEARCH_PAGE_TIMEOUT_SECONDS || '10') * 1000;
export const EMAIL_SEARCH_MAX_PAGES = parseInt(process.env.EMAIL_SEARCH_MAX_PAGES || '15');
export const EMAIL_SEARCH_PAGE_CONCURRENCY = parseInt(process.env.EMAIL_SEARCH_PAGE_CONCURRENCY || '2');
export const EMAIL_STREAM_TIMEOUT_MS = parseInt(process.env.EMAIL_STREAM_TIMEOUT_SECONDS || '300') * 1000;
export const EMAIL_MAX_CONCURRENT_JOBS = parseInt(process.env.EMAIL_MAX_CONCURRENT_JOBS || '5');

export const JOB_NAME = 'places-find';
export const EMAIL_JOB_NAME = 'email-find';
const MACHINE_ID = process.env.MACHINE_ID || process.env.RENDER_INSTANCE_ID || os.hostname();
export const GRIDSEARCH_JOB_NAME = `places-gridsearch-pipeline-${MACHINE_ID}`;
export const GRIDSEARCH_UDS_PORT = parseInt(process.env.GRIDSEARCH_UDS_PORT || '4000');
export const GRIDSEARCH_UDS_PREFIX = process.env.GRIDSEARCH_UDS_PREFIX || 'polymech-gridsearch';
export const GRIDSEARCH_UDS_TIMEOUT_MS = parseInt(process.env.GRIDSEARCH_UDS_TIMEOUT_MS || '60000');
export const GRIDSEARCH_UDS_WATCHDOG_MS = parseInt(process.env.GRIDSEARCH_UDS_WATCHDOG_MS || '15000');
export const GRIDSEARCH_UDS_ACK_TIMEOUT_MS = parseInt(process.env.GRIDSEARCH_UDS_ACK_TIMEOUT_MS || '15000');
export const GRIDSEARCH_UDS_CONNECT_RETRIES = parseInt(process.env.GRIDSEARCH_UDS_CONNECT_RETRIES || '5');
export const GRIDSEARCH_UDS_CONNECT_INTERVAL_MS = parseInt(process.env.GRIDSEARCH_UDS_CONNECT_INTERVAL_MS || '1500');

export enum JobPriority {
    Low = 10,
    Medium = 20,
    High = 30
}

