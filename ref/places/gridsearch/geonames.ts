import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = path.resolve(__dirname, '../../../../cache/geonames');

// ────────── Types ──────────

export interface GeoNameEntry {
    id: number;
    name: string;
    lat: number;
    lon: number;
    featureClass: string;
    featureCode: string;
    countryCode: string;
    population: number;
    elevation: number | null;
    dem: number;
}

export interface AreaStats {
    totalPopulation: number;
    placeCount: number;
    avgElevation: number;
    minElevation: number;
    maxElevation: number;
}

// ────────── In-memory cache ──────────

const countryCache = new Map<string, GeoNameEntry[]>();

// ────────── GADM GID → ISO 3166-1 alpha-2 ──────────

const ISO3_TO_ISO2: Record<string, string> = {};

function loadIso3Map(): void {
    if (Object.keys(ISO3_TO_ISO2).length > 0) return;

    const infoPath = path.join(CACHE_DIR, '..', 'geonames', '..', 'geonames');
    // Use countryInfo.txt if available, otherwise build from directory listing
    const countryInfoPath = path.resolve(CACHE_DIR, '..', 'countryInfo.txt');

    // If we have countryInfo.txt at the geonames dump root, parse ISO3→ISO2
    // The file is at server/cache/geonames/ level but countryInfo.txt is a separate download
    // For robustness, use a hardcoded subset + directory listing fallback
    // The GADM GID prefix is the ISO3 code (e.g. ESP, DEU, USA)
    // Geonames folders are ISO2 (ES, DE, US)
    // We'll build from the countryInfo.txt that was downloaded
    try {
        // countryInfo.txt lives inside the geonames cache root (not in a subfolder)
        // Actually it was downloaded as a .txt not .zip — check if it exists
        // The download script only grabbed .zip files, so countryInfo.txt won't be there.
        // Use a hardcoded map for the most common codes.
    } catch { /* ignore */ }
}

// Comprehensive ISO 3166-1 alpha-3 → alpha-2 mapping
// GeoNames folders use alpha-2, GADM GIDs use alpha-3
export const GID_PREFIX_TO_CC: Record<string, string> = {
    AFG: 'AF', ALB: 'AL', DZA: 'DZ', AND: 'AD', AGO: 'AO', ATG: 'AG', ARG: 'AR',
    ARM: 'AM', AUS: 'AU', AUT: 'AT', AZE: 'AZ', BHS: 'BS', BHR: 'BH', BGD: 'BD',
    BRB: 'BB', BLR: 'BY', BEL: 'BE', BLZ: 'BZ', BEN: 'BJ', BTN: 'BT', BOL: 'BO',
    BIH: 'BA', BWA: 'BW', BRA: 'BR', BRN: 'BN', BGR: 'BG', BFA: 'BF', BDI: 'BI',
    KHM: 'KH', CMR: 'CM', CAN: 'CA', CPV: 'CV', CAF: 'CF', TCD: 'TD', CHL: 'CL',
    CHN: 'CN', COL: 'CO', COM: 'KM', COG: 'CG', COD: 'CD', CRI: 'CR', CIV: 'CI',
    HRV: 'HR', CUB: 'CU', CYP: 'CY', CZE: 'CZ', DNK: 'DK', DJI: 'DJ', DMA: 'DM',
    DOM: 'DO', ECU: 'EC', EGY: 'EG', SLV: 'SV', GNQ: 'GQ', ERI: 'ER', EST: 'EE',
    ETH: 'ET', FJI: 'FJ', FIN: 'FI', FRA: 'FR', GAB: 'GA', GMB: 'GM', GEO: 'GE',
    DEU: 'DE', GHA: 'GH', GRC: 'GR', GRD: 'GD', GTM: 'GT', GIN: 'GN', GNB: 'GW',
    GUY: 'GY', HTI: 'HT', HND: 'HN', HUN: 'HU', ISL: 'IS', IND: 'IN', IDN: 'ID',
    IRN: 'IR', IRQ: 'IQ', IRL: 'IE', ISR: 'IL', ITA: 'IT', JAM: 'JM', JPN: 'JP',
    JOR: 'JO', KAZ: 'KZ', KEN: 'KE', KIR: 'KI', PRK: 'KP', KOR: 'KR', KWT: 'KW',
    KGZ: 'KG', LAO: 'LA', LVA: 'LV', LBN: 'LB', LSO: 'LS', LBR: 'LR', LBY: 'LY',
    LIE: 'LI', LTU: 'LT', LUX: 'LU', MKD: 'MK', MDG: 'MG', MWI: 'MW', MYS: 'MY',
    MDV: 'MV', MLI: 'ML', MLT: 'MT', MHL: 'MH', MRT: 'MR', MUS: 'MU', MEX: 'MX',
    FSM: 'FM', MDA: 'MD', MCO: 'MC', MNG: 'MN', MNE: 'ME', MAR: 'MA', MOZ: 'MZ',
    MMR: 'MM', NAM: 'NA', NRU: 'NR', NPL: 'NP', NLD: 'NL', NZL: 'NZ', NIC: 'NI',
    NER: 'NE', NGA: 'NG', NOR: 'NO', OMN: 'OM', PAK: 'PK', PLW: 'PW', PAN: 'PA',
    PNG: 'PG', PRY: 'PY', PER: 'PE', PHL: 'PH', POL: 'PL', PRT: 'PT', QAT: 'QA',
    ROU: 'RO', RUS: 'RU', RWA: 'RW', KNA: 'KN', LCA: 'LC', VCT: 'VC', WSM: 'WS',
    SMR: 'SM', STP: 'ST', SAU: 'SA', SEN: 'SN', SRB: 'RS', SYC: 'SC', SLE: 'SL',
    SGP: 'SG', SVK: 'SK', SVN: 'SI', SLB: 'SB', SOM: 'SO', ZAF: 'ZA', ESP: 'ES',
    LKA: 'LK', SDN: 'SD', SUR: 'SR', SWZ: 'SZ', SWE: 'SE', CHE: 'CH', SYR: 'SY',
    TWN: 'TW', TJK: 'TJ', TZA: 'TZ', THA: 'TH', TLS: 'TL', TGO: 'TG', TON: 'TO',
    TTO: 'TT', TUN: 'TN', TUR: 'TR', TKM: 'TM', TUV: 'TV', UGA: 'UG', UKR: 'UA',
    ARE: 'AE', GBR: 'GB', USA: 'US', URY: 'UY', UZB: 'UZ', VUT: 'VU', VEN: 'VE',
    VNM: 'VN', YEM: 'YE', ZMB: 'ZM', ZWE: 'ZW', SSD: 'SS', XKO: 'XK', PSE: 'PS',
    HKG: 'HK', MAC: 'MO', PRI: 'PR', SJM: 'SJ', ESH: 'EH', ATA: 'AQ',
};

