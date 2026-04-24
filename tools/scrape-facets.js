#!/usr/bin/env node
// tools/scrape-facets.js
// Crawls Lekolar category landing pages, parses their facet sidebars, and
// rewrites LekolarEnhancer/facetVocabulary.js with real, up-to-date values.
//
// Usage:
//   cd tools
//   npm install
//   node scrape-facets.js
//
// Requires Node 18+ (for built-in fetch).

const fs = require('fs');
const path = require('path');

// Category friendly name -> Lekolar landing page URL.
// Must match keys used by categoryClassifier.js and facetVocabulary.js.
const CATEGORY_URLS = {
    'pöytä':       'https://www.lekolar.fi/verkkokauppa/kaluste-sisustusvalikoima/poydat/',
    'tuoli':       'https://www.lekolar.fi/verkkokauppa/kaluste-sisustusvalikoima/tuolit-jakkarat/',
    'säilytys':    'https://www.lekolar.fi/verkkokauppa/kaluste-sisustusvalikoima/sailytys/',
    'sohva':       'https://www.lekolar.fi/verkkokauppa/kaluste-sisustusvalikoima/sohvat-nojatuolit-ja-rahit/',
    'toimisto':    'https://www.lekolar.fi/verkkokauppa/kaluste-sisustusvalikoima/toimistokalusteet/',
    'kaappi':      'https://www.lekolar.fi/verkkokauppa/kaluste-sisustusvalikoima/vaate-ja-koulukaapit/',
    'tilanjakaja': 'https://www.lekolar.fi/verkkokauppa/kaluste-sisustusvalikoima/aanenvaimennus-ja-tilanjakajat/',
    'taulu':       'https://www.lekolar.fi/verkkokauppa/kaluste-sisustusvalikoima/peilit-valkotaulut-ja-ilmoitustaulut/'
};

// Lekolar internal field name -> friendly key exposed to the AI.
// Must stay in sync with PIM_TO_FACET_MAP (LekolarEnhancer/searchUtils.js).
// Fields not in this map are dropped from the vocabulary — add entries here
// only for facets the AI prompt actually uses.
const FIELD_TO_FRIENDLY = {
    itemLength_cm:    'length',
    itemWidth_cm:     'width',
    itemHeight_cm:    'height',
    itemDepth_cm:     'depth',
    itemDiameter_cm:  'diameter',
    itemseatheight_cm:'seatHeight',
    itemcolortext:    'color',
    itemmaterialfurniture: 'material',
    itemlegmaterial:  'legMaterial',
    itemtabletopshape:'shape',
    prodecolabelling: 'ecolabel',
    toxicfree:        'toxicFree',
    grades:           'grade',
    product_included_in_series: 'series',
    itemheightadjustable: 'heightAdjustable',
    silent:               'silent',
    itemcolorcoderalcvl:  'ralColor',
    itemcolorcodencscvl:  'ncsColor'
};

// Numeric facets are free-form — we still collect values for reference but
// don't emit them into the vocab file (the AI is told "any number in cm").
const NUMERIC_FIELDS = new Set([
    'itemLength_cm', 'itemWidth_cm', 'itemHeight_cm', 'itemDepth_cm',
    'itemDiameter_cm', 'itemseatheight_cm'
]);

// `series` values are product-family names — hundreds of them. Keeping them
// in the prompt would blow up token count without improving recall, so skip.
const SKIP_FRIENDLY_IN_PROMPT = new Set(['series']);

async function fetchHtml(url) {
    const res = await fetch(url, {
        headers: {
            'User-Agent': 'LekolarEnhancer facet-scraper (github:antigravity/LES)',
            'Accept-Language': 'fi-FI,fi;q=0.9,en;q=0.5'
        }
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    return res.text();
}

// HTML entity decoder — Lekolar's input attributes encode non-ASCII as numeric
// entities (e.g. &#228; for ä, &#246; for ö), so we need numeric decoding.
// Do numeric first, then named, to avoid double-replacing.
function decodeEntities(s) {
    return s
        .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
        .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&nbsp;/g, ' ');
}

// Pull every <input ...> tag. Attribute order isn't guaranteed, so we parse
// each tag body into an attribute map rather than writing a monolithic regex.
function parseFacetsFromHtml(html) {
    const inputRe = /<input\b([^>]*)>/gi;
    const attrRe = /\b([a-zA-Z_:][a-zA-Z0-9_:.-]*)\s*=\s*"([^"]*)"/g;
    const byField = {};
    let m;
    while ((m = inputRe.exec(html)) !== null) {
        const body = m[1];
        const attrs = {};
        let a;
        attrRe.lastIndex = 0;
        while ((a = attrRe.exec(body)) !== null) {
            attrs[a[1].toLowerCase()] = a[2];
        }
        const field = attrs['data-field'];
        if (!field) continue;
        const value = attrs['data-value'] || attrs['value'];
        if (!value) continue;
        if (!byField[field]) byField[field] = new Set();
        byField[field].add(decodeEntities(value));
    }
    return byField;
}

