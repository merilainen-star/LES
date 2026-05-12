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

const LES_DEFAULT_PRODUCT_CARD_PPT_SETTINGS = {
    bannerColor: '#B5121B',
    labels: {
        item: 'Item',
        description: 'Description',
        specifications: 'Specifications'
    },
    linkFormat: {
        tokens: [{ type: 'url' }]
    }
};

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
        ['item', 'description', 'specifications'].forEach(key => {
            if (typeof raw.labels[key] === 'string' && raw.labels[key].trim()) {
                out.labels[key] = raw.labels[key].trim().slice(0, 40);
            }
        });
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
    globalThis.LES_COUNTRY_CODES = LES_COUNTRY_CODES;
    globalThis.lesMergeSettings = lesMergeSettings;
    globalThis.lesRenderCopyFormat = lesRenderCopyFormat;
    globalThis.lesEscapeHtmlForCopy = lesEscapeHtmlForCopy;
    globalThis.lesCountryForHost = lesCountryForHost;
    globalThis.lesCloneFormat = lesCloneFormat;
    globalThis.lesCloneProductCardPptSettings = lesCloneProductCardPptSettings;
}
