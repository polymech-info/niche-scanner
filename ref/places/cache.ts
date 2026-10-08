import { createHash } from 'crypto';
import { getSearchByHash, getLocationsByPlaceIds } from './db-places.js';

export const params_hash = (params: any) => {
    // Normalize input for hashing
    // Sort keys to ensure consistent hash
    const normalizedInput = JSON.stringify(params, Object.keys(params).sort());
    return createHash('sha256').update(normalizedInput).digest('hex');
};

export const get_cached = async (inputHash: string) => {
    const searchData = await getSearchByHash(inputHash);

    if (searchData && searchData.result_place_ids) {
        const locations = await getLocationsByPlaceIds(searchData.result_place_ids);
        return locations;
    }
    return null;
};
