// defaults.js — Single source of truth for settings shape, defaults,
// and the copy-format token renderer. Loaded by background.js (service
// worker), content.js (content script world), and the popup/options pages.

const LES_DEFAULT_FORMATS = {
    default: {
        label: 'Default',
        asLink: false,
        tokens: [{ type: 'value' }]
    },
    primary: {
        label: 'With link',
        asLink: true,
        tokens: [
            { type: 'number' },
            { type: 'literal', value: ' ' },
            { type: 'name' },
            { type: 'literal', value: ' - ' },
            { type: 'url' }
        ]
    },
    secondary: {
        label: 'Number + name',
        asLink: false,
        tokens: [
            { type: 'number' },
            { type: 'literal', value: ' ' },
            { type: 'name' }
        ]
    }
};

// Slide layout template (centimeters; slide is 33.867 x 19.05 cm — LAYOUT_WIDE).
// Used by both content.js and background.js to position blocks on the
// product-card slide, and by options.js to render the layout editor.
// Values are stored in cm and converted to inches at PPT generation (cmToIn).
// Font sizes stay in points (pt); padding is in cm.
const LES_DEFAULT_PRODUCT_CARD_PPT_TEMPLATE = {
    unit: 'cm',
    background: '#FFFFFF',
    banner: { h: 2.18 },
    blocks: {
        title:      { x: 1.14,  y: 0.30,  w: 21.97, h: 1.57,  fontSize: 23 },
        sku:        { x: 23.50, y: 0.51,  w: 8.76,  h: 1.12,  fontSize: 12 },
        image:      { x: 1.40,  y: 3.43,  w: 13.08, h: 11.81, pad: 0.25 },
        descLabel:  { x: 15.37, y: 3.05,  w: 16.89, h: 0.71,  fontSize: 12 },
        desc:       { x: 15.37, y: 3.94,  w: 16.89, h: 3.76,  fontSize: 11 },
        specsLabel: { x: 15.37, y: 8.20,  w: 16.89, h: 0.71,  fontSize: 12 },
        specs:      { x: 15.37, y: 9.09,  w: 16.89, h: 5.79,  fontSize: 9.5 },
        link:       { x: 1.40,  y: 15.70, w: 30.86, h: 0.97,  fontSize: 8 },
        departmentLabel: { x: 15.35, y: 17.10, w: 3.10, h: 0.34, fontSize: 8 },
        department:      { x: 15.35, y: 17.48, w: 8.80, h: 0.50, fontSize: 10 }
    },
    footer: {
        envLogos:    { y: 17.22, h: 0.97, slotW: 2.67, startX: 1.40, maxRight: 14.61, gap: 0.41 },
        lekolarLogo: { rightX: 32.26, y: 17.22, w: 3.80, h: 0.85 }
    }
};

const LES_PRODUCT_CARD_PPT_TEMPLATE_BLOCKS = [
    'title', 'sku', 'image', 'descLabel', 'desc', 'specsLabel', 'specs', 'link', 'departmentLabel', 'department'
];

const LES_DEFAULT_PRODUCT_CARD_PPT_SETTINGS = {
    bannerColor: '#B5121B',
    labels: {
        item: 'Item',
        description: 'Description',
        specifications: 'Specifications',
        department: 'Department'
    },
    showDepartment: true,
    linkFormat: {
        tokens: [{ type: 'url' }]
    },
    template: LES_DEFAULT_PRODUCT_CARD_PPT_TEMPLATE
};

// Slide dimensions in centimeters (LAYOUT_WIDE = 13.333 x 7.5 in = 33.867 x 19.05 cm).
const LES_PRODUCT_CARD_SLIDE_W = 33.867;
const LES_PRODUCT_CARD_SLIDE_H = 19.05;
const LES_CM_PER_INCH = 2.54;

function lesIsFiniteNumber(v) {
    return typeof v === 'number' && isFinite(v);
}

function lesCmToIn(v) {
    return v / LES_CM_PER_INCH;
}

function lesClampCm(v, min, max) {
    if (!lesIsFiniteNumber(v)) return null;
    if (v < min) return min;
    if (v > max) return max;
    return Math.round(v * 100) / 100;
}

