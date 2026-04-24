// searchUtils.js - Helper for building Lekolar faceted search URLs

// Lekolar multi-value facet syntax differs by type:
//   - Numeric facets use ¤-joined values inside a single `facet=` param (renders as a range, e.g. "Pituus (cm): 60 - 80").
//   - Enum facets use repeated `facet=field:value` params (one per value).
const NUMERIC_FACET_KEYS = new Set(['length', 'width', 'height', 'depth', 'diameter', 'seatHeight']);
const LEKOLAR_MULTIVALUE_SEPARATOR = '\u00A4';

const PIM_TO_FACET_MAP = {
    length: 'itemLength_cm',
    width: 'itemWidth_cm',
    height: 'itemHeight_cm',
    depth: 'itemDepth_cm',
    diameter: 'itemDiameter_cm',
    seatHeight: 'itemseatheight_cm',
    
    // Explicitly ignore these as Lekolar backend does not support them as facets
    seatWidth: null,
    seatDepth: null,

    color: 'itemcolortext',
    material: 'itemmaterialfurniture',
    legMaterial: 'itemlegmaterial',
    shape: 'itemtabletopshape',
    
    ecolabel: 'prodecolabelling',
    toxicFree: 'toxicfree',
    grade: 'grades',
    series: 'product_included_in_series'
};

/**
 * Builds a Lekolar search URL with optional facet parameters.
 * @param {string} baseUrl - e.g., 'https://www.lekolar.fi/haku/'
 * @param {string} query - Main search term (e.g., 'tuoli')
 * @param {Object} filters - Dictionary of PIM keys to values (e.g., { color: 'Musta' })
 * @returns {string} - The constructed URL
 */
function buildLekolarSearchUrl(baseUrl, query, filters = {}) {
    // Ensure baseUrl ends properly before params
    const separator = baseUrl.includes('?') ? '&' : '?';
    let url = baseUrl;
    if (query) {
        url += `${separator}query=${encodeURIComponent(query)}`;
    } else if (separator === '?') {
        url += '?';
    }

    const params = [];

    const normalizeOne = (v) => {
        if (v === null || v === undefined) return '';
        const s = String(v).trim();
        return s ? s.replace(',', '.') : '';
    };

    // Convert friendly filter keys to Lekolar ?facet= format
    for (const [key, value] of Object.entries(filters)) {
        if (value === null || value === undefined || value === '') continue;

        let facetField = PIM_TO_FACET_MAP[key];
        if (facetField === null) continue; // Explicitly ignored fields
        if (facetField === undefined) facetField = key; // Fallback

        const rawValues = Array.isArray(value) ? value : [value];
        const values = rawValues.map(normalizeOne).filter(v => v !== '');
        if (values.length === 0) continue;

        if (NUMERIC_FACET_KEYS.has(key)) {
            const joined = values.join(LEKOLAR_MULTIVALUE_SEPARATOR);
            params.push(`facet=${encodeURIComponent(facetField + ':' + joined)}`);
        } else {
            for (const v of values) {
                params.push(`facet=${encodeURIComponent(facetField + ':' + v)}`);
            }
        }
    }

    if (params.length > 0) {
        const joinStr = url.includes('?') ? (url.endsWith('?') ? '' : '&') : '?';
        url += joinStr + params.join('&');
    }

    return url;
}

// Export for module usage, and expose helpers on whichever global scope exists.
const SEARCH_UTILS_GLOBAL =
    typeof globalThis !== 'undefined'
        ? globalThis
        : (typeof self !== 'undefined' ? self : (typeof window !== 'undefined' ? window : null));

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { buildLekolarSearchUrl, PIM_TO_FACET_MAP, NUMERIC_FACET_KEYS };
} else if (SEARCH_UTILS_GLOBAL) {
    SEARCH_UTILS_GLOBAL.buildLekolarSearchUrl = buildLekolarSearchUrl;
    SEARCH_UTILS_GLOBAL.PIM_TO_FACET_MAP = PIM_TO_FACET_MAP;
    SEARCH_UTILS_GLOBAL.NUMERIC_FACET_KEYS = NUMERIC_FACET_KEYS;
}