export function gidToCountryCode(gid: string): string | null {
    const prefix = gid.split('.')[0]; // e.g. "ESP" from "ESP.6.1.1_1"
    return GID_PREFIX_TO_CC[prefix] || null;
}

// ────────── Loader ──────────

// Column indices in geonames dump (0-indexed):
// 0:geonameid 1:name 2:asciiname 3:alternatenames 4:lat 5:lon
// 6:feature_class 7:feature_code 8:country_code 9:cc2
// 10:admin1 11:admin2 12:admin3 13:admin4
// 14:population 15:elevation 16:dem 17:timezone 18:modification_date

export function loadGeoNamesForCountry(countryCode: string): GeoNameEntry[] {
    const cc = countryCode.toUpperCase();
    if (countryCache.has(cc)) return countryCache.get(cc)!;

    const filePath = path.join(CACHE_DIR, cc, `${cc}.txt`);
    if (!fs.existsSync(filePath)) {
        return [];
    }

    const raw = fs.readFileSync(filePath, 'utf-8');
    const entries: GeoNameEntry[] = [];

    for (const line of raw.split('\n')) {
        if (!line.trim()) continue;
        const cols = line.split('\t');
        if (cols.length < 17) continue;

        const pop = parseInt(cols[14], 10) || 0;
        const elev = cols[15] ? parseInt(cols[15], 10) : null;
        const dem = parseInt(cols[16], 10) || 0;

        entries.push({
            id: parseInt(cols[0], 10),
            name: cols[1],
            lat: parseFloat(cols[4]),
            lon: parseFloat(cols[5]),
            featureClass: cols[6],
            featureCode: cols[7],
            countryCode: cols[8],
            population: pop,
            elevation: elev !== null && !isNaN(elev) ? elev : null,
            dem,
        });
    }

    countryCache.set(cc, entries);
    return entries;
}

// ────────── Stats Query ──────────

export function getStatsForBBox(
    countryCode: string,
    bbox: [number, number, number, number], // [minLon, minLat, maxLon, maxLat]
): AreaStats {
    const [minLon, minLat, maxLon, maxLat] = bbox;
    const entries = loadGeoNamesForCountry(countryCode);

    let totalPop = 0;
    let placeCount = 0;
    let elevSum = 0;
    let elevCount = 0;
    let minElev = Infinity;
    let maxElev = -Infinity;

    for (const e of entries) {
        if (e.lat >= minLat && e.lat <= maxLat && e.lon >= minLon && e.lon <= maxLon) {
            // Only count populated places (feature class P) for population
            if (e.featureClass === 'P') {
                totalPop += e.population;
                placeCount++;
            }

            // Elevation: use dem as fallback, skip sentinel -9999
            const elev = e.elevation ?? e.dem;
            if (elev !== null && elev !== -9999) {
                elevSum += elev;
                elevCount++;
                if (elev < minElev) minElev = elev;
                if (elev > maxElev) maxElev = elev;
            }
        }
    }

    return {
        totalPopulation: totalPop,
        placeCount,
        avgElevation: elevCount > 0 ? Math.round(elevSum / elevCount) : 0,
        minElevation: minElev === Infinity ? 0 : minElev,
        maxElevation: maxElev === -Infinity ? 0 : maxElev,
    };
}