function lesNormalizeBlock(raw, def, opts) {
    const out = { ...def };
    if (!raw || typeof raw !== 'object') return out;
    const slideW = LES_PRODUCT_CARD_SLIDE_W;
    const slideH = LES_PRODUCT_CARD_SLIDE_H;
    const fields = [
        { key: 'x', min: 0, max: slideW },
        { key: 'y', min: 0, max: slideH },
        { key: 'w', min: 0.2, max: slideW },
        { key: 'h', min: 0.2, max: slideH }
    ];
    for (const f of fields) {
        const c = lesClampCm(raw[f.key], f.min, f.max);
        if (c !== null) out[f.key] = c;
    }
    if (opts && opts.fontSize && lesIsFiniteNumber(raw.fontSize)) {
        out.fontSize = Math.max(4, Math.min(96, Math.round(raw.fontSize * 10) / 10));
    }
    if (opts && opts.pad && lesIsFiniteNumber(raw.pad)) {
        out.pad = Math.max(0, Math.min(5, Math.round(raw.pad * 100) / 100));
    }
    return out;
}

// Pre-cm-migration templates stored x/y/w/h/pad/banner.h/footer.* in inches.
// Detect via missing `unit: 'cm'` marker and scale numerics up by 2.54.
function lesScaleRawTemplateFromInches(raw) {
    if (!raw || typeof raw !== 'object') return raw;
    const r = JSON.parse(JSON.stringify(raw));
    const s = LES_CM_PER_INCH;
    if (r.banner && lesIsFiniteNumber(r.banner.h)) r.banner.h *= s;
    if (r.blocks && typeof r.blocks === 'object') {
        for (const k of Object.keys(r.blocks)) {
            const b = r.blocks[k];
            if (!b || typeof b !== 'object') continue;
            ['x', 'y', 'w', 'h', 'pad'].forEach(f => {
                if (lesIsFiniteNumber(b[f])) b[f] *= s;
            });
        }
    }
    if (r.footer && typeof r.footer === 'object') {
        for (const fkey of ['envLogos', 'lekolarLogo']) {
            const f = r.footer[fkey];
            if (!f || typeof f !== 'object') continue;
            for (const fld of Object.keys(f)) {
                if (lesIsFiniteNumber(f[fld])) f[fld] *= s;
            }
        }
    }
    return r;
}

function lesCloneProductCardPptTemplate(raw) {
    const def = LES_DEFAULT_PRODUCT_CARD_PPT_TEMPLATE;
    const out = JSON.parse(JSON.stringify(def));
    if (!raw || typeof raw !== 'object') return out;
    if (raw.unit !== 'cm') raw = lesScaleRawTemplateFromInches(raw);

    if (typeof raw.background === 'string' && /^#[0-9a-f]{6}$/i.test(raw.background.trim())) {
        out.background = raw.background.trim();
    }
    if (raw.banner && lesIsFiniteNumber(raw.banner.h)) {
        const h = lesClampCm(raw.banner.h, 0.2, LES_PRODUCT_CARD_SLIDE_H);
        if (h !== null) out.banner.h = h;
    }
    if (raw.blocks && typeof raw.blocks === 'object') {
        for (const key of LES_PRODUCT_CARD_PPT_TEMPLATE_BLOCKS) {
            const opts = { fontSize: key !== 'image', pad: key === 'image' };
            out.blocks[key] = lesNormalizeBlock(raw.blocks[key], def.blocks[key], opts);
        }
    }
    if (raw.footer && typeof raw.footer === 'object') {
        if (raw.footer.envLogos && typeof raw.footer.envLogos === 'object') {
            const e = raw.footer.envLogos;
            const d = def.footer.envLogos;
            const merged = { ...d };
            for (const [k, v] of Object.entries(e)) {
                if (lesIsFiniteNumber(v)) merged[k] = Math.round(v * 100) / 100;
            }
            out.footer.envLogos = merged;
        }
        if (raw.footer.lekolarLogo && typeof raw.footer.lekolarLogo === 'object') {
            const l = raw.footer.lekolarLogo;
            const d = def.footer.lekolarLogo;
            const merged = { ...d };
            for (const [k, v] of Object.entries(l)) {
                if (lesIsFiniteNumber(v)) merged[k] = Math.round(v * 100) / 100;
            }
            out.footer.lekolarLogo = merged;
        }
    }
    return out;
}