function toVocabEntry(byField) {
    const out = {};
    for (const [field, valuesSet] of Object.entries(byField)) {
        const friendly = FIELD_TO_FRIENDLY[field];
        if (!friendly) continue;                          // unmapped → drop
        if (NUMERIC_FIELDS.has(field)) continue;          // numeric → free-form
        if (SKIP_FRIENDLY_IN_PROMPT.has(friendly)) continue;
        const values = Array.from(valuesSet).sort((a, b) => a.localeCompare(b, 'fi'));
        if (values.length === 0) continue;
        out[friendly] = values;
    }
    return out;
}

function mergeDefault(vocab) {
    const defaultEntry = {};
    for (const cat of Object.values(vocab)) {
        for (const [key, values] of Object.entries(cat)) {
            if (!defaultEntry[key]) defaultEntry[key] = new Set();
            values.forEach(v => defaultEntry[key].add(v));
        }
    }
    const out = {};
    for (const [k, set] of Object.entries(defaultEntry)) {
        out[k] = Array.from(set).sort((a, b) => a.localeCompare(b, 'fi'));
    }
    return out;
}

function emitVocabFile(vocab, meta) {
    const lines = [
        '// facetVocabulary.js — AUTO-GENERATED by tools/scrape-facets.js.',
        `// Last crawl: ${meta.generatedAt}`,
        `// Source pages:`,
        ...Object.entries(meta.sources).map(([cat, url]) => `//   ${cat}: ${url}`),
        '//',
        '// To refresh, run:  cd tools && node scrape-facets.js',
        '',
        'const LES_FACET_VOCABULARY = ' + JSON.stringify(vocab, null, 4) + ';',
        '',
        'const LES_FACET_VOCABULARY_GLOBAL =',
        "    typeof globalThis !== 'undefined'",
        '        ? globalThis',
        "        : (typeof self !== 'undefined' ? self : (typeof window !== 'undefined' ? window : null));",
        '',
        "if (typeof module !== 'undefined' && module.exports) {",
        '    module.exports = { LES_FACET_VOCABULARY };',
        '} else if (LES_FACET_VOCABULARY_GLOBAL) {',
        '    LES_FACET_VOCABULARY_GLOBAL.LES_FACET_VOCABULARY = LES_FACET_VOCABULARY;',
        '}',
        ''
    ];
    return lines.join('\n');
}

async function main() {
    const vocab = {};
    const skipped = {};

    for (const [category, url] of Object.entries(CATEGORY_URLS)) {
        process.stderr.write(`[${category}] ${url}\n`);
        try {
            const html = await fetchHtml(url);
            const byField = parseFacetsFromHtml(html);
            const foundFields = Object.keys(byField);
            const entry = toVocabEntry(byField);
            vocab[category] = entry;

            const dropped = foundFields.filter(f => !FIELD_TO_FRIENDLY[f]);
            if (dropped.length) skipped[category] = dropped;

            const keyCount = Object.keys(entry).length;
            const valueCount = Object.values(entry).reduce((n, v) => n + v.length, 0);
            process.stderr.write(`  -> ${keyCount} facet keys, ${valueCount} values\n`);
        } catch (e) {
            process.stderr.write(`  FAILED: ${e.message}\n`);
            vocab[category] = {};
        }
    }

    vocab._default = mergeDefault(vocab);

    const meta = {
        generatedAt: new Date().toISOString(),
        sources: CATEGORY_URLS
    };

    const out = emitVocabFile(vocab, meta);
    const target = path.resolve(__dirname, '..', 'LekolarEnhancer', 'facetVocabulary.js');
    fs.writeFileSync(target, out, 'utf8');
    process.stderr.write(`\nWrote ${target}\n`);

    if (Object.keys(skipped).length) {
        process.stderr.write('\nUnmapped facets (add to FIELD_TO_FRIENDLY if useful):\n');
        for (const [cat, fields] of Object.entries(skipped)) {
            process.stderr.write(`  ${cat}: ${fields.join(', ')}\n`);
        }
    }
}

main().catch(e => {
    console.error(e);
    process.exit(1);
});