const LES_DEFAULT_SETTINGS = {
    // Master switch
    extensionEnabled: true,
    // Per-country activation for content scripts
    enabledCountries: { fi: true, se: true, no: true, dk: true },
    // Feature toggles
    infiniteScroll: true,
    copyButtons: true,
    hideEnvironmentalLogo: false,
    productLayoutDivider: true,
    variantHints: true,
    priceAdjustmentEnabled: false,
    priceAdjustmentPercent: 0,
    priceAdjustmentHighlightColor: '#fff3bf',
    productCardPpt: LES_DEFAULT_PRODUCT_CARD_PPT_SETTINGS,
    // Copy format presets bound to modifier slots
    modifierKey: 'shiftKey',
    secondaryModifierKey: 'ctrlKey',
    copyShortcutAltDefaultMigrated: true,
    copyFormats: LES_DEFAULT_FORMATS,
    // Omnibox configuration (preferred country + per-country base URLs)
    countries: {
        fi: { enabled: true, url: 'https://www.lekolar.fi/haku/?query=' },
        se: { enabled: false, url: 'https://www.lekolar.se/sok/?query=' },
        no: { enabled: false, url: 'https://www.lekolar.no/sok/?query=' },
        dk: { enabled: false, url: 'https://www.lekolar.dk/sog/?query=' }
    },
    // Beta features (AI search)
    aiBetaEnabled: false,
    externalServicesConsent: false,
    aiProvider: 'openai',
    aiModels: { openai: '', anthropic: '', gemini: '' },
    aiAdvanced: { temperature: 0, maxTokens: 600 },
    // Diagnostics
    debugLogging: false,
    // Bookkeeping for "What's new" badge
    lastSeenVersion: ''
};

const LES_COUNTRY_CODES = ['fi', 'se', 'no', 'dk'];

function lesCloneFormat(fmt) {
    if (!fmt || typeof fmt !== 'object') return null;
    return {
        label: typeof fmt.label === 'string' ? fmt.label : '',
        asLink: !!fmt.asLink,
        tokens: Array.isArray(fmt.tokens)
            ? fmt.tokens.filter(t => t && typeof t === 'object').map(t => (
                t.type === 'literal'
                    ? { type: 'literal', value: typeof t.value === 'string' ? t.value : '' }
                    : { type: t.type }
            ))
            : []
    };
}

function lesCloneProductCardPptSettings(raw) {
    const out = JSON.parse(JSON.stringify(LES_DEFAULT_PRODUCT_CARD_PPT_SETTINGS));
    if (!raw || typeof raw !== 'object') return out;

    if (typeof raw.bannerColor === 'string' && /^#[0-9a-f]{6}$/i.test(raw.bannerColor.trim())) {
        out.bannerColor = raw.bannerColor.trim();
    }

    if (raw.labels && typeof raw.labels === 'object') {
        ['item', 'description', 'specifications', 'department'].forEach(key => {
            if (typeof raw.labels[key] === 'string' && raw.labels[key].trim()) {
                out.labels[key] = raw.labels[key].trim().slice(0, 40);
            }
        });
    }

    if (typeof raw.showDepartment === 'boolean') {
        out.showDepartment = raw.showDepartment;
    }

    const linkFormat = raw.linkFormat && typeof raw.linkFormat === 'object'
        ? raw.linkFormat
        : {};
    const clonedLink = lesCloneFormat({
        label: '',
        asLink: false,
        tokens: linkFormat.tokens
    });
    if (clonedLink && clonedLink.tokens.length > 0) {
        out.linkFormat.tokens = clonedLink.tokens;
    }

    out.template = lesCloneProductCardPptTemplate(raw.template);

    return out;
}

// Merge stored settings on top of defaults, surviving renames and partial writes.
function lesMergeSettings(stored) {
    const out = JSON.parse(JSON.stringify(LES_DEFAULT_SETTINGS));
    if (!stored || typeof stored !== 'object') return out;
    for (const key of Object.keys(out)) {
        if (stored[key] === undefined || stored[key] === null) continue;
        if (key === 'countries') {
            for (const c of LES_COUNTRY_CODES) {
                if (stored.countries && stored.countries[c]) {
                    out.countries[c] = { ...out.countries[c], ...stored.countries[c] };
                }
            }
        } else if (key === 'enabledCountries') {
            for (const c of LES_COUNTRY_CODES) {
                if (typeof stored.enabledCountries[c] === 'boolean') {
                    out.enabledCountries[c] = stored.enabledCountries[c];
                }
            }
        } else if (key === 'copyFormats') {
            for (const slot of ['default', 'primary', 'secondary']) {
                const cloned = lesCloneFormat(stored.copyFormats && stored.copyFormats[slot]);
                if (cloned && cloned.tokens.length > 0) {
                    out.copyFormats[slot] = cloned;
                }
            }
        } else if (key === 'productCardPpt') {
            out.productCardPpt = lesCloneProductCardPptSettings(stored.productCardPpt);
        } else if (key === 'aiModels') {
            for (const p of ['openai', 'anthropic', 'gemini']) {
                if (typeof stored.aiModels[p] === 'string') {
                    out.aiModels[p] = stored.aiModels[p];
                }
            }
        } else if (key === 'aiAdvanced') {
            if (typeof stored.aiAdvanced.temperature === 'number') {
                out.aiAdvanced.temperature = stored.aiAdvanced.temperature;
            }
            if (typeof stored.aiAdvanced.maxTokens === 'number') {
                out.aiAdvanced.maxTokens = stored.aiAdvanced.maxTokens;
            }
        } else {
            out[key] = stored[key];
        }
    }
    if (stored.secondaryModifierKey === 'altKey' && stored.copyShortcutAltDefaultMigrated !== true) {
        out.secondaryModifierKey = 'ctrlKey';
        out.copyShortcutAltDefaultMigrated = true;
    }
    return out;
}

// Render a format's tokens against a context { number, name, url, value }.
function lesRenderCopyFormat(format, context) {
    if (!format || !Array.isArray(format.tokens)) return '';
    const ctx = context || {};
    const out = [];
    for (const tok of format.tokens) {
        if (!tok || !tok.type) continue;
        if (tok.type === 'literal') {
            out.push(typeof tok.value === 'string' ? tok.value : '');
        } else {
            const v = ctx[tok.type];
            out.push(v == null ? '' : String(v));
        }
    }
    return out.join('');
}

function lesEscapeHtmlForCopy(s) {
    return String(s == null ? '' : s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

// Map a Lekolar hostname to its country code, or null if unknown.
function lesCountryForHost(host) {
    const h = String(host || '').toLowerCase();
    if (h === 'lekolar.fi' || h.endsWith('.lekolar.fi')) return 'fi';
    if (h === 'lekolar.se' || h.endsWith('.lekolar.se')) return 'se';
    if (h === 'lekolar.no' || h.endsWith('.lekolar.no')) return 'no';
    if (h === 'lekolar.dk' || h.endsWith('.lekolar.dk')) return 'dk';
    return null;
}

if (typeof globalThis !== 'undefined') {
    globalThis.LES_DEFAULT_SETTINGS = LES_DEFAULT_SETTINGS;
    globalThis.LES_DEFAULT_FORMATS = LES_DEFAULT_FORMATS;
    globalThis.LES_DEFAULT_PRODUCT_CARD_PPT_SETTINGS = LES_DEFAULT_PRODUCT_CARD_PPT_SETTINGS;
    globalThis.LES_DEFAULT_PRODUCT_CARD_PPT_TEMPLATE = LES_DEFAULT_PRODUCT_CARD_PPT_TEMPLATE;
    globalThis.LES_PRODUCT_CARD_PPT_TEMPLATE_BLOCKS = LES_PRODUCT_CARD_PPT_TEMPLATE_BLOCKS;
    globalThis.LES_PRODUCT_CARD_SLIDE_W = LES_PRODUCT_CARD_SLIDE_W;
    globalThis.LES_PRODUCT_CARD_SLIDE_H = LES_PRODUCT_CARD_SLIDE_H;
    globalThis.LES_CM_PER_INCH = LES_CM_PER_INCH;
    globalThis.lesCmToIn = lesCmToIn;
    globalThis.LES_COUNTRY_CODES = LES_COUNTRY_CODES;
    globalThis.lesMergeSettings = lesMergeSettings;
    globalThis.lesRenderCopyFormat = lesRenderCopyFormat;
    globalThis.lesEscapeHtmlForCopy = lesEscapeHtmlForCopy;
    globalThis.lesCountryForHost = lesCountryForHost;
    globalThis.lesCloneFormat = lesCloneFormat;
    globalThis.lesCloneProductCardPptSettings = lesCloneProductCardPptSettings;
    globalThis.lesCloneProductCardPptTemplate = lesCloneProductCardPptTemplate;
}
