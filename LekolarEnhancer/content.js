// content.js
let currentSettings = (typeof lesMergeSettings === 'function')
    ? lesMergeSettings(null)
    : {
        extensionEnabled: true,
        enabledCountries: { fi: true, se: true, no: true, dk: true },
        infiniteScroll: true,
        copyButtons: true,
        hideEnvironmentalLogo: false,
        productLayoutDivider: true,
        variantHints: true,
        priceAdjustmentEnabled: false,
        priceAdjustmentPercent: 0,
        priceAdjustmentHighlightColor: '#fff3bf',
        productCardPpt: (typeof LES_DEFAULT_PRODUCT_CARD_PPT_SETTINGS !== 'undefined') ? LES_DEFAULT_PRODUCT_CARD_PPT_SETTINGS : null,
        modifierKey: 'shiftKey',
        secondaryModifierKey: 'ctrlKey',
        copyShortcutAltDefaultMigrated: true,
        copyFormats: (typeof LES_DEFAULT_FORMATS !== 'undefined') ? LES_DEFAULT_FORMATS : null,
        debugLogging: false
    };
function lesDebugLog() {
    if (currentSettings && currentSettings.debugLogging) {
        // eslint-disable-next-line no-console
        console.log.apply(console, ['[LES]', ...arguments]);
    }
}
console.info('LES content script loaded');

// Master kill switch + per-country gating. Returns true when the content
// script should not mutate the page at all on this host.
function lesContentDisabled() {
    if (!currentSettings || currentSettings.extensionEnabled === false) return true;
    const code = (typeof lesCountryForHost === 'function')
        ? lesCountryForHost(location.hostname)
        : null;
    if (!code) return false;
    if (currentSettings.enabledCountries && currentSettings.enabledCountries[code] === false) {
        return true;
    }
    return false;
}

const SHAREPOINT_PROBE_URL = 'https://lekolarab.sharepoint.com/_api/web/currentuser?$select=Id,Title';
const ENTITLEMENT_CACHE_KEY = 'lesSharePointEntitlement';
const ENTITLEMENT_CACHE_TTL_MS = 3 * 60 * 60 * 1000;
const PRODUCT_NOTES_STORAGE_KEY = 'lesProductNotes';
const PRODUCT_NOTES_USER_KEY = 'lesProductNotesUserName';
const PRODUCT_NOTE_MAX_LENGTH = 500;
const PRODUCT_LAYOUT_STORAGE_KEY = 'lesProductLayoutDivider';
const PRODUCT_LAYOUT_MIN_DETAILS_WIDTH = 260;
const PRODUCT_LAYOUT_MIN_INFO_WIDTH = 300;
const PRODUCT_LAYOUT_HANDLE_WIDTH = 18;

let restrictedFeatureAccess = {
    status: 'unknown',
    entitled: false,
    checkedAt: 0,
    error: null
};
let entitlementCheckInFlight = null;
const swedishReferenceCache = new Map();
let activeProductNameSearchState = null;
let productNotesByKey = {};
let productNotesLoaded = false;
let productNotesLoadPromise = null;
let productNoteUserName = 'Me';
let productLayoutPreference = null;
let productLayoutPreferenceLoaded = false;
let productLayoutPreferenceLoadPromise = null;
const priceAdjustmentOriginalNodes = new WeakMap();

function lesReplaceChildren(element, ...children) {
    if (!element) return;
    while (element.firstChild) element.removeChild(element.firstChild);
    children.forEach(child => {
        if (child === null || child === undefined) return;
        element.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
    });
}

function lesCreateElement(tagName, options = {}, ...children) {
    const element = document.createElement(tagName);
    if (options.className) element.className = options.className;
    if (options.text !== undefined) element.textContent = options.text;
    if (options.type) element.type = options.type;
    if (options.attrs) {
        Object.entries(options.attrs).forEach(([name, value]) => {
            if (value !== null && value !== undefined) element.setAttribute(name, String(value));
        });
    }
    if (options.dataset) {
        Object.entries(options.dataset).forEach(([name, value]) => {
            if (value !== null && value !== undefined) element.dataset[name] = String(value);
        });
    }
    children.forEach(child => {
        if (child === null || child === undefined) return;
        element.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
    });
    return element;
}

function storageSyncGet(defaults) {
    return new Promise((resolve) => chrome.storage.sync.get(defaults, resolve));
}

function storageLocalGet(key) {
    return new Promise((resolve) => chrome.storage.local.get(key, resolve));
}

function storageLocalSet(items) {
    return new Promise((resolve) => chrome.storage.local.set(items, resolve));
}

function storageLocalRemove(key) {
    return new Promise((resolve) => chrome.storage.local.remove(key, resolve));
}

function escapeHtml(str) {
    return String(str).replace(/&/g, '&amp;').replace(/"/g, '&quot;')
        .replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function normalizeWhitespace(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
}

const FALLBACK_SPEC_FACET_MAP = {
    length: 'itemLength_cm',
    width: 'itemWidth_cm',
    height: 'itemHeight_cm',
    depth: 'itemDepth_cm',
    diameter: 'itemDiameter_cm',
    seatHeight: 'itemseatheight_cm',
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

function buildSpecSearchUrl(baseUrl, query, filters = {}) {
    const globalScope = typeof globalThis !== 'undefined' ? globalThis : window;
    if (typeof globalScope.buildLekolarSearchUrl === 'function') {
        return globalScope.buildLekolarSearchUrl(baseUrl, query, filters);
    }

    const separator = baseUrl.includes('?') ? '&' : '?';
    let url = baseUrl;
    if (query) {
        url += `${separator}query=${encodeURIComponent(query)}`;
    } else if (separator === '?') {
        url += '?';
    }

    const params = [];
    for (const [key, value] of Object.entries(filters)) {
        if (!value) continue;

        let facetField = FALLBACK_SPEC_FACET_MAP[key];
        if (facetField === null) continue;
        if (facetField === undefined) facetField = key;

        let processedValue = value;
        if (typeof processedValue === 'string') {
            processedValue = processedValue.replace(',', '.');
        }

        params.push(`facet=${encodeURIComponent(facetField + ':' + processedValue)}`);
    }

    if (params.length > 0) {
        const joinStr = url.includes('?') ? (url.endsWith('?') ? '' : '&') : '?';
        url += joinStr + params.join('&');
    }

    return url;
}

function sanitizeImportedNode(node) {
    if (!node || !node.querySelectorAll) return node;
    node.querySelectorAll('script').forEach(s => s.remove());
    const all = [node, ...node.querySelectorAll('*')];
    for (const el of all) {
        if (!el.attributes) continue;
        for (const attr of Array.from(el.attributes)) {
            if (/^on/i.test(attr.name)) el.removeAttribute(attr.name);
        }
    }
    return node;
}

function canUseRestrictedFeatures() {
    return restrictedFeatureAccess.entitled === true;
}

function getEntitlementCacheTtlMs(status) {
    if (status === 'entitled') return ENTITLEMENT_CACHE_TTL_MS;
    if (status === 'login_required' || status === 'no_access') return 30 * 60 * 1000;
    // Do not cache transient errors.
    return 0;
}

function cleanupRestrictedUi() {
    // Spec search and the SharePoint search button are public-safe (an unauthorized
    // SharePoint click just lands on the login page), so only the price sorter is gated.
    const sortContainer = document.querySelector('.lekolar-sort-container');
    if (sortContainer) sortContainer.remove();

    const sortOverlay = document.getElementById('lekolar-sort-overlay');
    if (sortOverlay) sortOverlay.remove();

    const buttonsBar = document.querySelector('.les-buttons-bar');
    if (buttonsBar && buttonsBar.children.length === 0) {
        buttonsBar.remove();
    }
}

function cleanupSwedishReferenceUi() {
    const referenceBtn = document.querySelector('.les-sv-reference-btn');
    if (referenceBtn) referenceBtn.remove();

    const referencePanel = document.querySelector('.les-sv-reference-panel');
    if (referencePanel) referencePanel.remove();

    const buttonsBar = document.querySelector('.les-buttons-bar');
    if (buttonsBar && buttonsBar.children.length === 0) {
        buttonsBar.remove();
    }
}

async function requestSharePointEntitlement() {
    return new Promise((resolve) => {
        let done = false;
        const finish = (result) => {
            if (done) return;
            done = true;
            clearTimeout(timeoutId);
            resolve(result);
        };

        // Must exceed background.js SHAREPOINT_REQUEST_TIMEOUT_MS so the actual probe
        // result (entitled / login_required / no_access) wins over our local cutoff.
        const timeoutId = setTimeout(() => {
            finish({
                status: 'error',
                entitled: false,
                error: 'probe_timeout',
                checkedAt: Date.now()
            });
        }, 14000);

        try {
            chrome.runtime.sendMessage(
                { action: 'probeSharePointEntitlement', probeUrl: SHAREPOINT_PROBE_URL },
                (response) => {
                    if (chrome.runtime.lastError) {
                        finish({
                            status: 'error',
                            entitled: false,
                            error: chrome.runtime.lastError.message,
                            checkedAt: Date.now()
                        });
                        return;
                    }

                    if (!response || typeof response.entitled !== 'boolean') {
                        finish({
                            status: 'error',
                            entitled: false,
                            error: 'invalid_probe_response',
                            checkedAt: Date.now()
                        });
                        return;
                    }

                    finish(response);
                }
            );
        } catch (error) {
            finish({
                status: 'error',
                entitled: false,
                error: (error && error.message) ? error.message : String(error),
                checkedAt: Date.now()
            });
        }
    });
}

async function resolveRestrictedFeatureAccess(forceRefresh = false) {
    if (!forceRefresh && entitlementCheckInFlight) {
        return entitlementCheckInFlight;
    }

    entitlementCheckInFlight = (async () => {
        const now = Date.now();

        if (!forceRefresh) {
            const cacheData = await storageLocalGet(ENTITLEMENT_CACHE_KEY);
            const cached = cacheData[ENTITLEMENT_CACHE_KEY];
            const cacheTtlMs = cached ? getEntitlementCacheTtlMs(cached.status) : 0;
            if (cached && cacheTtlMs > 0 && typeof cached.checkedAt === 'number' && (now - cached.checkedAt) < cacheTtlMs) {
                restrictedFeatureAccess = cached;
                return restrictedFeatureAccess;
            }
        }

        const probe = await requestSharePointEntitlement();
        restrictedFeatureAccess = {
            status: probe.status || 'error',
            entitled: probe.entitled === true,
            checkedAt: probe.checkedAt || now,
            error: probe.error || null
        };

        const ttlMs = getEntitlementCacheTtlMs(restrictedFeatureAccess.status);
        if (ttlMs > 0) {
            await storageLocalSet({ [ENTITLEMENT_CACHE_KEY]: restrictedFeatureAccess });
        } else {
            await storageLocalRemove(ENTITLEMENT_CACHE_KEY);
        }
        return restrictedFeatureAccess;
    })();

    try {
        return await entitlementCheckInFlight;
    } finally {
        entitlementCheckInFlight = null;
    }
}

function getProductNumber() {
    const existingBtn = document.querySelector('.lekolar-copy-btn[data-type="number"]');
    if (existingBtn && existingBtn.dataset.value) {
        return existingBtn.dataset.value;
    }

    // Check for "Tuotenro:" text pattern
    // Since we are running early, we might need to rely on text content check more often
    // XPath is slow on full document mutation, let's try a simpler check first
    // or just stick to the specific elements usually found

    // Check common locations if possible, but keeping generic robust search
    const xpath = "//*[contains(text(), 'Tuotenro') or contains(text(), 'Art.nr') or contains(text(), 'Varenr')]";
    // evaluate might fail if document body not ready? content_scripts at document_start usually have document element
    if (!document.body) return null;

    try {
        const result = document.evaluate(xpath, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
        for (let i = 0; i < result.snapshotLength; i++) {
            const element = result.snapshotItem(i);
            const text = element.textContent.trim();
            let match = text.match(/(?:Tuotenro|Art\.nr|Varenr)[\.\s:]*\s*([\d-]+)/i);
            if (match) return match[1];

            let next = element.nextSibling;
            while (next && (next.nodeType === 8 || (next.nodeType === 3 && !next.textContent.trim()))) {
                next = next.nextSibling;
            }
            if (next && next.textContent) {
                const nextText = next.textContent.trim();
                const numberMatch = nextText.match(/^:?\s*([\d-]+)/);
                if (numberMatch) return numberMatch[1];
            }
        }
    } catch (e) {
        console.error("LES Error: Failed to find product number", e);
    }
    return null;
}

function extractBaseItemNumber(rawNumber) {
    if (!rawNumber) return null;
    const cleaned = String(rawNumber).trim().replace(/\s+/g, '');
    const match = cleaned.match(/\d+(?:-\d+)?/);
    if (!match) return null;
    return match[0].split('-')[0];
}

function getMainProductNumber() {
    // Restrict lookup to the main product detail area to avoid related/upsell products.
    const productInfoRoot =
        document.querySelector('.product-info') ||
        document.querySelector('.product-page .product-info') ||
        document.querySelector('.product-page-wrapper .product-info') ||
        document.querySelector('.product-page') ||
        document.querySelector('.product-page-wrapper');

    if (productInfoRoot) {
        const numberBtn = productInfoRoot.querySelector('.lekolar-copy-btn[data-type="number"]');
        if (numberBtn && numberBtn.dataset && numberBtn.dataset.value) {
            return numberBtn.dataset.value;
        }

        try {
            const localXPath = ".//*[contains(text(), 'Tuotenro') or contains(text(), 'Art.nr') or contains(text(), 'Varenr')]";
            const result = document.evaluate(localXPath, productInfoRoot, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
            for (let i = 0; i < result.snapshotLength; i++) {
                const element = result.snapshotItem(i);
                const text = (element.textContent || '').trim();
                const match = text.match(/(?:Tuotenro|Art\.nr|Varenr)[\.\s:]*\s*([\d-]+)/i);
                if (match) return match[1];

                let next = element.nextSibling;
                while (next && (next.nodeType === 8 || (next.nodeType === 3 && !(next.textContent || '').trim()))) {
                    next = next.nextSibling;
                }
                if (next && next.textContent) {
                    const numberMatch = next.textContent.trim().match(/^:?\s*([\d-]+)/);
                    if (numberMatch) return numberMatch[1];
                }
            }
        } catch (e) {
            console.error("LES Error: Failed to find main product number", e);
        }
    }

    // Fallback to structured product data if the text search fails.
    const buyInfo = document.querySelector('.product-page-wrapper .buy-info[data-articlenumber], .product-page .buy-info[data-articlenumber], .js-buyInfo[data-articlenumber]');
    if (buyInfo && buyInfo.dataset && buyInfo.dataset.articlenumber) {
        return buyInfo.dataset.articlenumber;
    }

    return getProductNumber();
}

function getProductNameElement() {
    // Only target the main product h1 by looking inside product page wrappers.
    return document.querySelector('.product-info h1, .product-page-wrapper h1, .product-page h1');
}

function getProductNameFromElement(h1) {
    if (!h1) return null;

    const clone = h1.cloneNode(true);
    clone.querySelectorAll('.lekolar-copy-btn, .les-product-name-search-btn, .les-product-note-btn').forEach(el => el.remove());

    const text = normalizeWhitespace(clone.textContent || '');
    return text || normalizeWhitespace(h1.dataset.lesProductName || '') || null;
}

function getProductName() {
    return getProductNameFromElement(getProductNameElement());
}

function createSearchSvg(size = 16) {
    const svgNS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(svgNS, 'svg');
    svg.setAttribute('xmlns', svgNS);
    svg.setAttribute('width', String(size));
    svg.setAttribute('height', String(size));
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '2');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');

    const circle = document.createElementNS(svgNS, 'circle');
    circle.setAttribute('cx', '11');
    circle.setAttribute('cy', '11');
    circle.setAttribute('r', '8');

    const line = document.createElementNS(svgNS, 'line');
    line.setAttribute('x1', '21');
    line.setAttribute('y1', '21');
    line.setAttribute('x2', '16.65');
    line.setAttribute('y2', '16.65');

    svg.appendChild(circle);
    svg.appendChild(line);
    return svg;
}

function getProductNameSearchBaseUrl() {
    const path = window.location.pathname.toLowerCase();
    if (path.includes('/sog/')) return window.location.origin + '/sog/';
    if (path.includes('/sok/')) return window.location.origin + '/sok/';
    if (path.includes('/haku/')) return window.location.origin + '/haku/';

    const host = window.location.hostname.toLowerCase();
    if (host.endsWith('.lekolar.dk')) return window.location.origin + '/sog/';
    if (host.endsWith('.lekolar.se') || host.endsWith('.lekolar.no')) return window.location.origin + '/sok/';
    return window.location.origin + '/haku/';
}

function buildProductNameSearchUrl(query) {
    const baseUrl = getProductNameSearchBaseUrl();
    if (typeof buildSpecSearchUrl === 'function') {
        return buildSpecSearchUrl(baseUrl, query, {});
    }

    const separator = baseUrl.includes('?') ? '&' : '?';
    return `${baseUrl}${separator}query=${encodeURIComponent(query)}`;
}

function normalizeProductNameSearchPhrase(value) {
    return normalizeWhitespace(value)
        .replace(/\s+([,.;:])/g, '$1')
        .replace(/[,.;:]+$/g, '')
        .trim();
}

function tokenizeProductName(name) {
    const tokens = [];
    const re = /(\s+|[^\s]+)/g;
    let match;
    let wordIndex = 0;

    while ((match = re.exec(name)) !== null) {
        const text = match[0];
        if (/^\s+$/.test(text)) {
            tokens.push({ type: 'space', text });
        } else {
            tokens.push({ type: 'word', text, wordIndex });
            wordIndex += 1;
        }
    }

    return tokens;
}

function getProductNamePrefix(tokens, targetWordIndex) {
    let text = '';

    for (const token of tokens) {
        if (token.type === 'word' && token.wordIndex > targetWordIndex) break;
        text += token.text;
    }

    return normalizeProductNameSearchPhrase(text);
}

function setProductNameSearchPreview(state, wordIndex) {
    if (!state || !state.wrapper) return;

    const hasPreview = Number.isInteger(wordIndex);
    state.wrapper.querySelectorAll('.les-name-search-word').forEach(span => {
        const index = Number(span.dataset.wordIndex);
        span.classList.toggle('is-selected', hasPreview && index <= wordIndex);
        span.classList.toggle('is-muted', hasPreview && index > wordIndex);
    });

    const tooltip = state.button ? state.button.querySelector('.tooltip') : null;
    if (!hasPreview) {
        if (state.button) state.button.title = 'Find similar products from name';
        if (tooltip) tooltip.textContent = state.activeTooltip;
        return;
    }

    const query = getProductNamePrefix(state.tokens, wordIndex);
    if (state.button) state.button.title = query ? `Search: ${query}` : 'Find similar products from name';
    if (tooltip) tooltip.textContent = query ? `Search: ${query}` : state.activeTooltip;
}

function openProductNameSearch(query) {
    const normalizedQuery = normalizeProductNameSearchPhrase(query);
    if (!normalizedQuery) return;

    const searchUrl = buildProductNameSearchUrl(normalizedQuery);
    window.open(searchUrl, '_blank', 'noopener,noreferrer');
}

function renderProductNameSearchText(h1, name) {
    const tokens = tokenizeProductName(name);
    const wrapper = document.createElement('span');
    wrapper.className = 'les-product-name-search-text';

    tokens.forEach(token => {
        const span = document.createElement('span');
        span.textContent = token.text;

        if (token.type === 'word') {
            span.className = 'les-name-search-word';
            span.dataset.wordIndex = String(token.wordIndex);
            span.addEventListener('mouseenter', () => {
                if (!activeProductNameSearchState || activeProductNameSearchState.h1 !== h1) return;
                setProductNameSearchPreview(activeProductNameSearchState, token.wordIndex);
            });
            span.addEventListener('click', (e) => {
                if (!activeProductNameSearchState || activeProductNameSearchState.h1 !== h1) return;
                e.preventDefault();
                e.stopPropagation();

                const query = getProductNamePrefix(activeProductNameSearchState.tokens, token.wordIndex);
                openProductNameSearch(query);
                deactivateProductNameSearch();
            });
        } else {
            span.className = 'les-name-search-space';
        }

        wrapper.appendChild(span);
    });

    wrapper.addEventListener('mouseleave', () => {
        if (!activeProductNameSearchState || activeProductNameSearchState.h1 !== h1) return;
        setProductNameSearchPreview(activeProductNameSearchState, null);
    });

    Array.from(h1.childNodes).forEach(node => {
        if (node.nodeType === Node.TEXT_NODE) {
            node.remove();
            return;
        }

        if (node.nodeType !== Node.ELEMENT_NODE) return;
        if (
            node.classList.contains('lekolar-copy-btn') ||
            node.classList.contains('les-product-name-search-btn') ||
            node.classList.contains('les-product-name-actions')
        ) return;
        node.remove();
    });

    const controlGroup = h1.querySelector('.les-product-name-actions');
    if (controlGroup) {
        h1.insertBefore(wrapper, controlGroup.nextSibling);
    } else {
        h1.insertBefore(wrapper, h1.firstChild);
    }

    return { tokens, wrapper };
}

function deactivateProductNameSearch() {
    const state = activeProductNameSearchState;
    if (!state) return;

    setProductNameSearchPreview(state, null);
    state.h1.classList.remove('les-product-name-search-active');
    state.button.classList.remove('is-active');
    state.button.setAttribute('aria-pressed', 'false');

    const tooltip = state.button.querySelector('.tooltip');
    if (tooltip) tooltip.textContent = state.idleTooltip;
    state.button.title = 'Find similar products from name';

    document.removeEventListener('keydown', state.onKeyDown, true);
    document.removeEventListener('click', state.onDocumentClick, true);
    activeProductNameSearchState = null;
}

function activateProductNameSearch(h1, button) {
    const name = getProductNameFromElement(h1);
    if (!name) return;

    if (activeProductNameSearchState && activeProductNameSearchState.h1 === h1) {
        deactivateProductNameSearch();
        return;
    }

    deactivateProductNameSearch();
    h1.dataset.lesProductName = name;

    const rendered = renderProductNameSearchText(h1, name);
    const state = {
        h1,
        button,
        name,
        tokens: rendered.tokens,
        wrapper: rendered.wrapper,
        idleTooltip: 'Find similar products',
        activeTooltip: 'Choose words to search',
        onKeyDown: null,
        onDocumentClick: null
    };

    state.onKeyDown = (e) => {
        if (e.key === 'Escape') deactivateProductNameSearch();
    };

    state.onDocumentClick = (e) => {
        if (h1.contains(e.target) || button.contains(e.target)) return;
        deactivateProductNameSearch();
    };

    activeProductNameSearchState = state;
    h1.classList.add('les-product-name-search-active');
    button.classList.add('is-active');
    button.setAttribute('aria-pressed', 'true');
    button.title = 'Choose words to search';

    const tooltip = button.querySelector('.tooltip');
    if (tooltip) tooltip.textContent = state.activeTooltip;

    document.addEventListener('keydown', state.onKeyDown, true);
    document.addEventListener('click', state.onDocumentClick, true);
}

function ensureProductNameSearchControl(h1) {
    if (!h1 || isListPage()) return;

    const name = getProductNameFromElement(h1);
    if (!name) return;

    h1.dataset.lesProductName = name;
    h1.classList.add('les-product-name-search-host');

    let controlGroup = h1.querySelector('.les-product-name-actions');
    if (!controlGroup) {
        controlGroup = document.createElement('span');
        controlGroup.className = 'les-product-name-actions';
    }

    let copyButton = h1.querySelector('.lekolar-copy-btn[data-type="name"]');
    if (!copyButton) {
        copyButton = createCopyButton(() => getProductName(), 'name');
    }
    if (copyButton && copyButton.parentElement !== controlGroup) {
        controlGroup.appendChild(copyButton);
    }

    let button = h1.querySelector('.les-product-name-search-btn');
    if (!button) {
        button = document.createElement('button');
        button.type = 'button';
        button.className = 'lekolar-copy-btn les-product-name-search-btn';
        button.dataset.type = 'similar-name';
        button.title = 'Find similar products from name';
        button.setAttribute('aria-label', 'Find similar products from name');
        button.setAttribute('aria-pressed', 'false');

        const tooltip = document.createElement('span');
        tooltip.className = 'tooltip';
        tooltip.textContent = 'Find similar products';

        button.appendChild(createSearchSvg(16));
        button.appendChild(tooltip);
        button.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            activateProductNameSearch(h1, button);
        });
    }

    if (button.parentElement !== controlGroup) {
        controlGroup.appendChild(button);
    }

    if (controlGroup.parentElement !== h1) {
        h1.insertBefore(controlGroup, h1.firstChild);
    } else if (controlGroup !== h1.firstChild) {
        h1.insertBefore(controlGroup, h1.firstChild);
    }

    if (!h1.querySelector('.les-product-name-search-text')) {
        renderProductNameSearchText(h1, name);
    }
}

function getMainProductCode() {
    const productRoot = document.querySelector('.product-page-wrapper[data-productnumber], .jsProductPage[data-productnumber], [data-productnumber]');
    if (productRoot && productRoot.dataset && productRoot.dataset.productnumber) {
        return normalizeWhitespace(productRoot.dataset.productnumber);
    }

    const mediaItem = document.querySelector('.js-productImage[data-productnumber], [data-productnumber]');
    if (mediaItem && mediaItem.dataset && mediaItem.dataset.productnumber) {
        return normalizeWhitespace(mediaItem.dataset.productnumber);
    }

    return '';
}

function getCurrentDescriptionElement() {
    return document.querySelector('.product-info .description .description-wrapper, .product-info .description, .description-wrapper');
}

function getCurrentDescriptionText() {
    const el = getCurrentDescriptionElement();
    return el ? normalizeWhitespace(el.textContent) : '';
}

function getCurrentCountryCode() {
    const host = window.location.hostname.toLowerCase();
    if (host.endsWith('.lekolar.fi')) return 'fi';
    if (host.endsWith('.lekolar.se')) return 'se';
    if (host.endsWith('.lekolar.no')) return 'no';
    if (host.endsWith('.lekolar.dk')) return 'dk';
    return 'local';
}

function getCountryLabel(code) {
    const labels = {
        fi: 'Current page (FI)',
        se: 'Current page (SE)',
        no: 'Current page (NO)',
        dk: 'Current page (DK)',
        local: 'Current page'
    };
    return labels[code] || 'Current page';
}

function getInlineTranslationLanguage() {
    const code = getCurrentCountryCode();
    if (code === 'fi') return 'fi';
    if (code === 'no') return 'no';
    if (code === 'dk') return 'da';
    return 'en';
}

function ensureProductActionBar() {
    let buttonsBar = document.querySelector('.les-buttons-bar');
    if (buttonsBar) return buttonsBar;

    buttonsBar = document.createElement('div');
    buttonsBar.className = 'les-buttons-bar';

    const complianceBtn = document.querySelector('.lekolar-compliance-btn');
    if (complianceBtn && complianceBtn.parentElement) {
        complianceBtn.parentElement.insertBefore(buttonsBar, complianceBtn);
        buttonsBar.appendChild(complianceBtn);
        return buttonsBar;
    }

    const sidebar = document.querySelector('.product-properties, .product-attributes, .product-details-sidebar, .product-specs');
    if (sidebar) {
        sidebar.appendChild(buttonsBar);
        return buttonsBar;
    }

    const productInfo = document.querySelector('.product-info, .product-page-wrapper .product-info, .product-page .product-info');
    if (productInfo) {
        productInfo.appendChild(buttonsBar);
        return buttonsBar;
    }

    return null;
}

function createCopyButton(textGetter, type, options = {}) {
    const button = document.createElement('button');
    button.className = 'lekolar-copy-btn';
    button.dataset.type = type;

    let getValue = () => typeof textGetter === 'function' ? textGetter() : textGetter;
    const getCopyContext = options.getCopyContext || null;
    const initialValue = getValue();
    if (initialValue) button.dataset.value = initialValue;

    const svgNS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(svgNS, 'svg');
    svg.setAttribute('xmlns', svgNS);
    svg.setAttribute('width', '16');
    svg.setAttribute('height', '16');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '2');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.classList.add('feather', 'feather-copy');

    const rect1 = document.createElementNS(svgNS, 'rect');
    rect1.setAttribute('x', '5');
    rect1.setAttribute('y', '5');
    rect1.setAttribute('width', '13');
    rect1.setAttribute('height', '13');
    rect1.setAttribute('rx', '2');
    rect1.setAttribute('ry', '2');

    const rect2 = document.createElementNS(svgNS, 'rect');
    rect2.setAttribute('x', '9');
    rect2.setAttribute('y', '9');
    rect2.setAttribute('width', '13');
    rect2.setAttribute('height', '13');
    rect2.setAttribute('rx', '2');
    rect2.setAttribute('ry', '2');
    rect2.setAttribute('fill', 'white');

    svg.appendChild(rect1);
    svg.appendChild(rect2);

    const tooltip = document.createElement('span');
    tooltip.className = 'tooltip';
    tooltip.textContent = `Copy ${type}`;

    button.appendChild(svg);
    button.appendChild(tooltip);

    function lesPickFormatSlot(e) {
        const isPrimary = currentSettings.modifierKey && currentSettings.modifierKey !== 'none' && e[currentSettings.modifierKey];
        const isSecondary = !isPrimary && currentSettings.secondaryModifierKey && currentSettings.secondaryModifierKey !== 'none' && e[currentSettings.secondaryModifierKey];
        return isPrimary ? 'primary' : isSecondary ? 'secondary' : 'default';
    }

    function lesGetFormat(slot) {
        const formats = (currentSettings && currentSettings.copyFormats) || (typeof LES_DEFAULT_FORMATS !== 'undefined' ? LES_DEFAULT_FORMATS : {});
        return formats[slot] || (typeof LES_DEFAULT_FORMATS !== 'undefined' ? LES_DEFAULT_FORMATS[slot] : null);
    }

    // Shared helper to update tooltip based on modifier key state
    function updateTooltip(e) {
        const tooltip = button.querySelector('.tooltip');
        const slot = lesPickFormatSlot(e);
        const fmt = lesGetFormat(slot);
        if (slot === 'default') {
            tooltip.innerText = `Copy ${type}`;
        } else if (fmt && fmt.label) {
            tooltip.innerText = fmt.asLink ? `Copy: ${fmt.label} (link)` : `Copy: ${fmt.label}`;
        } else {
            tooltip.innerText = `Copy ${type}`;
        }
    }

    // Key listeners for when the mouse is stationary over the button
    function onKeyDown(e) {
        if (e.key === 'Shift' || e.key === 'Control' || e.key === 'Alt') {
            updateTooltip(e);
        }
    }
    function onKeyUp(e) {
        if (e.key === 'Shift' || e.key === 'Control' || e.key === 'Alt') {
            updateTooltip(e);
        }
    }

    button.addEventListener('mouseenter', (e) => {
        updateTooltip(e);
        document.addEventListener('keydown', onKeyDown);
        document.addEventListener('keyup', onKeyUp);
    });

    button.addEventListener('mouseleave', () => {
        document.removeEventListener('keydown', onKeyDown);
        document.removeEventListener('keyup', onKeyUp);
    });

    button.addEventListener('mousemove', (e) => {
        updateTooltip(e);
    });

    button.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();

        const ownValue = getValue();
        const slot = lesPickFormatSlot(e);
        const fmt = lesGetFormat(slot);

        const context = typeof getCopyContext === 'function' ? (getCopyContext() || {}) : {};
        const name = context.name || getProductName();
        const number = context.number || ((type === 'number' && ownValue) ? ownValue : getProductNumber());
        const url = context.url || window.location.href;
        const ctx = { number, name, url, value: ownValue };

        const renderFn = (typeof lesRenderCopyFormat === 'function') ? lesRenderCopyFormat : null;
        let plainText = (fmt && renderFn) ? renderFn(fmt, ctx) : '';
        if (!plainText) plainText = ownValue || '';
        if (!plainText) return;

        const wantLink = !!(fmt && fmt.asLink) && !!url;

        if (wantLink) {
            const escFn = (typeof lesEscapeHtmlForCopy === 'function') ? lesEscapeHtmlForCopy : escapeHtml;
            const htmlText = `<a href="${escFn(url)}">${escFn(plainText)}</a>`;
            try {
                const clipboardItem = new ClipboardItem({
                    "text/plain": new Blob([plainText], { type: "text/plain" }),
                    "text/html": new Blob([htmlText], { type: "text/html" })
                });
                navigator.clipboard.write([clipboardItem]).then(onCopySuccess).catch(err => {
                    console.warn('LES: Failed to copy rich text:', err);
                    navigator.clipboard.writeText(plainText).then(onCopySuccess);
                });
            } catch (err) {
                navigator.clipboard.writeText(plainText).then(onCopySuccess);
            }
            return;
        }

        navigator.clipboard.writeText(plainText).then(onCopySuccess).catch(err => {
            console.error('Failed to copy text: ', err);
        });

        function onCopySuccess() {
            const tooltip = button.querySelector('.tooltip');
            const originalText = tooltip.innerText;
            tooltip.innerText = 'Copied!';
            tooltip.classList.add('visible');
            setTimeout(() => {
                tooltip.innerText = originalText;
                tooltip.classList.remove('visible');
            }, 2000);
        }
    });

    return button;
}

function flashButtonTooltip(button, label = 'Copied!') {
    const tooltip = button.querySelector('.tooltip');
    if (!tooltip) return;

    const originalText = tooltip.innerText;
    tooltip.innerText = label;
    tooltip.classList.add('visible');
    setTimeout(() => {
        tooltip.innerText = originalText;
        tooltip.classList.remove('visible');
    }, 2000);
}

function getSelectedVariantArticleNumber() {
    // The server-rendered DOM keeps js-currentImage on the default slide regardless of
    // ?variant=. Resolve the actual selected variant from the URL / page wrapper / thumb.
    try {
        const variant = new URL(window.location.href).searchParams.get('variant');
        if (variant && variant.trim()) return variant.trim();
    } catch (_) {}

    const wrapper = document.querySelector('.product-page-wrapper');
    if (wrapper) {
        const articleNumber = wrapper.getAttribute('data-articlenumber') || wrapper.getAttribute('data-articleNumber');
        if (articleNumber && articleNumber.trim()) return articleNumber.trim();
    }

    const selectedThumb = document.querySelector('.js-productImageThumb.selected[data-articlenr]');
    if (selectedThumb) {
        const articleNumber = selectedThumb.getAttribute('data-articlenr');
        if (articleNumber && articleNumber.trim()) return articleNumber.trim();
    }

    return '';
}

function findVariantImageSlide(articleNumber) {
    if (!articleNumber) return null;
    const escaped = (typeof CSS !== 'undefined' && CSS.escape) ? CSS.escape(articleNumber) : articleNumber.replace(/"/g, '\\"');
    return document.querySelector(`.product-image-wrapper .js-productImage[data-articlenr="${escaped}"]`);
}

function getMainProductImageUrl() {
    const variantSlide = findVariantImageSlide(getSelectedVariantArticleNumber());
    if (variantSlide) {
        const href = variantSlide.getAttribute('href');
        if (href) return new URL(href, window.location.href).href;
    }

    const imageLink = document.querySelector(
        '.product-image-wrapper .js-currentImage, .product-image-wrapper .current-image, .product-image-wrapper .js-productImage'
    );
    if (imageLink) {
        const href = imageLink.getAttribute('href');
        if (href) return new URL(href, window.location.href).href;
    }

    const image = document.querySelector('.product-image-wrapper img.product-image, .product-image-wrapper img');
    if (image) {
        const src = image.getAttribute('src');
        if (src) return new URL(src, window.location.href).href;
    }

    return '';
}

function getMainProductImageElement() {
    const variantSlide = findVariantImageSlide(getSelectedVariantArticleNumber());
    if (variantSlide) {
        const variantImage = variantSlide.querySelector('img.product-image, img');
        if (variantImage) return variantImage;
    }

    return document.querySelector(
        '.product-image-wrapper .js-currentImage img.product-image, .product-image-wrapper .js-currentImage img, ' +
        '.product-image-wrapper .current-image img.product-image, .product-image-wrapper .current-image img, ' +
        '.product-image-wrapper img.product-image, .product-image-wrapper img'
    );
}

function canvasToBlob(canvas, type = 'image/png', quality) {
    return new Promise((resolve, reject) => {
        canvas.toBlob((blob) => {
            if (blob) resolve(blob);
            else reject(new Error('Canvas export failed'));
        }, type, quality);
    });
}

async function blobToPngClipboardBlob(blob) {
    if (!blob || !blob.size) throw new Error('Missing source image blob');

    let bitmap = null;
    try {
        bitmap = await createImageBitmap(blob);
        const canvas = document.createElement('canvas');
        canvas.width = bitmap.width;
        canvas.height = bitmap.height;

        const ctx = canvas.getContext('2d');
        if (!ctx) throw new Error('Canvas 2D context unavailable');

        ctx.drawImage(bitmap, 0, 0);
        return await canvasToBlob(canvas, 'image/png');
    } finally {
        if (bitmap && typeof bitmap.close === 'function') {
            bitmap.close();
        }
    }
}

async function copyMainProductImageToClipboard() {
    const imageUrl = getMainProductImageUrl();
    if (imageUrl && navigator.clipboard && typeof ClipboardItem !== 'undefined') {
        try {
            const response = await fetch(imageUrl, { credentials: 'include' });
            if (response.ok) {
                const blob = await response.blob();
                if (blob.size > 0) {
                    const pngBlob = await blobToPngClipboardBlob(blob);
                    const item = new ClipboardItem({ 'image/png': pngBlob });
                    await navigator.clipboard.write([item]);
                    return true;
                }
            }
        } catch (e) {
            // Fall back to the rendered preview below.
        }
    }

    const image = getMainProductImageElement();
    if (!image) throw new Error('Missing product image');

    if (typeof image.decode === 'function') {
        try {
            await image.decode();
        } catch (e) {
            // If the image is already loaded, decode can still reject on some browsers.
        }
    }

    const width = image.naturalWidth || image.width;
    const height = image.naturalHeight || image.height;
    if (!width || !height) throw new Error('Image has no dimensions yet');

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;

    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas 2D context unavailable');

    ctx.drawImage(image, 0, 0, width, height);

    const blob = await canvasToBlob(canvas, 'image/png');
    if (navigator.clipboard && typeof ClipboardItem !== 'undefined') {
        const item = new ClipboardItem({ 'image/png': blob });
        await navigator.clipboard.write([item]);
        return true;
    }

    throw new Error('Image clipboard API unavailable');
}

function ensureProductImageActionButton() {
    const wrapper = document.querySelector('.product-image-wrapper');
    if (!wrapper) return null;

    let button = wrapper.querySelector('.les-image-copy-btn');
    if (button) return button;

    button = document.createElement('button');
    button.type = 'button';
    button.className = 'lekolar-copy-btn les-image-copy-btn';
    button.title = 'Copy product image';
    button.setAttribute('aria-label', 'Copy product image');

    const svgNS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(svgNS, 'svg');
    svg.setAttribute('xmlns', svgNS);
    svg.setAttribute('width', '16');
    svg.setAttribute('height', '16');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '2');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');

    const rect1 = document.createElementNS(svgNS, 'rect');
    rect1.setAttribute('x', '9');
    rect1.setAttribute('y', '3');
    rect1.setAttribute('width', '12');
    rect1.setAttribute('height', '12');
    rect1.setAttribute('rx', '2');
    rect1.setAttribute('ry', '2');

    const rect2 = document.createElementNS(svgNS, 'rect');
    rect2.setAttribute('x', '3');
    rect2.setAttribute('y', '9');
    rect2.setAttribute('width', '12');
    rect2.setAttribute('height', '12');
    rect2.setAttribute('rx', '2');
    rect2.setAttribute('ry', '2');
    rect2.setAttribute('fill', 'white');

    svg.appendChild(rect1);
    svg.appendChild(rect2);

    const tooltip = document.createElement('span');
    tooltip.className = 'tooltip';
    tooltip.textContent = 'Copy image';

    button.appendChild(svg);
    button.appendChild(tooltip);

    button.addEventListener('click', async (e) => {
        e.preventDefault();
        e.stopPropagation();

        try {
            await copyMainProductImageToClipboard();
            flashButtonTooltip(button, 'Image copied!');
            return;
        } catch (error) {
            console.warn('LES: Failed to copy image blob, falling back to URL:', error);
        }

        const imageUrl = getMainProductImageUrl();
        if (!imageUrl) return;

        try {
            await navigator.clipboard.writeText(imageUrl);
            flashButtonTooltip(button, 'Image URL copied!');
        } catch (error) {
            console.error('LES: Failed to copy image URL:', error);
        }
    });

    wrapper.appendChild(button);
    return button;
}

function stripProductCardControlChars(value) {
    return String(value == null ? '' : value).replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');
}

function truncateProductCardText(value, maxLength) {
    const text = stripProductCardControlChars(normalizeWhitespace(value || ''));
    if (!maxLength || text.length <= maxLength) return text;
    return text.slice(0, Math.max(0, maxLength - 1)).trimEnd() + '...';
}

function safeFileName(value) {
    const cleaned = stripProductCardControlChars(value || 'product-card')
        .replace(/[<>:"/\\|?*]/g, '-')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 140)
        .replace(/[. ]+$/g, '');
    return cleaned || 'product-card';
}

function createProductCardFileName(product) {
    const title = product && (product.title || product.name) ? (product.title || product.name) : 'Product card';
    const sku = product && product.sku ? product.sku : '';
    return `${safeFileName(`${sku ? sku + ' - ' : ''}${title}`)}.pptx`;
}

function lesCleanElementText(element) {
    if (!element) return '';
    const clone = element.cloneNode(true);
    clone.querySelectorAll('script, style, svg, button, input, select, textarea, .tooltip, .les-buttons-bar').forEach(node => node.remove());
    return normalizeWhitespace(clone.textContent || '');
}

function extractProductSpecsForPptFromDoc(doc) {
    const root = doc || document;
    const specs = [];
    const seen = new Set();
    const rows = root.querySelectorAll(
        '.product-properties tr, .product-properties li, .product-properties .d-flex, ' +
        '.product-attributes tr, .product-attributes li, .product-attributes .d-flex, ' +
        '.product-details tr, .product-details li, .product-details .d-flex, ' +
        '.product-specs tr, .product-specs li, .product-specs .d-flex'
    );

    rows.forEach(row => {
        if (!row || row.closest('.les-buttons-bar')) return;

        const labelEl = row.querySelector('th, dt, .product-attributes__name, .heading, strong');
        if (!labelEl) return;

        let valueEl = null;
        if (row.tagName && row.tagName.toLowerCase() === 'li') {
            valueEl = row.querySelector('span:not(.heading):not(.color-wrapper), .product-attributes__value');
            if (!valueEl) valueEl = row.querySelector('.color-wrapper');
        } else {
            valueEl = row.querySelector('td, dd, .product-attributes__value, span:not(.heading):not(.color-wrapper)');
        }

        const label = lesCleanElementText(labelEl).replace(/:$/, '').trim();
        if (!label) return;

        let value = '';
        const colorBubble = valueEl && valueEl.querySelector ? valueEl.querySelector('.color-bubble') : null;
        if (colorBubble && colorBubble.title) {
            value = normalizeWhitespace(colorBubble.title);
        } else if (valueEl) {
            value = lesCleanElementText(valueEl);
        } else {
            const clone = row.cloneNode(true);
            clone.querySelectorAll('script, style, svg, button, input, select, textarea, .tooltip, .les-buttons-bar').forEach(node => node.remove());
            value = normalizeWhitespace((clone.textContent || '').replace(labelEl.textContent || '', ''));
        }

        if (value.toLowerCase().startsWith(label.toLowerCase())) {
            value = value.slice(label.length).replace(/^[:\s-]+/, '').trim();
        }
        if (!value) return;

        const line = `${label}: ${value}`;
        const key = line.toLowerCase();
        if (seen.has(key)) return;
        seen.add(key);
        specs.push(line);
    });

    return specs.slice(0, 18);
}

function getCurrentProductSpecsForPpt() {
    return extractProductSpecsForPptFromDoc(document);
}

function extractProductDataFromPage() {
    const number = normalizeWhitespace(getSelectedVariantArticleNumber() || getMainProductNumber() || getMainProductCode() || '');
    const title = truncateProductCardText(getProductName() || document.title.replace(/\s*\|\s*Lekolar.*$/i, ''), 130);
    const description = truncateProductCardText(getCurrentDescriptionText(), 620);
    const specs = getCurrentProductSpecsForPpt().map(line => truncateProductCardText(line, 160));
    const url = buildProductCardVariantUrl(window.location.href, number);
    const imageUrl = getMainProductImageUrl();
    const environmentalLogos = extractProductCardEnvironmentalLogos();

    if (!title && !number) console.warn('LES: Product card PPT could not find a product title or SKU.');
    if (!description) console.warn('LES: Product card PPT could not find a product description.');
    if (!specs.length) console.warn('LES: Product card PPT could not find product specifications.');
    if (!imageUrl) console.warn('LES: Product card PPT could not find a product image URL.');

    return {
        sku: number,
        number,
        title: title || number || 'Product card',
        name: title || number || 'Product card',
        description,
        specs,
        imageUrl,
        environmentalLogos,
        url,
        countryCode: getCurrentCountryCode()
    };
}

function extractVariantArticleNumberFromUrl(url) {
    try {
        const variant = new URL(url, window.location.href).searchParams.get('variant');
        return normalizeWhitespace(variant || '');
    } catch (_) {
        return '';
    }
}

function isProductCardVariantArticleNumber(articleNumber) {
    return /^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)+$/.test(normalizeWhitespace(articleNumber || ''));
}

function buildProductCardVariantUrl(url, articleNumber) {
    const rawUrl = normalizeWhitespace(url || '');
    if (!rawUrl) return '';

    try {
        const parsed = new URL(rawUrl, window.location.href);
        const variant = normalizeWhitespace(articleNumber || parsed.searchParams.get('variant') || '');
        parsed.hash = '';
        if (isProductCardVariantArticleNumber(variant)) {
            parsed.searchParams.set('variant', variant);
        }
        return parsed.href;
    } catch (_) {
        return rawUrl.split('#')[0];
    }
}

function extractProductDataFromDoc(doc, productUrl, fallback = {}) {
    const resolvedUrl = normalizeWhitespace((doc && doc.__lesFetchedUrl) || productUrl || fallback.url || '');
    const fallbackArticle = normalizeWhitespace(fallback.articleNumber || fallback.sku || fallback.number || '');
    const number = normalizeWhitespace(fallbackArticle || extractVariantArticleNumberFromUrl(resolvedUrl) || extractProductNumberFromDoc(doc) || '');
    const productCardUrl = buildProductCardVariantUrl(resolvedUrl, number);
    const title = truncateProductCardText(
        extractProductNameFromDoc(doc) || fallback.name || fallback.title || number || 'Product card',
        130
    );
    const description = truncateProductCardText(
        extractProductDescriptionFromDoc(doc) || fallback.description || fallback.shortDescription || '',
        620
    );
    const specs = extractProductSpecsForPptFromDoc(doc).map(line => truncateProductCardText(line, 160));
    const imageUrl = extractProductImageFromDoc(doc, resolvedUrl || window.location.href, number) || fallback.imageUrl || '';
    const environmentalLogos = extractProductCardEnvironmentalLogosFromDoc(doc, resolvedUrl || window.location.href);

    return {
        sku: number,
        number,
        title: title || number || 'Product card',
        name: title || number || 'Product card',
        description,
        specs,
        imageUrl,
        environmentalLogos,
        url: productCardUrl || resolvedUrl,
        countryCode: getCurrentCountryCode(),
        quantity: Math.max(1, parseInt(fallback.quantity || '1', 10) || 1),
        department: normalizeWhitespace(fallback.department || '')
    };
}

function createFallbackCartProductData(item, error) {
    const number = normalizeWhitespace(item && item.articleNumber || '');
    const title = truncateProductCardText((item && item.name) || number || 'Product card', 130);
    const specs = [];
    if (error) {
        specs.push(truncateProductCardText(`Load status: ${(error && error.message) ? error.message : String(error)}`, 160));
    }

    return {
        sku: number,
        number,
        title,
        name: title,
        description: '',
        specs,
        imageUrl: item && item.imageUrl ? item.imageUrl : '',
        environmentalLogos: [],
        url: buildProductCardVariantUrl(item && item.url ? item.url : '', number),
        countryCode: getCurrentCountryCode(),
        quantity: Math.max(1, parseInt(item && item.quantity || '1', 10) || 1),
        department: normalizeWhitespace(item && item.department || '')
    };
}

function resolveProductCardAssetUrl(value, baseUrl = window.location.href) {
    const raw = String(value || '').trim();
    if (!raw) return '';
    try {
        return new URL(raw, baseUrl || window.location.href).href;
    } catch (_) {
        return raw;
    }
}

const PRODUCT_CARD_ENVIRONMENTAL_LOGO_TOKENS = [
    'fsc',
    'pefc',
    'mobelfakta',
    'ecolabel',
    'eco label',
    'nordic',
    'swan',
    'svan',
    'joutsen',
    'ymparisto',
    'miljo',
    'toxicfree',
    'toxic free',
    'haitta aineeton',
    'giftfri',
    'gots',
    'oeko',
    'oekotex',
    'blauer engel',
    'greenguard',
    'cradle to cradle',
    'circularity'
];

const PRODUCT_CARD_PROMOTIONAL_LOGO_TOKENS = [
    'kampanja',
    'kampanj',
    'campaign',
    'campaigns',
    'bestseller',
    'best seller',
    'uutuus',
    'uutuudet',
    'nyhet',
    'nyhed',
    'sale',
    'tarjous',
    'offer',
    'discount',
    'rabatt',
    'rea'
];

const PRODUCT_CARD_PROMOTIONAL_LOGO_STEMS = [
    'kampanj',
    'campaign',
    'bestseller',
    'uutu',
    'nyhet',
    'nyhed'
];

function foldProductCardLogoSignal(value) {
    return normalizeWhitespace(value)
        .toLowerCase()
        .replace(/[åäæ]/g, 'a')
        .replace(/[öø]/g, 'o')
        .replace(/[éè]/g, 'e');
}

function escapeProductCardLogoRegExp(value) {
    return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function productCardLogoSignalMatches(signal, tokens) {
    return tokens.some(token => {
        const foldedToken = foldProductCardLogoSignal(token);
        if (!foldedToken) return false;
        const tokenPattern = escapeProductCardLogoRegExp(foldedToken).replace(/\s+/g, '[^a-z0-9]+');
        return new RegExp(`(^|[^a-z0-9])${tokenPattern}([^a-z0-9]|$)`).test(signal);
    });
}

function productCardLogoSignalContains(signal, tokens) {
    return tokens.some(token => {
        const foldedToken = foldProductCardLogoSignal(token);
        return foldedToken && signal.includes(foldedToken);
    });
}

function getProductCardLogoSignal(img, url, label) {
    const parts = [
        label,
        url,
        img.getAttribute('class') || '',
        img.getAttribute('id') || '',
        img.getAttribute('aria-label') || '',
        img.getAttribute('data-flag') || '',
        img.getAttribute('data-label') || ''
    ];

    let parent = img.parentElement;
    for (let depth = 0; parent && depth < 3; depth += 1, parent = parent.parentElement) {
        parts.push(
            parent.getAttribute('class') || '',
            parent.getAttribute('id') || '',
            parent.getAttribute('title') || '',
            parent.getAttribute('aria-label') || '',
            parent.getAttribute('data-flag') || '',
            parent.getAttribute('data-label') || ''
        );
    }

    return foldProductCardLogoSignal(parts.join(' '));
}

function isProductCardProductFlagLogo(img) {
    return !!img.closest('.product-flags, [class*="product-flag"]');
}

function shouldIncludeProductCardEnvironmentalLogo(img, url, label) {
    const signal = getProductCardLogoSignal(img, url, label);
    if (
        productCardLogoSignalMatches(signal, PRODUCT_CARD_PROMOTIONAL_LOGO_TOKENS) ||
        productCardLogoSignalContains(signal, PRODUCT_CARD_PROMOTIONAL_LOGO_STEMS)
    ) {
        return false;
    }

    if (isProductCardProductFlagLogo(img)) {
        return productCardLogoSignalMatches(signal, PRODUCT_CARD_ENVIRONMENTAL_LOGO_TOKENS);
    }

    return true;
}

function extractProductCardEnvironmentalLogosFromDoc(doc, baseUrl = window.location.href) {
    const root = doc || document;
    const logos = [];
    const seen = new Set();
    const selectors = [
        '.symbols img',
        '.product-symbols img',
        '.product-symbols__item img',
        '.product-flags img',
        '.environmental-symbols img',
        '.product-environmental-symbols img',
        'img[class^="symbol-"]',
        'img[class*=" symbol-"]'
    ].join(', ');

    root.querySelectorAll(selectors).forEach(img => {
        const src = img.currentSrc || img.src || img.getAttribute('src') || '';
        const url = resolveProductCardAssetUrl(src, baseUrl);
        if (!url || seen.has(url)) return;
        const label = normalizeWhitespace(img.getAttribute('alt') || img.getAttribute('title') || '');
        if (!shouldIncludeProductCardEnvironmentalLogo(img, url, label)) return;
        seen.add(url);
        logos.push({ url, label });
    });

    return logos.slice(0, 8);
}

function extractProductCardEnvironmentalLogos() {
    return extractProductCardEnvironmentalLogosFromDoc(document, window.location.href);
}

const PRODUCT_CARD_LEKOLAR_LOGO_PATH = 'assets/lekolar-logo.svg';

function getProductCardExtensionAssetUrl(path) {
    try {
        if (chrome && chrome.runtime && typeof chrome.runtime.getURL === 'function') {
            return chrome.runtime.getURL(path);
        }
    } catch (_) {}
    return '';
}

async function imageUrlToDataUri(url) {
    if (!url) return '';

    try {
        const response = await fetch(url, { credentials: 'include', cache: 'force-cache' });
        if (!response.ok) throw new Error(`Image request failed with HTTP ${response.status}`);
        const blob = await response.blob();
        if (!blob || !blob.size) throw new Error('Image response was empty.');

        const type = String(blob.type || '').toLowerCase();
        if (type === 'image/png' || type === 'image/jpeg' || type === 'image/jpg' || type === 'image/gif') {
            return await blobToDataUri(blob);
        }

        if (type.startsWith('image/')) {
            return await imageBlobToPngDataUri(blob);
        }

        throw new Error(`Unsupported product image content type: ${blob.type || 'unknown'}`);
    } catch (error) {
        console.warn('LES: Failed to load product image for PPT. Generating without image.', error);
        return '';
    }
}

function blobToDataUri(blob) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ''));
        reader.onerror = () => reject(reader.error || new Error('Image FileReader failed.'));
        reader.readAsDataURL(blob);
    });
}

async function imageBlobToPngDataUri(blob) {
    const urlApi = window.URL || window.webkitURL;
    if (!urlApi || !urlApi.createObjectURL) throw new Error('Browser does not support image conversion.');

    const objectUrl = urlApi.createObjectURL(blob);
    try {
        const image = new Image();
        image.decoding = 'async';
        const loaded = new Promise((resolve, reject) => {
            image.onload = resolve;
            image.onerror = () => reject(new Error('Product image could not be decoded for PPT.'));
        });
        image.src = objectUrl;
        await loaded;

        const sourceWidth = image.naturalWidth || image.width;
        const sourceHeight = image.naturalHeight || image.height;
        if (!sourceWidth || !sourceHeight) throw new Error('Product image dimensions were empty.');

        const maxSide = 1800;
        const scale = Math.min(1, maxSide / Math.max(sourceWidth, sourceHeight));
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(sourceWidth * scale));
        canvas.height = Math.max(1, Math.round(sourceHeight * scale));
        const context = canvas.getContext('2d');
        if (!context) throw new Error('Canvas is not available for product image conversion.');
        context.drawImage(image, 0, 0, canvas.width, canvas.height);

        return canvas.toDataURL('image/png');
    } finally {
        urlApi.revokeObjectURL(objectUrl);
    }
}

function getProductCardImageSize(dataUri) {
    if (!dataUri) return Promise.resolve(null);

    return new Promise((resolve) => {
        const image = new Image();
        image.onload = () => {
            const width = image.naturalWidth || image.width;
            const height = image.naturalHeight || image.height;
            resolve(width && height ? { width, height } : null);
        };
        image.onerror = () => resolve(null);
        image.src = dataUri;
    });
}

function getProductCardImagePlacement(imageSize, frame) {
    if (!imageSize || !imageSize.width || !imageSize.height) return frame;

    const aspect = imageSize.width / imageSize.height;
    let h = frame.h;
    let w = h * aspect;

    if (w > frame.w) {
        w = frame.w;
        h = w / aspect;
    }

    return {
        x: frame.x + ((frame.w - w) / 2),
        y: frame.y + ((frame.h - h) / 2),
        w,
        h
    };
}

function getProductCardLogoPlacement(imageSize, frame) {
    if (!imageSize || !imageSize.width || !imageSize.height) return frame;

    const aspect = imageSize.width / imageSize.height;
    let h = frame.h;
    let w = h * aspect;

    if (w > frame.w) {
        w = frame.w;
        h = w / aspect;
    }

    return {
        x: frame.x,
        y: frame.y + ((frame.h - h) / 2),
        w,
        h
    };
}

function getProductCardPptSettings() {
    if (typeof lesCloneProductCardPptSettings === 'function') {
        return lesCloneProductCardPptSettings(currentSettings && currentSettings.productCardPpt);
    }
    return {
        bannerColor: '#B5121B',
        labels: { item: 'Item', description: 'Description', specifications: 'Specifications' },
        linkFormat: { tokens: [{ type: 'url' }] }
    };
}

function productCardPptColor(value, fallback = 'B5121B') {
    const color = String(value || '').trim();
    return /^#[0-9a-f]{6}$/i.test(color) ? color.slice(1).toUpperCase() : fallback;
}

function getProductCardLinkText(product, settings) {
    const format = settings && settings.linkFormat ? settings.linkFormat : { tokens: [{ type: 'url' }] };
    const context = {
        number: product.sku || product.number || '',
        name: product.title || product.name || '',
        url: product.url || '',
        value: product.url || ''
    };
    const text = typeof lesRenderCopyFormat === 'function'
        ? lesRenderCopyFormat(format, context)
        : context.url;
    return truncateProductCardText(text || context.url, 240);
}

async function hydrateProductCardLogo(logo) {
    if (!logo || !logo.url) return null;
    const dataUri = logo.dataUri || await imageUrlToDataUri(logo.url);
    if (!dataUri) return null;
    return {
        ...logo,
        dataUri,
        imageSize: logo.imageSize || await getProductCardImageSize(dataUri)
    };
}

async function hydrateProductCardLekolarLogo() {
    const url = getProductCardExtensionAssetUrl(PRODUCT_CARD_LEKOLAR_LOGO_PATH);
    const dataUri = await imageUrlToDataUri(url);
    if (!dataUri) return null;
    return {
        dataUri,
        imageSize: await getProductCardImageSize(dataUri)
    };
}

async function hydrateProductCardVisualAssets(product) {
    const output = {
        ...product,
        pptSettings: product.pptSettings || getProductCardPptSettings(),
        imageData: product.imageData || await imageUrlToDataUri(product.imageUrl)
    };

    if (output.imageData && !output.imageSize) {
        output.imageSize = await getProductCardImageSize(output.imageData);
    }

    const rawEnvLogos = Array.isArray(output.environmentalLogos) ? output.environmentalLogos : [];
    output.environmentalLogos = (await Promise.all(rawEnvLogos.slice(0, 8).map(hydrateProductCardLogo))).filter(Boolean);
    output.lekolarLogo = output.lekolarLogo || await hydrateProductCardLekolarLogo();

    return output;
}

function getPptxGenConstructor() {
    const root = typeof globalThis !== 'undefined'
        ? globalThis
        : (typeof window !== 'undefined' ? window : self);
    let ctor = root.PptxGenJS || root.pptxgen || root.pptxgenjs;
    if (!ctor && typeof window !== 'undefined') {
        ctor = window.PptxGenJS || window.pptxgen || window.pptxgenjs;
    }
    if (!ctor && typeof PptxGenJS !== 'undefined') {
        ctor = PptxGenJS;
    }
    if (!ctor) {
        throw new Error('PptxGenJS is not loaded. Check manifest content script order and vendor/pptxgen.bundle.js.');
    }
    return ctor.default || ctor;
}

function showProductCardStatus(message, type = 'info') {
    if (type === 'error') console.warn(`LES: ${message}`);
    showCompareToast(message);
}

function getProductCardErrorText(error) {
    if (!error) return '';
    if (typeof error === 'string') return error;
    if (error.message) return error.message;
    try {
        return String(error);
    } catch {
        return '';
    }
}

function getProductCardUserErrorMessage(error) {
    const message = getProductCardErrorText(error);
    if (/PptxGenJS is not loaded/i.test(message)) {
        return 'PPT library not loaded. Reload the extension and page.';
    }
    return 'Could not create product card PPT. See console for details.';
}

function isPptxLibraryMissingError(error) {
    return /PptxGenJS is not loaded/i.test(getProductCardErrorText(error));
}

function triggerProductCardBlobDownload(blob, fileName) {
    if (!blob || !blob.size) throw new Error('PPTX blob was empty.');
    const urlApi = window.URL || window.webkitURL;
    if (!urlApi || !urlApi.createObjectURL) throw new Error('Browser does not support Blob downloads.');
    const host = document.body || document.documentElement;
    if (!host) throw new Error('Cannot start PPT download before the page body exists.');

    const url = urlApi.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = fileName;
    link.rel = 'noopener';
    link.dataset.interception = 'off';
    link.style.display = 'none';
    host.appendChild(link);
    link.click();

    setTimeout(() => {
        urlApi.revokeObjectURL(url);
        if (link.remove) {
            link.remove();
        } else if (link.parentNode) {
            link.parentNode.removeChild(link);
        }
    }, 1000);
}

async function writeProductCardPptx(pptx, fileName) {
    try {
        await pptx.writeFile({ fileName, compression: true });
        return;
    } catch (writeFileError) {
        console.warn('LES: PptxGenJS writeFile failed. Trying Blob download fallback.', writeFileError);
    }

    const output = await pptx.write({ outputType: 'blob', compression: true });
    const blob = output instanceof Blob
        ? output
        : new Blob([output], { type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' });
    triggerProductCardBlobDownload(blob, fileName);
}

function productCardBase64ToBlob(base64, mimeType) {
    const binary = atob(base64 || '');
    const chunks = [];
    for (let offset = 0; offset < binary.length; offset += 32768) {
        const slice = binary.slice(offset, offset + 32768);
        const bytes = new Uint8Array(slice.length);
        for (let i = 0; i < slice.length; i++) bytes[i] = slice.charCodeAt(i);
        chunks.push(bytes);
    }
    return new Blob(chunks, { type: mimeType || 'application/vnd.openxmlformats-officedocument.presentationml.presentation' });
}

function sendProductCardPptxBackgroundRequest(product) {
    return new Promise((resolve, reject) => {
        chrome.runtime.sendMessage(
            {
                action: 'lesCreateProductCardPptx',
                product
            },
            (response) => {
                if (chrome.runtime.lastError) {
                    reject(new Error(chrome.runtime.lastError.message));
                    return;
                }
                if (!response || response.ok !== true || !response.base64) {
                    reject(new Error((response && response.error) ? response.error : 'background_pptx_failed'));
                    return;
                }

                const blob = productCardBase64ToBlob(response.base64, response.mimeType);
                triggerProductCardBlobDownload(blob, response.fileName || createProductCardFileName(product));
                resolve();
            }
        );
    });
}

async function requestProductCardPptxFromBackground(product) {
    try {
        await sendProductCardPptxBackgroundRequest(product);
    } catch (error) {
        if (!product || !product.imageData) throw error;
        console.warn('LES: Background PPT generation failed with image data. Retrying without image.', error);
        const productWithoutImage = { ...product, imageData: '' };
        await sendProductCardPptxBackgroundRequest(productWithoutImage);
    }
}

function sendProductCardDeckPptxBackgroundRequest(products, fileName) {
    return new Promise((resolve, reject) => {
        chrome.runtime.sendMessage(
            {
                action: 'lesCreateProductCardDeckPptx',
                products,
                fileName
            },
            (response) => {
                if (chrome.runtime.lastError) {
                    reject(new Error(chrome.runtime.lastError.message));
                    return;
                }
                if (!response || response.ok !== true || !response.base64) {
                    reject(new Error((response && response.error) ? response.error : 'background_pptx_failed'));
                    return;
                }

                const blob = productCardBase64ToBlob(response.base64, response.mimeType);
                triggerProductCardBlobDownload(blob, response.fileName || fileName || 'Lekolar_Cart_Product_Cards.pptx');
                resolve();
            }
        );
    });
}

async function requestProductCardDeckPptxFromBackground(products, fileName) {
    try {
        await sendProductCardDeckPptxBackgroundRequest(products, fileName);
    } catch (error) {
        if (!products || !products.some(product => product && product.imageData)) throw error;
        console.warn('LES: Background cart PPT generation failed with image data. Retrying without images.', error);
        const productsWithoutImages = products.map(product => ({ ...product, imageData: '' }));
        await sendProductCardDeckPptxBackgroundRequest(productsWithoutImages, fileName);
    }
}

const LES_PRODUCT_CARD_MASTER_NAME = 'LES_PRODUCT_CARD';

function getProductCardTemplate(settings) {
    const tpl = settings && settings.template;
    if (tpl && typeof tpl === 'object') return tpl;
    if (typeof lesCloneProductCardPptTemplate === 'function') {
        return lesCloneProductCardPptTemplate(null);
    }
    return null;
}

function createProductCardDeck(PptxGenJS, title, subject = 'Product card', pptSettings = null) {
    const pptx = new PptxGenJS();
    pptx.layout = 'LAYOUT_WIDE';
    pptx.author = 'Lekolar Enhancer';
    pptx.company = 'Lekolar';
    pptx.subject = subject;
    pptx.title = title || subject || 'Product card';
    pptx.lang = 'en-US';

    const settings = pptSettings || getProductCardPptSettings();
    const template = getProductCardTemplate(settings);
    const accentColor = productCardPptColor(settings.bannerColor);
    const bgColor = productCardPptColor(template && template.background, 'FFFFFF');
    const bannerHcm = (template && template.banner && template.banner.h) || 2.18;
    const shapeType = (pptx.ShapeType) || {};
    const rectShape = shapeType.rect || 'rect';

    pptx.defineSlideMaster({
        title: LES_PRODUCT_CARD_MASTER_NAME,
        background: { color: bgColor },
        objects: [
            { rect: { x: 0, y: 0, w: 13.333, h: lesCmToIn(bannerHcm), fill: { color: accentColor }, line: { color: accentColor } } }
        ]
    });

    pptx._lesProductCardCtx = { template, accentColor, bgColor, rectShape };
    return pptx;
}

function addProductCardSlide(pptx, productForPpt) {
    const pptSettings = productForPpt.pptSettings || getProductCardPptSettings();
    const ctx = pptx._lesProductCardCtx || {
        template: getProductCardTemplate(pptSettings),
        accentColor: productCardPptColor(pptSettings.bannerColor),
        bgColor: productCardPptColor((pptSettings.template && pptSettings.template.background), 'FFFFFF'),
        rectShape: (pptx.ShapeType && pptx.ShapeType.rect) || 'rect'
    };
    const template = ctx.template;
    const accentColor = ctx.accentColor;
    const rectShape = ctx.rectShape;
    const blocks = (template && template.blocks) || {};
    const slide = pptx.addSlide({ masterName: LES_PRODUCT_CARD_MASTER_NAME });

    const imageData = productForPpt.imageData || '';
    const title = productForPpt.title || 'Product card';
    const skuText = productForPpt.sku ? `${pptSettings.labels.item} ${productForPpt.sku}` : 'Product card';
    const descText = productForPpt.description || 'No product description found on page.';
    const specLines = productForPpt.specs && productForPpt.specs.length ? productForPpt.specs : ['No product specifications found on page.'];
    const specsText = specLines.map(line => `- ${line}`).join('\n');

    const inBox = (b) => ({ x: lesCmToIn(b.x), y: lesCmToIn(b.y), w: lesCmToIn(b.w), h: lesCmToIn(b.h) });

    const titleB = inBox(blocks.title);
    const skuB = inBox(blocks.sku);
    slide.addText(title, { ...titleB, margin: 0.04, fontFace: 'Arial', fontSize: blocks.title.fontSize, bold: true, color: 'FFFFFF', valign: 'middle', fit: 'shrink' });
    slide.addText(skuText, { ...skuB, margin: 0.04, fontFace: 'Arial', fontSize: blocks.sku.fontSize, bold: true, color: 'FFFFFF', align: 'right', valign: 'middle', fit: 'shrink' });

    const imageCm = blocks.image;
    const imageB = inBox(imageCm);
    const imagePadIn = lesCmToIn(lesIsFiniteNumber(imageCm.pad) ? imageCm.pad : 0.25);
    slide.addShape(rectShape, { ...imageB, fill: { color: 'F8FAFC' }, line: { color: 'E2E8F0', width: 1 } });
    if (imageData) {
        const imageBox = getProductCardImagePlacement(productForPpt.imageSize, {
            x: imageB.x + imagePadIn,
            y: imageB.y + imagePadIn,
            w: imageB.w - imagePadIn * 2,
            h: imageB.h - imagePadIn * 2
        });
        slide.addImage({ data: imageData, x: imageBox.x, y: imageBox.y, w: imageBox.w, h: imageBox.h });
    } else {
        slide.addText('No product image', {
            x: imageB.x + imagePadIn,
            y: imageB.y + (imageB.h - 0.35) / 2,
            w: imageB.w - imagePadIn * 2,
            h: 0.35,
            fontFace: 'Arial', fontSize: 16, color: '64748B', align: 'center'
        });
    }

    const dL = inBox(blocks.descLabel), dB = inBox(blocks.desc), sL = inBox(blocks.specsLabel), sB = inBox(blocks.specs);
    slide.addText(pptSettings.labels.description, { ...dL, fontFace: 'Arial', fontSize: blocks.descLabel.fontSize, bold: true, color: accentColor, margin: 0 });
    slide.addText(descText, { ...dB, fontFace: 'Arial', fontSize: blocks.desc.fontSize, color: '1F2937', margin: 0.06, breakLine: false, fit: 'shrink', valign: 'top' });
    slide.addText(pptSettings.labels.specifications, { ...sL, fontFace: 'Arial', fontSize: blocks.specsLabel.fontSize, bold: true, color: accentColor, margin: 0 });
    slide.addText(specsText, { ...sB, fontFace: 'Arial', fontSize: blocks.specs.fontSize, color: '1F2937', margin: 0.06, breakLine: false, fit: 'shrink', valign: 'top' });

    const departmentText = normalizeWhitespace(productForPpt.department || '');
    if (departmentText && pptSettings.showDepartment !== false && blocks.departmentLabel && blocks.department) {
        const deptLabelB = inBox(blocks.departmentLabel);
        const deptB = inBox(blocks.department);
        slide.addText(pptSettings.labels.department || 'Department', {
            ...deptLabelB,
            fontFace: 'Arial', fontSize: blocks.departmentLabel.fontSize, bold: true,
            color: accentColor, margin: 0, fit: 'shrink'
        });
        slide.addText(departmentText, {
            ...deptB,
            fontFace: 'Arial', fontSize: blocks.department.fontSize, bold: true,
            color: '1F2937', margin: 0, fit: 'shrink'
        });
    }

    if (productForPpt.url) {
        const lB = inBox(blocks.link);
        slide.addText(getProductCardLinkText(productForPpt, pptSettings), {
            ...lB,
            fontFace: 'Arial', fontSize: blocks.link.fontSize, color: '2563EB', margin: 0,
            hyperlink: { url: productForPpt.url, tooltip: 'Open product page' },
            fit: 'shrink'
        });
    }

    addProductCardFooterLogos(slide, productForPpt, template);
    return slide;
}

async function generateProductCardPptx(product) {
    const productForPpt = await hydrateProductCardVisualAssets(product);

    let PptxGenJS;
    try {
        PptxGenJS = getPptxGenConstructor();
    } catch (error) {
        if (!isPptxLibraryMissingError(error)) throw error;
        console.warn('LES: PptxGenJS is not available in the content script. Trying background PPTX generation.', error);
        await requestProductCardPptxFromBackground(productForPpt);
        return;
    }

    const pptx = createProductCardDeck(PptxGenJS, productForPpt.title || 'Product card', 'Product card', productForPpt.pptSettings);
    addProductCardSlide(pptx, productForPpt);
    await writeProductCardPptx(pptx, createProductCardFileName(productForPpt));
}

async function generateCartProductCardsPptx(products, fileName) {
    const rawProducts = Array.isArray(products) ? products : [];
    if (rawProducts.length === 0) throw new Error('No cart products found for PPT.');

    const hydratedProducts = [];
    for (const product of rawProducts) {
        hydratedProducts.push(await hydrateProductCardVisualAssets(product));
    }

    let PptxGenJS;
    try {
        PptxGenJS = getPptxGenConstructor();
    } catch (error) {
        if (!isPptxLibraryMissingError(error)) throw error;
        console.warn('LES: PptxGenJS is not available in the content script. Trying background cart PPTX generation.', error);
        await requestProductCardDeckPptxFromBackground(hydratedProducts, fileName);
        return;
    }

    const pptx = createProductCardDeck(PptxGenJS, 'Lekolar cart product cards', 'Cart product cards', hydratedProducts[0] && hydratedProducts[0].pptSettings);
    hydratedProducts.forEach(product => addProductCardSlide(pptx, product));
    await writeProductCardPptx(pptx, fileName || 'Lekolar_Cart_Product_Cards.pptx');
}

function addProductCardFooterLogos(slide, product, template) {
    const footer = (template && template.footer) || {};
    const envCm = footer.envLogos || { y: 17.22, h: 0.97, slotW: 2.67, startX: 1.40, maxRight: 14.61, gap: 0.41 };
    const lekCm = footer.lekolarLogo || { rightX: 32.26, y: 17.17, w: 2.41, h: 1.07 };
    const env = {
        y: lesCmToIn(envCm.y), h: lesCmToIn(envCm.h), slotW: lesCmToIn(envCm.slotW),
        startX: lesCmToIn(envCm.startX), maxRight: lesCmToIn(envCm.maxRight), gap: lesCmToIn(envCm.gap)
    };
    const lek = {
        rightX: lesCmToIn(lekCm.rightX), y: lesCmToIn(lekCm.y),
        w: lesCmToIn(lekCm.w), h: lesCmToIn(lekCm.h)
    };

    let x = env.startX;
    (product.environmentalLogos || []).forEach(logo => {
        if (!logo || !logo.dataUri || x >= env.maxRight) return;
        const box = getProductCardLogoPlacement(logo.imageSize, { x, y: env.y, w: env.slotW, h: env.h });
        if (box.x + box.w > env.maxRight) return;
        slide.addImage({ data: logo.dataUri, x: box.x, y: box.y, w: box.w, h: box.h });
        x = box.x + box.w + env.gap;
    });

    const lekolarLogo = product && product.lekolarLogo;
    if (lekolarLogo && lekolarLogo.dataUri) {
        const box = getProductCardLogoPlacement(lekolarLogo.imageSize, {
            x: lek.rightX - lek.w,
            y: lek.y,
            w: lek.w,
            h: lek.h
        });
        slide.addImage({ data: lekolarLogo.dataUri, x: box.x, y: box.y, w: box.w, h: box.h });
    }
}

function createProductCardPptSvg(size = 14) {
    const svgNS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(svgNS, 'svg');
    svg.setAttribute('width', String(size));
    svg.setAttribute('height', String(size));
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '2');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');

    const file = document.createElementNS(svgNS, 'path');
    file.setAttribute('d', 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z');
    const fold = document.createElementNS(svgNS, 'path');
    fold.setAttribute('d', 'M14 2v6h6');
    const line1 = document.createElementNS(svgNS, 'path');
    line1.setAttribute('d', 'M8 13h8');
    const line2 = document.createElementNS(svgNS, 'path');
    line2.setAttribute('d', 'M8 17h5');
    svg.appendChild(file);
    svg.appendChild(fold);
    svg.appendChild(line1);
    svg.appendChild(line2);
    return svg;
}

async function downloadCurrentProductCardPpt(button) {
    const data = extractProductDataFromPage();
    if (!data.title && !data.sku) {
        showProductCardStatus('Could not find product data for PPT.', 'error');
        return;
    }

    const originalTitle = button ? button.title : '';
    const label = button ? button.querySelector('.les-product-card-ppt-label') : null;
    const originalLabel = label ? label.textContent : '';
    if (button) {
        button.disabled = true;
        button.classList.add('is-loading');
        button.title = 'Generating PPT...';
        if (label) label.textContent = 'Generating PPT...';
    }

    try {
        await generateProductCardPptx(data);
        showProductCardStatus('Product card PPT downloaded.', 'success');
    } catch (error) {
        console.error('LES: Failed to create product card PPT:', error);
        showProductCardStatus(getProductCardUserErrorMessage(error), 'error');
    } finally {
        if (button) {
            button.disabled = false;
            button.classList.remove('is-loading');
            button.title = originalTitle || 'Download product card as PPT';
            if (label) label.textContent = originalLabel || 'PPT';
        }
    }
}

function cleanupProductCardPptButton() {
    const btn = document.querySelector('.les-product-card-ppt-btn');
    if (btn) btn.remove();
    const buttonsBar = document.querySelector('.les-buttons-bar');
    if (buttonsBar && buttonsBar.children.length === 0) buttonsBar.remove();
}

function ensureProductCardPptButton() {
    if (isListPage() || !getProductNameElement()) {
        cleanupProductCardPptButton();
        return;
    }

    let btn = document.querySelector('.les-product-card-ppt-btn');
    if (!btn) {
        btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'les-product-card-ppt-btn';
        btn.title = 'Download product card as PPT';
        btn.setAttribute('aria-label', 'Download product card as PPT');

        const label = document.createElement('span');
        label.className = 'les-product-card-ppt-label';
        label.textContent = 'PPT';
        btn.appendChild(createProductCardPptSvg(14));
        btn.appendChild(label);

        btn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            downloadCurrentProductCardPpt(btn);
        });
    }

    const buttonsBar = ensureProductActionBar();
    if (buttonsBar && btn.parentElement !== buttonsBar) {
        const complianceBtn = buttonsBar.querySelector('.lekolar-compliance-btn');
        if (complianceBtn) buttonsBar.insertBefore(btn, complianceBtn);
        else buttonsBar.appendChild(btn);
    }
}

function getSwedishReferencePanel() {
    return document.querySelector('.les-sv-reference-panel');
}

function ensureSwedishReferencePanel() {
    let panel = getSwedishReferencePanel();
    if (panel) return panel;

    panel = document.createElement('section');
    panel.className = 'les-sv-reference-panel';
    const header = lesCreateElement(
        'div',
        { className: 'les-sv-reference-header' },
        lesCreateElement(
            'div',
            {},
            lesCreateElement('strong', { text: 'Swedish source text' }),
            lesCreateElement('div', { className: 'les-sv-reference-subtitle', text: 'Original Swedish product text for quick reference.' })
        ),
        lesCreateElement('button', { type: 'button', className: 'les-sv-reference-close', text: 'Close', attrs: { 'aria-label': 'Close Swedish reference' } })
    );
    const status = lesCreateElement('div', { className: 'les-sv-reference-status', text: 'Loading Swedish reference...' });
    const body = lesCreateElement('div', { className: 'les-sv-reference-body' });
    const actions = lesCreateElement('div', { className: 'les-sv-reference-actions' });
    body.hidden = true;
    actions.hidden = true;
    panel.appendChild(header);
    panel.appendChild(status);
    panel.appendChild(body);
    panel.appendChild(actions);

    const descriptionContainer = document.querySelector('.product-info .description');
    if (descriptionContainer) {
        descriptionContainer.insertAdjacentElement('afterend', panel);
    } else {
        const productInfo = document.querySelector('.product-info');
        if (productInfo) productInfo.appendChild(panel);
    }

    const closeBtn = panel.querySelector('.les-sv-reference-close');
    if (closeBtn) closeBtn.addEventListener('click', () => panel.remove());

    return panel;
}

function updateSwedishReferenceButtonState(button, state) {
    if (!button) return;
    const label = button.querySelector('.les-sv-reference-label');
    if (state === 'loading') {
        button.disabled = true;
        if (label) label.textContent = 'Loading SV text...';
    } else {
        button.disabled = false;
        if (label) label.textContent = 'SV text';
    }
}

function fetchHtmlThroughBackground(url) {
    return new Promise((resolve, reject) => {
        chrome.runtime.sendMessage({ action: 'lesFetchRemoteHtml', url }, (response) => {
            if (chrome.runtime.lastError) {
                reject(new Error(chrome.runtime.lastError.message));
                return;
            }
            if (!response || response.ok !== true || typeof response.html !== 'string') {
                const error = new Error((response && response.error) ? response.error : 'fetch_failed');
                if (response && response.status) error.status = response.status;
                if (response && response.url) error.url = response.url;
                reject(error);
                return;
            }
            resolve(response);
        });
    });
}

function lesHasExternalServicesConsentFromStorage() {
    return new Promise(resolve => {
        try {
            chrome.storage.sync.get('externalServicesConsent', data => {
                resolve(!!(data && data.externalServicesConsent));
            });
        } catch (_) {
            resolve(false);
        }
    });
}

const LES_TRANSLATE_BTN_CONSENT_TOOLTIP =
    'External services are off. Enable them in the Lekolar Enhancer settings (General → External services) to allow translation via MyMemory.';

function lesApplyConsentStateToTranslateButton(btn, hasConsent) {
    if (!btn) return;
    if (hasConsent) {
        btn.classList.remove('les-sv-reference-translate-btn-blocked');
        btn.disabled = false;
        btn.removeAttribute('aria-disabled');
        btn.removeAttribute('title');
        return;
    }
    btn.classList.add('les-sv-reference-translate-btn-blocked');
    btn.disabled = true;
    btn.setAttribute('aria-disabled', 'true');
    btn.title = LES_TRANSLATE_BTN_CONSENT_TOOLTIP;
    // Drop any cached translation so re-enabling consent forces a fresh fetch
    // through the background gate rather than reusing stale text.
    delete btn.dataset.translatedText;
}

try {
    chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'sync') return;
        if (!Object.prototype.hasOwnProperty.call(changes, 'externalServicesConsent')) return;
        const hasConsent = !!changes.externalServicesConsent.newValue;
        document.querySelectorAll('.les-sv-reference-translate-btn').forEach(btn => {
            lesApplyConsentStateToTranslateButton(btn, hasConsent);
        });
    });
} catch (_) {
    // No live updates if storage.onChanged is unavailable; the on-render check still applies.
}

function requestInlineTranslation(text, targetLang) {
    return new Promise((resolve, reject) => {
        chrome.runtime.sendMessage(
            {
                action: 'lesTranslateText',
                text,
                sourceLang: 'sv',
                targetLang
            },
            (response) => {
                if (chrome.runtime.lastError) {
                    reject(new Error(chrome.runtime.lastError.message));
                    return;
                }
                if (!response || response.ok !== true || !response.translation) {
                    reject(new Error((response && response.error) ? response.error : 'translation_failed'));
                    return;
                }
                resolve(response.translation);
            }
        );
    });
}

async function fetchHtmlDocument(url) {
    try {
        const result = await fetchHtmlThroughBackground(url);
        const parser = new DOMParser();
        const doc = parser.parseFromString(result.html, 'text/html');
        doc.__lesFetchedUrl = result.url || url;
        return doc;
    } catch (error) {
        const nextError = new Error((error && error.message) ? error.message : 'NetworkError when attempting to fetch resource.');
        if (error && error.status) nextError.status = error.status;
        if (error && error.url) nextError.url = error.url;
        throw nextError;
    }
}

function getRemoteFetchStatus(error) {
    if (error && Number(error.status) > 0) return Number(error.status);
    const message = (error && error.message) ? error.message : String(error || '');
    const match = message.match(/^http_(\d{3})$/i);
    return match ? Number(match[1]) : 0;
}

function isMissingRemotePageError(error) {
    const status = getRemoteFetchStatus(error);
    return status === 404 || status === 410;
}

function formatSwedishReferenceError(error) {
    const message = (error && error.message) ? error.message : String(error || '');
    if (isMissingRemotePageError(error) || message === 'Could not find Swedish product page') {
        return 'No Swedish product page found for this item.';
    }
    if (message === 'Swedish description was empty') {
        return 'The Swedish page was found, but it has no product text.';
    }
    if (message === 'timeout') {
        return 'Swedish lookup timed out. Please try again.';
    }

    const status = getRemoteFetchStatus(error);
    if (status) return `Swedish lookup failed (HTTP ${status}).`;
    return message || 'Could not load Swedish reference.';
}

// --- Product Tree Explorer ---

const PRODUCT_TREE_TOP_CATEGORIES = [
    {
        menuId: '289134',
        title: 'Kalusteet & sisustus',
        aliases: ['Kaluste- & sisustusvalikoima'],
        roots: [
            { title: 'Kalusteet & sisustus', path: '/verkkokauppa/kaluste-sisustusvalikoima/' }
        ]
    },
    {
        menuId: '289135',
        title: 'Kuvataide & askartelu',
        roots: [
            { title: 'Kuvataide & askartelu', path: '/verkkokauppa/kuvataide-askartelu/' }
        ]
    },
    {
        menuId: '289136',
        title: 'Leikki & pelit',
        aliases: ['Lelut', 'Ulkoleikkikenttä'],
        roots: [
            { title: 'Lelut', path: '/verkkokauppa/lelut/' },
            { title: 'Ulkoleikkikenttä', path: '/verkkokauppa/ulkoleikkikentta/' }
        ]
    },
    {
        menuId: '289137',
        title: 'Opetusvälineet',
        roots: [
            { title: 'Opetusvälineet', path: '/verkkokauppa/opetusvalineet/' }
        ]
    },
    {
        menuId: '289139',
        title: 'Lastenrattaat & -tarvikkeet',
        roots: [
            { title: 'Lastenrattaat & -tarvikkeet', path: '/verkkokauppa/lastenrattaat-tarvikkeet/' }
        ]
    },
    {
        menuId: '289138',
        title: 'Koulu- & toimistotarvikkeet',
        aliases: ['Opiskelu- & toimistotarvikkeet'],
        roots: [
            { title: 'Koulu- & toimistotarvikkeet', path: '/verkkokauppa/opiskelu-toimistotarvikkeet/' }
        ]
    },
    {
        menuId: '289141',
        title: 'Kalenterit & painotuotteet',
        aliases: ['Kalenterit ja painotuotteet'],
        roots: [
            { title: 'Kalenterit & painotuotteet', path: '/verkkokauppa/painettu-materiaali/kalenterit-ja-painotuotteet/' }
        ]
    }
];

const PRODUCT_TREE_CACHE_TTL_MS = 30 * 60 * 1000;
const PRODUCT_TREE_MAX_PAGES = 180;
const PRODUCT_TREE_MAX_DEPTH = 5;
const productTreeCache = new Map();
let productTreeModalKeyHandler = null;

function normalizeProductTreeText(value) {
    return normalizeWhitespace(value)
        .toLowerCase()
        .replace(/&/g, 'ja')
        .replace(/[.,:;()[\]{}]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function createProductTreeSvg(size = 16) {
    const svgNS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(svgNS, 'svg');
    svg.setAttribute('xmlns', svgNS);
    svg.setAttribute('width', String(size));
    svg.setAttribute('height', String(size));
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '2');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');

    const paths = [
        'M12 3v6',
        'M6 9h12',
        'M6 9v4',
        'M18 9v4',
        'M12 9v4',
        'M4 17h4',
        'M10 17h4',
        'M16 17h4'
    ];

    paths.forEach(value => {
        const path = document.createElementNS(svgNS, 'path');
        path.setAttribute('d', value);
        svg.appendChild(path);
    });

    return svg;
}

function createProductTreeRefreshSvg(size = 16) {
    const svgNS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(svgNS, 'svg');
    svg.setAttribute('xmlns', svgNS);
    svg.setAttribute('width', String(size));
    svg.setAttribute('height', String(size));
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '2');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');

    const arc = document.createElementNS(svgNS, 'path');
    arc.setAttribute('d', 'M21 12a9 9 0 0 1-15.5 6.2');
    const arrow = document.createElementNS(svgNS, 'path');
    arrow.setAttribute('d', 'M3 12a9 9 0 0 1 15.5-6.2');
    const head1 = document.createElementNS(svgNS, 'path');
    head1.setAttribute('d', 'M18 3v4h4');
    const head2 = document.createElementNS(svgNS, 'path');
    head2.setAttribute('d', 'M6 21v-4H2');

    svg.appendChild(arc);
    svg.appendChild(arrow);
    svg.appendChild(head1);
    svg.appendChild(head2);
    return svg;
}

function makeProductTreeUrl(path) {
    try {
        return new URL(path, window.location.origin).href;
    } catch (_) {
        return '';
    }
}

function normalizeProductTreeUrl(url) {
    if (!url) return '';
    try {
        const parsed = new URL(url, window.location.href);
        parsed.hash = '';
        parsed.search = '';
        if (!parsed.pathname.endsWith('/')) parsed.pathname += '/';
        return parsed.href;
    } catch (_) {
        return '';
    }
}

function getProductTreePathParts(url) {
    try {
        const parsed = new URL(url, window.location.href);
        return parsed.pathname.split('/').filter(Boolean);
    } catch (_) {
        return [];
    }
}

function getProductTreeDepth(url) {
    return getProductTreePathParts(url).length;
}

function productTreeHumanizeSegment(segment) {
    const decoded = decodeURIComponent(String(segment || ''));
    const text = normalizeWhitespace(decoded.replace(/-/g, ' '));
    return text ? text.charAt(0).toUpperCase() + text.slice(1) : '';
}

function createProductTreeNode(title, url = '') {
    return {
        title: normalizeWhitespace(title || ''),
        url: normalizeProductTreeUrl(url),
        children: []
    };
}

function getProductTreeConfigKey(config) {
    return normalizeProductTreeText(config && config.title);
}

function getProductTreeRootUrls(config) {
    return (config.roots || [])
        .map(root => ({
            title: root.title || config.title,
            url: normalizeProductTreeUrl(makeProductTreeUrl(root.path || root.url || ''))
        }))
        .filter(root => root.url);
}

function isProductTreeUrlUnderConfig(url, config) {
    const normalized = normalizeProductTreeUrl(url);
    if (!normalized) return false;
    return getProductTreeRootUrls(config).some(root => normalized.startsWith(root.url));
}

function getProductTreeConfigForMenuItem(item) {
    if (!item) return null;
    const menuId = item.dataset ? normalizeWhitespace(item.dataset.id || '') : '';
    const anchor = item.querySelector('a');
    const text = normalizeProductTreeText(anchor ? (anchor.getAttribute('title') || anchor.textContent) : item.textContent);

    return PRODUCT_TREE_TOP_CATEGORIES.find(config => {
        if (menuId && config.menuId === menuId) return true;
        const labels = [config.title, ...(config.aliases || [])].map(normalizeProductTreeText);
        return labels.includes(text);
    }) || null;
}

function injectProductTreeButtons() {
    if (!document.body) return;
    document.querySelectorAll('.top-menu-item').forEach(item => {
        const config = getProductTreeConfigForMenuItem(item);
        if (!config || item.querySelector('.les-product-tree-open-btn')) return;

        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'les-product-tree-open-btn';
        button.title = `Open ${config.title} tree`;
        button.setAttribute('aria-label', `Open ${config.title} tree`);
        button.appendChild(createProductTreeSvg(15));
        button.addEventListener('click', (event) => {
            event.preventDefault();
            event.stopPropagation();
            openProductTreeModal(config);
        });

        item.classList.add('les-product-tree-menu-item');
        const icon = item.querySelector(':scope > i');
        const anchor = item.querySelector(':scope > a');
        if (icon) {
            item.insertBefore(button, icon);
        } else if (anchor && anchor.nextSibling) {
            item.insertBefore(button, anchor.nextSibling);
        } else {
            item.appendChild(button);
        }
    });
}

function formatExternalServiceError(error) {
    const message = (error && error.message) ? error.message : String(error || '');
    if (message === 'external_services_consent_required') {
        return 'Allow external services in Settings before translating text.';
    }
    return message || 'unknown_error';
}

function cleanupProductTreeUi() {
    document.querySelectorAll('.les-product-tree-open-btn').forEach(button => button.remove());
    document.querySelectorAll('.les-product-tree-menu-item').forEach(item => item.classList.remove('les-product-tree-menu-item'));
    closeProductTreeModal();
}

function closeProductTreeModal() {
    const modal = document.querySelector('.les-product-tree-modal-backdrop');
    if (modal) modal.remove();
    document.body.classList.remove('les-product-tree-modal-open');
    if (productTreeModalKeyHandler) {
        document.removeEventListener('keydown', productTreeModalKeyHandler);
        productTreeModalKeyHandler = null;
    }
}

function ensureProductTreeModal(config) {
    closeProductTreeModal();

    const backdrop = document.createElement('div');
    backdrop.className = 'les-product-tree-modal-backdrop';

    const modal = document.createElement('div');
    modal.className = 'les-product-tree-modal';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('aria-label', `${config.title} tree`);

    const header = document.createElement('div');
    header.className = 'les-product-tree-modal-header';

    const titleWrap = document.createElement('div');
    const title = document.createElement('h2');
    title.textContent = config.title;
    const status = document.createElement('div');
    status.className = 'les-product-tree-status';
    status.textContent = '';
    titleWrap.appendChild(title);
    titleWrap.appendChild(status);

    const actions = document.createElement('div');
    actions.className = 'les-product-tree-modal-actions';

    const refresh = document.createElement('button');
    refresh.type = 'button';
    refresh.className = 'les-product-tree-icon-btn les-product-tree-refresh';
    refresh.title = 'Reload tree';
    refresh.setAttribute('aria-label', 'Reload tree');
    refresh.appendChild(createProductTreeRefreshSvg(16));

    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'les-product-tree-icon-btn les-product-tree-close';
    close.title = 'Close';
    close.setAttribute('aria-label', 'Close');
    close.textContent = '×';

    actions.appendChild(refresh);
    actions.appendChild(close);
    header.appendChild(titleWrap);
    header.appendChild(actions);

    const toolbar = document.createElement('div');
    toolbar.className = 'les-product-tree-toolbar';

    const search = document.createElement('input');
    search.type = 'search';
    search.className = 'les-product-tree-filter';
    search.placeholder = 'Filter categories';
    search.setAttribute('aria-label', 'Filter categories');

    const rootUrls = getProductTreeRootUrls(config);
    const rootLink = document.createElement('a');
    rootLink.className = 'les-product-tree-root-link';
    rootLink.href = rootUrls[0] ? rootUrls[0].url : '#';
    rootLink.target = '_blank';
    rootLink.rel = 'noopener noreferrer';
    rootLink.textContent = 'Open root';
    if (!rootUrls[0]) rootLink.hidden = true;

    toolbar.appendChild(search);
    toolbar.appendChild(rootLink);

    const body = document.createElement('div');
    body.className = 'les-product-tree-modal-body';

    modal.appendChild(header);
    modal.appendChild(toolbar);
    modal.appendChild(body);
    backdrop.appendChild(modal);

    backdrop.addEventListener('click', (event) => {
        if (event.target === backdrop) closeProductTreeModal();
    });
    close.addEventListener('click', closeProductTreeModal);
    refresh.addEventListener('click', () => loadProductTreeIntoModal(backdrop, config, true));
    search.addEventListener('input', () => filterProductTree(backdrop, search.value));

    productTreeModalKeyHandler = (event) => {
        if (event.key === 'Escape') closeProductTreeModal();
    };
    document.addEventListener('keydown', productTreeModalKeyHandler);

    document.body.appendChild(backdrop);
    document.body.classList.add('les-product-tree-modal-open');
    search.focus({ preventScroll: true });
    return backdrop;
}

function renderProductTreeLoading(modal, message) {
    const body = modal.querySelector('.les-product-tree-modal-body');
    const status = modal.querySelector('.les-product-tree-status');
    if (status) status.textContent = normalizeWhitespace(message || 'Loading tree...');
    if (!body) return;
    lesReplaceChildren(
        body,
        lesCreateElement(
            'div',
            { className: 'les-product-tree-loading' },
            lesCreateElement('div', { className: 'lekolar-spinner' }),
            lesCreateElement('span', { text: 'Loading tree...' })
        )
    );
}

function renderProductTreeError(modal, message) {
    const body = modal.querySelector('.les-product-tree-modal-body');
    const status = modal.querySelector('.les-product-tree-status');
    if (status) status.textContent = 'Could not load tree';
    if (!body) return;
    lesReplaceChildren(body);
    const error = document.createElement('div');
    error.className = 'les-product-tree-empty';
    error.textContent = message || 'Could not load category tree.';
    body.appendChild(error);
}

function isProductTreeChildUrl(parentUrl, childUrl, config) {
    const parent = normalizeProductTreeUrl(parentUrl);
    const child = normalizeProductTreeUrl(childUrl);
    if (!parent || !child || parent === child) return false;
    if (!isProductTreeUrlUnderConfig(child, config)) return false;
    if (!child.startsWith(parent)) return false;
    return getProductTreeDepth(child) === getProductTreeDepth(parent) + 1;
}

function getProductTreeLinkTitle(anchor) {
    if (!anchor) return '';
    const title = normalizeWhitespace(anchor.getAttribute('title') || anchor.getAttribute('aria-label') || '');
    if (title) return title;
    const clone = anchor.cloneNode(true);
    clone.querySelectorAll('img, svg, i, button').forEach(el => el.remove());
    return normalizeWhitespace(clone.textContent || '');
}

function extractProductTreeChildLinks(doc, parentUrl, config) {
    const selectors = [
        '.category-button-navigation a.category-button[href]',
        '.category-button-navigation a[href]',
        '.category-navigation a.category-button[href]',
        '.category-navigation .card a[href]',
        '.category-page .on-screen-navigation a[href]',
        '.category-page .category-navigation a[href]'
    ];
    let anchors = [];
    selectors.forEach(selector => {
        anchors.push(...Array.from(doc.querySelectorAll(selector)));
    });

    if (anchors.length === 0) {
        const root = doc.querySelector('.category-page, main, .wrapper.main') || doc.body || doc;
        anchors = Array.from(root.querySelectorAll('a[href*="/verkkokauppa/"]'));
    }

    const seen = new Set();
    const links = [];
    anchors.forEach(anchor => {
        const url = normalizeProductTreeUrl(anchor.href || anchor.getAttribute('href'));
        if (!url || seen.has(url)) return;
        if (!isProductTreeChildUrl(parentUrl, url, config)) return;
        if (anchor.closest('.product-tiles, .product-list, .products-grid, .category-product, .product-item, .product-list-item, .price-buy-info, .buy-info')) return;

        const title = getProductTreeLinkTitle(anchor);
        if (!title) return;

        seen.add(url);
        links.push({ title, url });
    });
    return links;
}

function addProductTreePath(root, config, url, title) {
    const normalized = normalizeProductTreeUrl(url);
    const rootUrls = getProductTreeRootUrls(config);
    const rootMatch = rootUrls.find(rootUrl => normalized.startsWith(rootUrl.url));
    if (!rootMatch) return;

    const baseParts = getProductTreePathParts(rootMatch.url);
    const parts = getProductTreePathParts(normalized).slice(baseParts.length);
    let current = root;

    if (rootUrls.length > 1) {
        let group = current.children.find(child => child.url === rootMatch.url);
        if (!group) {
            group = createProductTreeNode(rootMatch.title, rootMatch.url);
            current.children.push(group);
        }
        current = group;
    }

    if (parts.length === 0) return;
    parts.forEach((part, index) => {
        const isLast = index === parts.length - 1;
        const nextUrl = new URL(rootMatch.url);
        const nextParts = [...baseParts, ...parts.slice(0, index + 1)];
        nextUrl.pathname = `/${nextParts.join('/')}/`;
        const nodeUrl = normalizeProductTreeUrl(nextUrl.href);
        let child = current.children.find(item => item.url === nodeUrl);
        if (!child) {
            child = createProductTreeNode(isLast ? title : productTreeHumanizeSegment(part), nodeUrl);
            current.children.push(child);
        } else if (isLast && title) {
            child.title = title;
        }
        current = child;
    });
}

function buildProductTreeFromLoadedLinks(config) {
    const root = createProductTreeNode(config.title, '');
    const anchors = Array.from(document.querySelectorAll(
        '.js-headerAssortmentPlaceholder a[href], .js-mega-menu a[href], .mega-menu a[href], .category-button-navigation a[href], .breadcrumb a[href]'
    ));

    anchors.forEach(anchor => {
        const url = normalizeProductTreeUrl(anchor.href || anchor.getAttribute('href'));
        if (!url || !isProductTreeUrlUnderConfig(url, config)) return;
        addProductTreePath(root, config, url, getProductTreeLinkTitle(anchor));
    });

    return countProductTreeNodes(root) > 0 ? root : null;
}

async function getProductTreeDocument(url) {
    const normalized = normalizeProductTreeUrl(url);
    if (normalized && normalized === normalizeProductTreeUrl(window.location.href)) {
        return document;
    }
    return fetchHtmlDocument(normalized || url);
}

async function resolveProductTree(config, options = {}) {
    const cacheKey = getProductTreeConfigKey(config);
    const cached = productTreeCache.get(cacheKey);
    if (!options.forceRefresh && cached && Date.now() - cached.checkedAt < PRODUCT_TREE_CACHE_TTL_MS) {
        return cached.tree;
    }

    const rootUrls = getProductTreeRootUrls(config);
    const tree = createProductTreeNode(config.title, rootUrls.length === 1 ? rootUrls[0].url : '');
    const queue = [];
    const visited = new Set();
    let pageCount = 0;
    let hitLimit = false;

    rootUrls.forEach(rootUrl => {
        if (rootUrls.length > 1) {
            const group = createProductTreeNode(rootUrl.title, rootUrl.url);
            tree.children.push(group);
            queue.push({ node: group, url: rootUrl.url, depth: 0 });
        } else {
            queue.push({ node: tree, url: rootUrl.url, depth: 0 });
        }
    });

    while (queue.length > 0) {
        if (pageCount >= PRODUCT_TREE_MAX_PAGES) {
            hitLimit = true;
            break;
        }

        const current = queue.shift();
        const normalizedUrl = normalizeProductTreeUrl(current.url);
        if (!normalizedUrl || visited.has(normalizedUrl) || current.depth > PRODUCT_TREE_MAX_DEPTH) continue;

        visited.add(normalizedUrl);
        pageCount += 1;
        if (typeof options.onProgress === 'function') {
            options.onProgress(`Scanning ${pageCount} pages...`);
        }

        let doc;
        try {
            doc = await getProductTreeDocument(normalizedUrl);
        } catch (error) {
            if (current.depth === 0 && countProductTreeNodes(tree) === 0) {
                const loadedTree = buildProductTreeFromLoadedLinks(config);
                if (loadedTree) return loadedTree;
                throw error;
            }
            continue;
        }

        const children = extractProductTreeChildLinks(doc, normalizedUrl, config);
        children.forEach(childLink => {
            let child = current.node.children.find(item => item.url === childLink.url);
            if (!child) {
                child = createProductTreeNode(childLink.title, childLink.url);
                current.node.children.push(child);
            }
            if (!visited.has(child.url) && current.depth < PRODUCT_TREE_MAX_DEPTH) {
                queue.push({ node: child, url: child.url, depth: current.depth + 1 });
            }
        });
    }

    tree.__lesStats = {
        pages: pageCount,
        hitLimit
    };

    if (countProductTreeNodes(tree) === 0) {
        const loadedTree = buildProductTreeFromLoadedLinks(config);
        if (loadedTree) return loadedTree;
    }

    productTreeCache.set(cacheKey, { tree, checkedAt: Date.now() });
    return tree;
}

function countProductTreeNodes(node) {
    if (!node || !node.children) return 0;
    return node.children.reduce((sum, child) => sum + 1 + countProductTreeNodes(child), 0);
}

function createProductTreeList(nodes, level = 0) {
    const list = document.createElement('ul');
    list.className = level === 0 ? 'les-product-tree-list les-product-tree-root-list' : 'les-product-tree-list';

    nodes.forEach(node => {
        const item = document.createElement('li');
        item.className = 'les-product-tree-item';
        item.dataset.treeText = normalizeProductTreeText(node.title);

        const line = document.createElement('div');
        line.className = 'les-product-tree-line';

        if (node.url) {
            const link = document.createElement('a');
            link.href = node.url;
            link.target = '_blank';
            link.rel = 'noopener noreferrer';
            link.textContent = node.title;
            line.appendChild(link);
        } else {
            const label = document.createElement('span');
            label.textContent = node.title;
            line.appendChild(label);
        }

        if (node.children && node.children.length > 0) {
            const count = document.createElement('span');
            count.className = 'les-product-tree-child-count';
            count.textContent = String(countProductTreeNodes(node));
            line.appendChild(count);
            item.appendChild(line);
            item.appendChild(createProductTreeList(node.children, level + 1));
        } else {
            item.appendChild(line);
        }

        list.appendChild(item);
    });

    return list;
}

function renderProductTree(modal, tree) {
    const body = modal.querySelector('.les-product-tree-modal-body');
    const status = modal.querySelector('.les-product-tree-status');
    if (!body) return;
    lesReplaceChildren(body);

    const total = countProductTreeNodes(tree);
    if (status) {
        const pages = tree.__lesStats && tree.__lesStats.pages ? `, ${tree.__lesStats.pages} pages scanned` : '';
        const limited = tree.__lesStats && tree.__lesStats.hitLimit ? ', limited' : '';
        status.textContent = `${total} categories${pages}${limited}`;
    }

    if (!tree.children || tree.children.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'les-product-tree-empty';
        empty.textContent = 'No category links found.';
        body.appendChild(empty);
        return;
    }

    const board = document.createElement('div');
    board.className = 'les-product-tree-board';
    board.appendChild(createProductTreeList(tree.children));
    body.appendChild(board);
}

function filterProductTree(modal, rawQuery) {
    const query = normalizeProductTreeText(rawQuery);
    const items = Array.from(modal.querySelectorAll('.les-product-tree-item'));

    if (!query) {
        items.forEach(item => { item.hidden = false; });
        return;
    }

    [...items].reverse().forEach(item => {
        const ownMatch = (item.dataset.treeText || '').includes(query);
        const childMatch = Array.from(item.children).some(child =>
            child.classList && child.classList.contains('les-product-tree-list') &&
            Array.from(child.children).some(grandChild => !grandChild.hidden)
        );
        item.hidden = !(ownMatch || childMatch);
    });
}

async function loadProductTreeIntoModal(modal, config, forceRefresh = false) {
    renderProductTreeLoading(modal, 'Loading tree...');
    const refresh = modal.querySelector('.les-product-tree-refresh');
    if (refresh) refresh.disabled = true;
    try {
        const tree = await resolveProductTree(config, {
            forceRefresh,
            onProgress: (message) => {
                const status = modal.querySelector('.les-product-tree-status');
                if (status) status.textContent = message;
            }
        });
        renderProductTree(modal, tree);
        filterProductTree(modal, modal.querySelector('.les-product-tree-filter')?.value || '');
    } catch (error) {
        renderProductTreeError(modal, (error && error.message) ? error.message : 'Could not load category tree.');
    } finally {
        if (refresh) refresh.disabled = false;
    }
}

function openProductTreeModal(config) {
    if (!config || !document.body) return;
    const modal = ensureProductTreeModal(config);
    loadProductTreeIntoModal(modal, config, false);
}

function initProductTreeExplorer() {
    if (!document.body) return;
    injectProductTreeButtons();
}

// --- Product Comparison ---

const COMPARE_STORAGE_KEY = 'lesProductComparisonItems';
const LIST_STORAGE_KEY = 'lesProductListItems';
const COMPARE_MIN_ITEMS = 2;
const COMPARE_MAX_ITEMS = 4;
const comparisonDetailsCache = new Map();
const productNumberFetchPromises = new Map();
let comparisonItems = [];
let comparisonStateLoaded = false;
let comparisonStateLoadPromise = null;
let comparisonUiRefreshQueued = false;
let listItems = [];
let listStateLoaded = false;
let listStateLoadPromise = null;

function normalizeCompareUrl(url) {
    if (!url) return '';
    try {
        const parsed = new URL(url, window.location.href);
        const variant = parsed.searchParams.get('variant');
        parsed.hash = '';
        parsed.search = '';
        if (variant) parsed.searchParams.set('variant', variant);
        return parsed.href;
    } catch (_) {
        return String(url || '').trim();
    }
}

function getCompareItemId(item) {
    return (item && item.id) || `url:${normalizeCompareUrl(item && item.url)}`;
}

function sanitizeCompareItem(raw) {
    if (!raw || !raw.url) return null;

    const url = normalizeCompareUrl(raw.url);
    const name = normalizeWhitespace(raw.name || raw.title || '');
    if (!url || !name) return null;

    return {
        id: raw.id || `url:${url}`,
        url,
        name,
        imageUrl: raw.imageUrl || '',
        articleNumber: normalizeWhitespace(raw.articleNumber || ''),
        shortDescription: normalizeWhitespace(raw.shortDescription || raw.description || ''),
        flags: Array.isArray(raw.flags) ? uniqueNonEmpty(raw.flags).slice(0, 8) : [],
        source: raw.source || 'unknown',
        dimensions: raw.dimensions || {},
        materials: Array.isArray(raw.materials) ? uniqueNonEmpty(raw.materials) : [],
        environmentalLabels: Array.isArray(raw.environmentalLabels) ? uniqueNonEmpty(raw.environmentalLabels) : [],
        toxicFree: raw.toxicFree || '',
        series: normalizeWhitespace(raw.series || ''),
        seatHeight: normalizeWhitespace(raw.seatHeight || ''),
        price: raw.price && typeof raw.price === 'object' ? { value: Number(raw.price.value) || 0, display: normalizeWhitespace(raw.price.display || '') } : null,
        productProperties: Array.isArray(raw.productProperties) ? raw.productProperties : [],
        loadError: raw.loadError || '',
        fetchedAt: raw.fetchedAt || 0
    };
}

function uniqueNonEmpty(values) {
    const seen = new Set();
    const result = [];
    values.forEach(value => {
        const text = normalizeWhitespace(value);
        if (!text) return;
        const key = text.toLowerCase();
        if (seen.has(key)) return;
        seen.add(key);
        result.push(text);
    });
    return result;
}

function ensureComparisonStateLoaded() {
    if (comparisonStateLoaded) return Promise.resolve(comparisonItems);
    if (comparisonStateLoadPromise) return comparisonStateLoadPromise;

    comparisonStateLoadPromise = storageLocalGet(COMPARE_STORAGE_KEY)
        .then(data => {
            const stored = data && Array.isArray(data[COMPARE_STORAGE_KEY]) ? data[COMPARE_STORAGE_KEY] : [];
            comparisonItems = stored
                .map(sanitizeCompareItem)
                .filter(Boolean)
                .slice(0, COMPARE_MAX_ITEMS);
            comparisonStateLoaded = true;
            return comparisonItems;
        })
        .catch(error => {
            console.warn('LES: Could not load product comparison state', error);
            comparisonItems = [];
            comparisonStateLoaded = true;
            return comparisonItems;
        })
        .finally(() => {
            comparisonStateLoadPromise = null;
        });

    return comparisonStateLoadPromise;
}

function persistComparisonState() {
    return storageLocalSet({ [COMPARE_STORAGE_KEY]: comparisonItems }).catch(error => {
        console.warn('LES: Could not save product comparison state', error);
    });
}

function queueComparisonUiRefresh() {
    if (comparisonUiRefreshQueued) return;
    comparisonUiRefreshQueued = true;
    setTimeout(() => {
        comparisonUiRefreshQueued = false;
        renderComparePanel();
        syncCompareButtons();
    syncListButtons();
    }, 0);
}

function ensureListStateLoaded() {
    if (listStateLoaded) return Promise.resolve(listItems);
    if (listStateLoadPromise) return listStateLoadPromise;

    listStateLoadPromise = storageLocalGet(LIST_STORAGE_KEY)
        .then(data => {
            const stored = data && Array.isArray(data[LIST_STORAGE_KEY]) ? data[LIST_STORAGE_KEY] : [];
            listItems = stored.map(sanitizeCompareItem).filter(Boolean);
            listStateLoaded = true;
            return listItems;
        })
        .catch(error => {
            console.warn('LES: Could not load product list state', error);
            listItems = [];
            listStateLoaded = true;
            return listItems;
        })
        .finally(() => {
            listStateLoadPromise = null;
        });

    return listStateLoadPromise;
}

function persistListState() {
    return storageLocalSet({ [LIST_STORAGE_KEY]: listItems }).catch(error => {
        console.warn('LES: Could not save product list state', error);
    });
}

function queueListUiRefresh() {
    queueComparisonUiRefresh(); 
}

function findListIndex(itemOrId) {
    const id = typeof itemOrId === 'string' ? itemOrId : getCompareItemId(itemOrId);
    const url = typeof itemOrId === 'string' ? '' : normalizeCompareUrl(itemOrId && itemOrId.url);
    const articleNumber = typeof itemOrId === 'string' ? '' : normalizeWhitespace(itemOrId && itemOrId.articleNumber);

    return listItems.findIndex(item => {
        if (item.id === id) return true;
        if (url && item.url === url) return true;
        return Boolean(articleNumber && item.articleNumber && item.articleNumber === articleNumber);
    });
}

function isListItemSelected(itemOrId) {
    return findListIndex(itemOrId) >= 0;
}

async function toggleListItem(rawItem) {
    await ensureListStateLoaded();

    const item = sanitizeCompareItem(rawItem);
    if (!item) return;

    const existingIndex = findListIndex(item);
    if (existingIndex >= 0) {
        listItems.splice(existingIndex, 1);
        await persistListState();
        queueListUiRefresh();
        return;
    }

    listItems.push(item);
    await persistListState();
    currentDockTab = 'list';
    queueListUiRefresh();
    showCompareToast('Item added to list.');
}

function findComparisonIndex(itemOrId) {
    const id = typeof itemOrId === 'string' ? itemOrId : getCompareItemId(itemOrId);
    const url = typeof itemOrId === 'string' ? '' : normalizeCompareUrl(itemOrId && itemOrId.url);
    const articleNumber = typeof itemOrId === 'string' ? '' : normalizeWhitespace(itemOrId && itemOrId.articleNumber);

    return comparisonItems.findIndex(item => {
        if (item.id === id) return true;
        if (url && item.url === url) return true;
        return Boolean(articleNumber && item.articleNumber && item.articleNumber === articleNumber);
    });
}

function isCompareItemSelected(itemOrId) {
    return findComparisonIndex(itemOrId) >= 0;
}

async function toggleCompareItem(rawItem) {
    await ensureComparisonStateLoaded();

    const item = sanitizeCompareItem(rawItem);
    if (!item) return;

    const existingIndex = findComparisonIndex(item);
    if (existingIndex >= 0) {
        comparisonItems.splice(existingIndex, 1);
        await persistComparisonState();
        queueComparisonUiRefresh();
        return;
    }

    if (comparisonItems.length >= COMPARE_MAX_ITEMS) {
        showCompareToast(`You can compare up to ${COMPARE_MAX_ITEMS} products at once.`);
        return;
    }

    comparisonItems.push(item);
    await persistComparisonState();
    queueComparisonUiRefresh();
}

function showCompareToast(message) {
    let toast = document.querySelector('.les-compare-toast');
    if (!toast) {
        toast = document.createElement('div');
        toast.className = 'les-compare-toast';
        document.body.appendChild(toast);
    }
    toast.textContent = message;
    toast.classList.add('is-visible');
    clearTimeout(showCompareToast.timer);
    showCompareToast.timer = setTimeout(() => {
        toast.classList.remove('is-visible');
    }, 2600);
}

function createCompareSvg(size = 14) {
    const svgNS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(svgNS, 'svg');
    svg.setAttribute('width', String(size));
    svg.setAttribute('height', String(size));
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '2');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');

    const top = document.createElementNS(svgNS, 'path');
    top.setAttribute('d', 'M18 7H6');
    const topHeadA = document.createElementNS(svgNS, 'path');
    topHeadA.setAttribute('d', 'M9 4 6 7l3 3');
    const bottom = document.createElementNS(svgNS, 'path');
    bottom.setAttribute('d', 'M6 17h12');
    const bottomHeadA = document.createElementNS(svgNS, 'path');
    bottomHeadA.setAttribute('d', 'm15 14 3 3-3 3');
    svg.appendChild(top);
    svg.appendChild(topHeadA);
    svg.appendChild(bottom);
    svg.appendChild(bottomHeadA);
    return svg;
}

function createListSvg(size = 14) {
    const svgNS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(svgNS, 'svg');
    svg.setAttribute('width', String(size));
    svg.setAttribute('height', String(size));
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '2');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');

    const path = document.createElementNS(svgNS, 'path');
    path.setAttribute('d', 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z');
    const poly = document.createElementNS(svgNS, 'polyline');
    poly.setAttribute('points', '14 2 14 8 20 8');
    
    const l1 = document.createElementNS(svgNS, 'line');
    l1.setAttribute('x1', '16');
    l1.setAttribute('y1', '13');
    l1.setAttribute('x2', '8');
    l1.setAttribute('y2', '13');
    const l2 = document.createElementNS(svgNS, 'line');
    l2.setAttribute('x1', '16');
    l2.setAttribute('y1', '17');
    l2.setAttribute('x2', '8');
    l2.setAttribute('y2', '17');
    const l3 = document.createElementNS(svgNS, 'polyline');
    l3.setAttribute('points', '10 9 9 9 8 9');

    const plus1 = document.createElementNS(svgNS, 'line');
    plus1.setAttribute('x1', '19');
    plus1.setAttribute('y1', '3');
    plus1.setAttribute('x2', '19');
    plus1.setAttribute('y2', '7');
    const plus2 = document.createElementNS(svgNS, 'line');
    plus2.setAttribute('x1', '17');
    plus2.setAttribute('y1', '5');
    plus2.setAttribute('x2', '21');
    plus2.setAttribute('y2', '5');

    svg.appendChild(path);
    svg.appendChild(poly);
    svg.appendChild(l1);
    svg.appendChild(l2);
    svg.appendChild(l3);
    svg.appendChild(plus1);
    svg.appendChild(plus2);
    return svg;
}

function createCartSvg(size = 16) {
    const svgNS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(svgNS, 'svg');
    svg.setAttribute('width', String(size));
    svg.setAttribute('height', String(size));
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '2');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.classList.add('les-card-action-icon');

    const circle1 = document.createElementNS(svgNS, 'circle');
    circle1.setAttribute('cx', '9');
    circle1.setAttribute('cy', '21');
    circle1.setAttribute('r', '1');
    const circle2 = document.createElementNS(svgNS, 'circle');
    circle2.setAttribute('cx', '20');
    circle2.setAttribute('cy', '21');
    circle2.setAttribute('r', '1');
    const path = document.createElementNS(svgNS, 'path');
    path.setAttribute('d', 'M1 1h4l2.7 13.4a2 2 0 0 0 2 1.6h8.7a2 2 0 0 0 2-1.6L23 6H6');
    svg.appendChild(circle1);
    svg.appendChild(circle2);
    svg.appendChild(path);
    return svg;
}

function createCopySvg(size = 16) {
    const svgNS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(svgNS, 'svg');
    svg.setAttribute('width', String(size));
    svg.setAttribute('height', String(size));
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '2');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');

    const rect1 = document.createElementNS(svgNS, 'rect');
    rect1.setAttribute('x', '9');
    rect1.setAttribute('y', '9');
    rect1.setAttribute('width', '13');
    rect1.setAttribute('height', '13');
    rect1.setAttribute('rx', '2');
    rect1.setAttribute('ry', '2');
    const path = document.createElementNS(svgNS, 'path');
    path.setAttribute('d', 'M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1');

    svg.appendChild(rect1);
    svg.appendChild(path);
    return svg;
}

function insertCardAction(toolbar, element, order) {
    if (!toolbar || !element) return;
    element.dataset.lesActionOrder = String(order);

    const next = Array.from(toolbar.children).find(child => {
        if (child === element) return false;
        const childOrder = Number(child.dataset.lesActionOrder || 999);
        return childOrder > order;
    });

    toolbar.insertBefore(element, next || null);
}

function findNativeCardBuyControl(card) {
    if (!card) return null;
    return card.querySelector(
        '.price-buy-info .buy-info .product-buy-button, .price-buy-info .buy-info .product-more-info, .price-buy-info .buy-info .js-productBuyButton, ' +
        '.price-buy-info .js-buyInfo .product-buy-button, .price-buy-info .js-buyInfo .product-more-info, .price-buy-info .js-buyInfo .js-productBuyButton, ' +
        '.buy-info .product-buy-button, .buy-info .product-more-info, .buy-info .js-productBuyButton, ' +
        '.js-buyInfo .product-buy-button, .js-buyInfo .product-more-info, .js-buyInfo .js-productBuyButton'
    );
}

function triggerNativeCardBuy(card) {
    const control = findNativeCardBuyControl(card);
    if (!control) return;
    control.click();
}

function ensureCardCartProxy(card, toolbar) {
    if (!card || !toolbar) return;
    if (!findNativeCardBuyControl(card)) return;

    let button = card.querySelector('.les-card-cart-proxy');
    if (!button) {
        button = document.createElement('button');
        button.type = 'button';
        button.className = 'les-card-action-btn les-card-cart-proxy';
        button.appendChild(createCartSvg(16));
        button.addEventListener('click', (event) => {
            event.preventDefault();
            event.stopPropagation();
            triggerNativeCardBuy(card);
        });
    }

    button.title = 'Add to cart or choose option';
    button.setAttribute('aria-label', 'Add to cart or choose option');
    insertCardAction(toolbar, button, 40);
}

function ensureCardActionToolbar(card) {
    if (!card || !isListPage()) return null;

    let toolbar = card.querySelector('.les-card-actions');
    if (!toolbar) {
        toolbar = document.createElement('div');
        toolbar.className = 'les-card-actions';

        const anchor =
            card.querySelector('.price-buy-info') ||
            card.querySelector('.product-info') ||
            card.querySelector('.product-artno, .eS-product-artno, [class*="artno"]');

        if (anchor && anchor.parentElement && anchor.matches('.price-buy-info')) {
            anchor.insertAdjacentElement('beforebegin', toolbar);
        } else if (anchor && anchor.parentElement) {
            anchor.insertAdjacentElement('afterend', toolbar);
        } else {
            card.appendChild(toolbar);
        }
    }

    card.classList.add('les-compact-card-actions');
    ensureCardProductNumberLine(card);
    ensureCardCartProxy(card, toolbar);

    return toolbar;
}

function createCompareButton(meta, className) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = className;
    button.dataset.compareId = meta.id;
    button.__lesCompareMeta = meta;
    button.setAttribute('aria-pressed', 'false');

    const label = document.createElement('span');
    label.className = 'les-compare-btn-label';
    button.appendChild(createCompareSvg(14));
    button.appendChild(label);

    button.addEventListener('click', async (event) => {
        event.preventDefault();
        event.stopPropagation();
        await toggleCompareItem(button.__lesCompareMeta);
    });

    updateCompareButtonState(button);
    return button;
}

function updateCompareButtonState(button) {
    if (!button) return;
    const selected = isCompareItemSelected(button.__lesCompareMeta || button.dataset.compareId);
    const label = button.querySelector('.les-compare-btn-label');
    button.classList.toggle('is-selected', selected);
    button.setAttribute('aria-pressed', selected ? 'true' : 'false');
    button.title = selected ? 'Remove from comparison' : 'Add to comparison';
    button.setAttribute('aria-label', selected ? 'Remove from comparison' : 'Add to comparison');
    if (label) label.textContent = selected ? 'Selected' : 'Compare';
}

function createListButton(meta, className) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = className.replace('les-compare-card-btn', 'les-list-card-btn').replace('les-product-compare-btn', 'les-product-list-btn');
    button.dataset.listId = meta.id;
    button.__lesListMeta = meta;
    button.setAttribute('aria-pressed', 'false');

    const label = document.createElement('span');
    label.className = 'les-list-btn-label';
    button.appendChild(createListSvg(14));
    button.appendChild(label);

    button.addEventListener('click', async (event) => {
        event.preventDefault();
        event.stopPropagation();
        await toggleListItem(button.__lesListMeta);
    });

    updateListButtonState(button);
    return button;
}

function updateListButtonState(button) {
    if (!button) return;
    const selected = isListItemSelected(button.__lesListMeta || button.dataset.listId);
    const label = button.querySelector('.les-list-btn-label');
    button.classList.toggle('is-selected', selected);
    button.setAttribute('aria-pressed', selected ? 'true' : 'false');
    button.title = selected ? 'Remove from list' : 'Add to list';
    button.setAttribute('aria-label', selected ? 'Remove from list' : 'Add to list');
    if (label) label.textContent = selected ? 'Listed' : 'Add to list';
}

function syncListButtons() {
    document.querySelectorAll('.les-list-card-btn, .les-product-list-btn').forEach(updateListButtonState);
}

function syncCompareButtons() {
    document.querySelectorAll('.les-compare-card-btn, .les-product-compare-btn').forEach(updateCompareButtonState);
}

function getProductCardDescription(card) {
    if (!card) return '';
    const description = card.querySelector('.inner-info-description, .product-description, .description');
    return description ? normalizeWhitespace(description.textContent || '') : '';
}

function getProductCardImageUrl(card) {
    if (!card) return '';
    const image = card.querySelector('.center-image img, img.imgBox, img.product-image, img[src]');
    const src = image ? image.getAttribute('src') : '';
    if (!src) return '';
    try {
        return new URL(src, window.location.href).href;
    } catch (_) {
        return src;
    }
}

function extractProductNumberFromCard(card) {
    if (!card) return '';

    const copyBtn = card.querySelector('.les-card-copy-btn[data-value], .lekolar-copy-btn[data-type="number"][data-value]');
    if (copyBtn && copyBtn.dataset.value) return normalizeWhitespace(copyBtn.dataset.value);

    const dataEl = card.querySelector('[data-articlenumber], [data-article-number], [data-articlenr]');
    if (dataEl) {
        const value = dataEl.dataset.articlenumber || dataEl.dataset.articleNumber || dataEl.dataset.articlenr || '';
        if (value) return normalizeWhitespace(value);
    }

    const text = normalizeWhitespace((card.querySelector('.product-artno, .eS-product-artno, [class*="artno"]') || card).textContent || '');
    const match = text.match(/(?:Tuotenro|Art\.nr|Varenr)[\.\s:]*\s*([0-9A-Za-z-]+)/i);
    return match ? match[1] : '';
}

function getCardProductNumberAnchor(card) {
    const nameElement = getProductCardNameElement(card);
    if (!nameElement) return null;

    const nameBlock = nameElement.closest('.product-title, .inner-title, h3, .product-name, .eS-productname');
    const anchor = nameBlock && card.contains(nameBlock) ? nameBlock : nameElement;
    anchor.classList.add('les-card-title-host');
    return anchor;
}

function ensureCardProductNumberLine(card) {
    if (!card) return null;

    let line = card.querySelector('.les-card-product-number');
    if (!line) {
        line = document.createElement('div');
        line.className = 'les-card-product-number';
        line.setAttribute('aria-label', 'Item number');
    }

    const anchor = getCardProductNumberAnchor(card);
    if (anchor && anchor.parentElement && line.previousElementSibling !== anchor) {
        anchor.insertAdjacentElement('afterend', line);
        return line;
    }

    if (!line.parentElement) {
        const description = card.querySelector('.inner-info-description, .product-description, .description');
        if (description && description.parentElement) {
            description.insertAdjacentElement('beforebegin', line);
        } else {
            card.appendChild(line);
        }
    }

    return line;
}

function setCardProductNumber(card, number, button) {
    const cleanNumber = normalizeWhitespace(number || '');
    if (!card || !cleanNumber) return;

    card.querySelectorAll('.les-injected-artno').forEach(el => el.remove());

    const numberLine = ensureCardProductNumberLine(card);
    if (numberLine) {
        numberLine.textContent = cleanNumber;
        numberLine.dataset.value = cleanNumber;
        numberLine.title = `Item number ${cleanNumber}`;
    }

    if (button) {
        button.dataset.value = cleanNumber;
        button.classList.remove('is-loading');
        button.title = `item ${cleanNumber}`;
        button.setAttribute('aria-label', `Copy item ${cleanNumber}`);
    }
}

async function resolveCardProductNumber(card, button) {
    const existing = extractProductNumberFromCard(card);
    if (existing) {
        setCardProductNumber(card, existing, button);
        return existing;
    }

    const url = getProductCardUrl(card);
    if (!url) return '';

    if (fetchedProducts.has(url)) {
        const cached = fetchedProducts.get(url);
        setCardProductNumber(card, cached, button);
        return cached;
    }

    if (!productNumberFetchPromises.has(url)) {
        productNumberFetchPromises.set(url, fetchProductNumberDirect(url).finally(() => {
            productNumberFetchPromises.delete(url);
        }));
    }

    if (button) button.classList.add('is-loading');
    const number = await productNumberFetchPromises.get(url);
    if (number) setCardProductNumber(card, number, button);
    else if (button) button.classList.remove('is-loading');
    return number || '';
}

function ensureCardCopyAction(card) {
    if (!card) return;
    const toolbar = ensureCardActionToolbar(card);
    if (!toolbar) return;

    let button = card.querySelector('.les-card-copy-btn');
    if (!button) {
        button = document.createElement('button');
        button.type = 'button';
        button.className = 'les-card-action-btn les-card-copy-btn';
        button.title = 'Copy item number';
        button.setAttribute('aria-label', 'Copy item number');
        button.appendChild(createCopySvg(16));

        const warmUp = () => {
            if (!button.dataset.value) resolveCardProductNumber(card, button);
        };
        button.addEventListener('mouseenter', warmUp);
        button.addEventListener('focus', warmUp);
        button.addEventListener('click', async (event) => {
            event.preventDefault();
            event.stopPropagation();

            const number = button.dataset.value || await resolveCardProductNumber(card, button);
            if (!number) {
                showCompareToast('Could not find item number.');
                return;
            }

            const text = event[currentSettings.secondaryModifierKey] && getProductCardName(card)
                ? `${number} ${getProductCardName(card)}`
                : number;

            try {
                await navigator.clipboard.writeText(text);
                showCompareToast('Item number copied.');
            } catch (error) {
                console.error('LES: Failed to copy card product number', error);
            }
        });
    }

    const existing = extractProductNumberFromCard(card);
    if (existing) setCardProductNumber(card, existing, button);
    insertCardAction(toolbar, button, 10);
}

function extractComparisonSymbolLabels(root) {
    const labels = [];
    root.querySelectorAll('.symbols img, .symbols [title], .product-flags img, .product-flags [title], [class*="product-flag"] img').forEach(el => {
        const text = el.getAttribute('alt') || el.getAttribute('title') || '';
        if (text) labels.push(text);
    });
    return uniqueNonEmpty(labels);
}

function buildCompareMetaFromCard(card) {
    const url = getProductCardUrl(card);
    if (!url) return null;

    const item = sanitizeCompareItem({
        url,
        name: getProductCardName(card),
        imageUrl: getProductCardImageUrl(card),
        articleNumber: extractProductNumberFromCard(card),
        shortDescription: getProductCardDescription(card),
        flags: extractComparisonSymbolLabels(card),
        price: extractCardDisplayPrice(card),
        source: 'list'
    });

    return item;
}

function buildCompareMetaFromCurrentProduct() {
    if (isListPage()) return null;

    return sanitizeCompareItem({
        url: window.location.href,
        name: getProductName(),
        imageUrl: getMainProductImageUrl(),
        articleNumber: getMainProductNumber(),
        shortDescription: extractProductDescriptionFromDoc(document),
        flags: extractComparisonSymbolLabels(document),
        price: extractLiveProductPagePrice(),
        source: 'product-page'
    });
}

function injectCompareButtonOnCard(card) {
    if (!card || card.querySelector('.les-compare-card-btn')) return;
    const meta = buildCompareMetaFromCard(card);
    if (!meta) return;

    const toolbar = ensureCardActionToolbar(card);
    if (!toolbar) return;

    const button = createCompareButton(meta, 'les-card-action-btn les-compare-card-btn');
    insertCardAction(toolbar, button, 30);
}

function injectCompareButtonOnProductPage() {
    const meta = buildCompareMetaFromCurrentProduct();
    if (!meta) return;

    let button = document.querySelector('.les-product-compare-btn');
    if (!button) {
        button = createCompareButton(meta, 'les-product-compare-btn');
    } else {
        button.dataset.compareId = meta.id;
        button.__lesCompareMeta = meta;
        updateCompareButtonState(button);
    }

    const buttonsBar = ensureProductActionBar();
    if (buttonsBar && button.parentElement !== buttonsBar) {
        buttonsBar.insertBefore(button, buttonsBar.firstChild);
    }
}

function injectCompareControls() {
    if (isListPage()) {
        document.querySelectorAll(PRODUCT_CARD_SELECTOR).forEach(card => {
            ensureCardActionToolbar(card);
            if (currentSettings.copyButtons) {
                injectNameSearchOnCard(card);
                ensureCardCopyAction(card);
            }
            injectCompareButtonOnCard(card);
        });
    } else {
        injectCompareButtonOnProductPage();
    }
}

function ensureComparePanel() {
    let panel = document.querySelector('.les-compare-panel');
    if (panel) return panel;

    panel = document.createElement('aside');
    panel.className = 'les-compare-panel';
    const header = lesCreateElement(
        'div',
        { className: 'les-compare-panel-header' },
        lesCreateElement('strong', { text: 'Product comparison' }),
        lesCreateElement('span', { className: 'les-compare-count', text: `${comparisonItems.length}/${COMPARE_MAX_ITEMS}` })
    );
    const list = lesCreateElement('div', { className: 'les-compare-list' });
    const openButton = lesCreateElement('button', { type: 'button', className: 'les-compare-open-btn', text: 'Compare products' });
    const clearButton = lesCreateElement('button', { type: 'button', className: 'les-compare-clear-btn', text: 'Clear' });
    panel.appendChild(header);
    panel.appendChild(list);
    panel.appendChild(openButton);
    panel.appendChild(clearButton);

    panel.querySelector('.les-compare-open-btn').addEventListener('click', openProductComparison);
    panel.querySelector('.les-compare-clear-btn').addEventListener('click', async () => {
        comparisonItems = [];
        await persistComparisonState();
        queueComparisonUiRefresh();
    });

    document.body.appendChild(panel);
    return panel;
}

function removeComparePanel() {
    const panel = document.querySelector('.les-compare-panel');
    if (panel) panel.remove();
}

function renderComparePanel() {
    if (!document.body || !comparisonStateLoaded) return;

    if (comparisonItems.length === 0) {
        removeComparePanel();
        return;
    }

    const panel = ensureComparePanel();
    const count = panel.querySelector('.les-compare-count');
    const list = panel.querySelector('.les-compare-list');
    const openBtn = panel.querySelector('.les-compare-open-btn');

    panel.classList.add('is-open');
    if (count) count.textContent = `${comparisonItems.length}/${COMPARE_MAX_ITEMS}`;
    if (openBtn) {
        openBtn.disabled = comparisonItems.length < COMPARE_MIN_ITEMS;
        openBtn.title = comparisonItems.length < COMPARE_MIN_ITEMS ? 'Select at least 2 products' : 'Open comparison';
    }

    if (!list) return;
    lesReplaceChildren(list);
    comparisonItems.forEach(item => {
        const row = document.createElement('div');
        row.className = 'les-compare-list-item';

        const name = document.createElement('span');
        name.textContent = item.name;
        row.appendChild(name);

        const removeBtn = document.createElement('button');
        removeBtn.type = 'button';
        removeBtn.textContent = '×';
        removeBtn.title = 'Remove from comparison';
        removeBtn.addEventListener('click', async () => {
            const index = findComparisonIndex(item.id);
            if (index >= 0) {
                comparisonItems.splice(index, 1);
                await persistComparisonState();
                queueComparisonUiRefresh();
            }
        });
        row.appendChild(removeBtn);
        list.appendChild(row);
    });
}

function getCompanyCode() {
    const host = window.location.hostname.toLowerCase();
    if (host.includes('.fi')) return 'BF2';
    if (host.includes('.no')) return 'BNO';
    if (host.includes('.dk')) return 'BDK';
    return 'BSE'; // default Sweden
}

function normalizeCartProductUrl(value) {
    const url = resolveProductCardAssetUrl(value);
    if (!/^https?:\/\//i.test(url)) return '';
    try {
        const parsed = new URL(url, window.location.href);
        parsed.hash = '';
        return parsed.href;
    } catch (_) {
        return url;
    }
}

function getCartRowProductUrl(row, link) {
    const target = link || row.querySelector('a.item-name, a.js-lineItemClick, a[href*="/verkkokauppa/"], a[href*="/sortiment/"]');
    const href = target ? (target.getAttribute('href') || target.href || '') : '';
    return normalizeCartProductUrl(href);
}

function getCartRowImageUrl(row) {
    const image = row.querySelector('img');
    if (!image) return '';
    return resolveProductCardAssetUrl(image.currentSrc || image.src || image.getAttribute('src') || '');
}

function getCheckoutCartLineItemId(row) {
    const input = row ? row.querySelector('input.js-checkoutCartLineItemId') : null;
    return input ? normalizeWhitespace(input.value || input.getAttribute('value') || '') : '';
}

function getCheckoutCartDepartment(row) {
    const lineId = getCheckoutCartLineItemId(row);
    let departmentInput = null;

    if (lineId) {
        const cartTable = row.closest('table');
        const rows = cartTable ? cartTable.querySelectorAll('tbody tr.js-checkoutCartItem') : [];
        for (const candidate of rows) {
            if (candidate === row) continue;
            if (getCheckoutCartLineItemId(candidate) !== lineId) continue;
            departmentInput = candidate.querySelector('input.js-checkoutCartCommentField, td.comment input[placeholder="Osasto"]');
            if (departmentInput) break;
        }
    }

    if (!departmentInput && row.nextElementSibling) {
        departmentInput = row.nextElementSibling.querySelector('input.js-checkoutCartCommentField, td.comment input[placeholder="Osasto"]');
    }

    return departmentInput ? normalizeWhitespace(departmentInput.value || '') : '';
}

function getCheckoutCartUrl() {
    const cartButton = document.querySelector('.js-cartButton[data-checkouturl]');
    const rawUrl = cartButton ? cartButton.getAttribute('data-checkouturl') : '/kassa/';
    try {
        return new URL(rawUrl || '/kassa/', window.location.href).href;
    } catch (_) {
        return `${window.location.origin}/kassa/`;
    }
}

async function fetchCheckoutCartDocument() {
    const response = await fetch(getCheckoutCartUrl(), {
        credentials: 'include',
        cache: 'no-store',
        redirect: 'follow'
    });
    if (!response.ok) throw new Error(`checkout_cart_http_${response.status}`);
    const html = await response.text();
    return new DOMParser().parseFromString(html, 'text/html');
}

function buildDepartmentQueuesFromCheckoutDoc(doc) {
    const queues = new Map();
    if (!doc) return queues;

    doc.querySelectorAll('table.js-checkoutCartItems tbody tr.product-item, table.cart-items tbody tr.product-item').forEach(row => {
        const artEl = row.querySelector('[data-articlenumber], .js-article-number, .js-article-number-only, .article-number-only, .lekolar-copy-btn[data-value]');
        const articleNumber = artEl ? normalizeWhitespace(artEl.dataset.articlenumber || artEl.dataset.value || artEl.textContent.replace(/[^0-9A-Za-z-]/g, '')) : '';
        if (!articleNumber) return;

        const department = getCheckoutCartDepartment(row);
        if (!queues.has(articleNumber)) queues.set(articleNumber, []);
        queues.get(articleNumber).push(department);
    });

    return queues;
}

async function enrichCartItemsWithCheckoutDepartments(items) {
    if (!Array.isArray(items) || items.length === 0) return items;
    if (items.every(item => normalizeWhitespace(item.department || ''))) return items;

    try {
        const checkoutDoc = await fetchCheckoutCartDocument();
        const departmentQueues = buildDepartmentQueuesFromCheckoutDoc(checkoutDoc);
        if (departmentQueues.size === 0) return items;

        return items.map(item => {
            if (normalizeWhitespace(item.department || '')) return item;
            const queue = departmentQueues.get(item.articleNumber);
            if (!queue || queue.length === 0) return item;
            return { ...item, department: queue.shift() || '' };
        });
    } catch (error) {
        console.warn('LES: Checkout department lookup failed. Exporting CSV without mini-cart departments.', error);
        return items;
    }
}

function getVisibleCartContainer() {
    const checkoutCart = document.querySelector('table.js-checkoutCartItems, table.cart-items');
    if (checkoutCart && checkoutCart.querySelector('tbody tr')) return checkoutCart;

    // Two .mini-cart-container-content exist in the DOM; only one has real dimensions.
    const visible = Array.from(document.querySelectorAll('.mini-cart-container-content'))
        .find(el => el.getBoundingClientRect().width > 0);
    return visible || document.querySelector('.cart-table');
}

function getCartItems() {
    const items = [];
    const scope = getVisibleCartContainer();
    if (!scope) return items;

    // Mini-cart flyout: scope to the visible container only
    const miniCartRows = scope.querySelectorAll('li.js-miniCartItem');
    if (miniCartRows.length > 0) {
        miniCartRows.forEach(li => {
            const artSpan = li.querySelector('.js-article-number[data-articlenumber]');
            const articleNumber = artSpan ? artSpan.dataset.articlenumber : '';
            if (!articleNumber) return;

            const nameLink = li.querySelector('a.item-name, a.js-lineItemClick');
            let name = '';
            if (nameLink) {
                name = (nameLink.getAttribute('title') || nameLink.textContent || '').trim();
                const artSpanText = artSpan ? artSpan.textContent.trim() : '';
                if (artSpanText) name = name.replace(artSpanText, '').trim();
            }

            const qtyInput = li.querySelector('input.js-miniCartQuantityField, input[class*="miniCartQuantity"]');
            const quantity = qtyInput ? Math.max(1, parseInt(qtyInput.value || '1', 10)) : 1;

            items.push({
                articleNumber,
                name,
                quantity,
                url: getCartRowProductUrl(li, nameLink),
                imageUrl: getCartRowImageUrl(li)
            });
        });
        return items;
    }

    // Fallback: full cart page — scoped to visible container
    scope.querySelectorAll('.cart-ul li, tbody tr').forEach(row => {
        const artEl = row.querySelector('[data-articlenumber], .js-article-number, .js-article-number-only, .article-number-only, .lekolar-copy-btn[data-value]');
        const articleNumber = artEl ? (artEl.dataset.articlenumber || artEl.dataset.value || artEl.textContent.replace(/[^0-9A-Za-z-]/g, '')) : '';
        if (!articleNumber) return;

        const nameEl = row.querySelector('.item-name, .product-name, .js-lineItemClick, .js-checkoutlineItemClick');
        const name = nameEl ? (nameEl.getAttribute('title') || nameEl.textContent).trim() : '';

        const qtyInput = row.querySelector('input.js-checkoutCartQuantityField, input[type="number"], input[type="text"]');
        const quantity = qtyInput ? Math.max(1, parseInt(qtyInput.value || '1', 10)) : 1;

        items.push({
            articleNumber,
            name,
            quantity,
            url: getCartRowProductUrl(row, nameEl),
            imageUrl: getCartRowImageUrl(row),
            department: getCheckoutCartDepartment(row)
        });
    });

    return items;
}

function getCartArticleBaseNumber(articleNumber) {
    const normalized = normalizeWhitespace(articleNumber || '');
    const dashIndex = normalized.indexOf('-');
    return dashIndex >= 0 ? normalized.slice(0, dashIndex) : normalized;
}

function createCartExportTimestamp() {
    const date = new Date();
    const datePart = [
        date.getFullYear(),
        String(date.getMonth() + 1).padStart(2, '0'),
        String(date.getDate()).padStart(2, '0')
    ].join('-');
    const timePart = [
        String(date.getHours()).padStart(2, '0'),
        String(date.getMinutes()).padStart(2, '0'),
        String(date.getSeconds()).padStart(2, '0')
    ].join('-');
    return `${datePart}_${timePart}`;
}

function createCartProductCardsFileName() {
    return `Lekolar_Cart_Product_Cards_${createCartExportTimestamp()}.pptx`;
}

function createCartCsvFileName() {
    return `Lekolar_Quotation_Cart_Import_${createCartExportTimestamp()}.csv`;
}

function isLekolarProductPageUrl(url) {
    try {
        const parsed = new URL(url, window.location.href);
        return /\/(verkkokauppa|sortiment|webbutik)\//i.test(parsed.pathname);
    } catch (_) {
        return false;
    }
}

async function findCartItemProductUrl(item) {
    const identifiers = uniqueNonEmpty([
        item.articleNumber,
        getCartArticleBaseNumber(item.articleNumber)
    ]);
    const queries = uniqueNonEmpty([
        item.articleNumber,
        getCartArticleBaseNumber(item.articleNumber),
        item.name
    ]);

    for (const query of queries) {
        const searchBaseUrl = getProductNameSearchBaseUrl();
        const searchUrl = (typeof buildLekolarSearchUrl === 'function')
            ? buildLekolarSearchUrl(searchBaseUrl, query, {})
            : `${searchBaseUrl}${searchBaseUrl.includes('?') ? '&' : '?'}query=${encodeURIComponent(query)}`;

        try {
            const searchDoc = await fetchHtmlDocument(searchUrl);
            const fetchedUrl = normalizeWhitespace(searchDoc.__lesFetchedUrl || '');
            if (isLekolarProductPageUrl(fetchedUrl)) return fetchedUrl;

            const productUrl = findSearchResultProductUrl(searchDoc, identifiers);
            if (productUrl) return productUrl;
        } catch (error) {
            console.warn('LES: Cart PPT product lookup failed for query:', query, error);
        }
    }

    return '';
}

async function resolveCartItemProductData(item) {
    let productUrl = buildProductCardVariantUrl(item.url || '', item.articleNumber || '');
    if (!productUrl) {
        productUrl = buildProductCardVariantUrl(await findCartItemProductUrl(item), item.articleNumber || '');
    }

    if (!productUrl) {
        return createFallbackCartProductData(item, new Error('Product page URL not found'));
    }

    try {
        const productDoc = await fetchHtmlDocument(productUrl);
        return extractProductDataFromDoc(productDoc, productUrl, item);
    } catch (error) {
        console.warn('LES: Cart PPT could not load product page. Using cart row data.', productUrl, error);
        return createFallbackCartProductData({ ...item, url: productUrl }, error);
    }
}

async function buildCartProductCardProducts(items, onProgress) {
    const products = [];
    for (let index = 0; index < items.length; index++) {
        if (typeof onProgress === 'function') onProgress(index, items.length, items[index]);
        products.push(await resolveCartItemProductData(items[index]));
    }
    return products;
}

async function exportCartToPpt(button) {
    const items = await enrichCartItemsWithCheckoutDepartments(getCartItems());
    if (items.length === 0) {
        showCompareToast('Cart is empty or items could not be parsed.');
        return;
    }

    const originalText = button ? button.textContent : '';
    const originalTitle = button ? button.title : '';
    if (button) {
        button.disabled = true;
        button.textContent = `PPT 0/${items.length}`;
        button.title = 'Generating cart PPT...';
    }

    try {
        const products = await buildCartProductCardProducts(items, (index, total) => {
            if (button) button.textContent = `PPT ${index + 1}/${total}`;
        });
        await generateCartProductCardsPptx(products, createCartProductCardsFileName());
        showCompareToast(`Cart PPT downloaded with ${products.length} slides.`);
    } catch (error) {
        console.error('LES: Failed to create cart PPT:', error);
        showCompareToast(getProductCardUserErrorMessage(error));
    } finally {
        if (button) {
            button.disabled = false;
            button.textContent = originalText || 'PPT';
            button.title = originalTitle || 'Download cart as PPT';
        }
    }
}

function formatCartCsvCell(value) {
    const text = String(value == null ? '' : value);
    if (!/[;"\r\n]/.test(text)) return text;
    return `"${text.replace(/"/g, '""')}"`;
}

async function exportCartToCsv() {
    const items = await enrichCartItemsWithCheckoutDepartments(getCartItems());
    if (items.length === 0) {
        showCompareToast('Cart is empty or items could not be parsed.');
        return;
    }
    
    const company = getCompanyCode();
    
    const headers = [
        'Quote', 'Company', 'Existing Product', 'Product number', 'Product configuration',
        'Department', 'Quantity', 'Sales Quotation Status', 'Unit', 'Special Item name'
    ];
    
    const rows = [headers.join(';')];
    
    items.forEach(item => {
        const artNo = item.articleNumber || ''; // e.g. "30972-96U90"
        const dashIdx = artNo.indexOf('-');
        const artNoBase   = dashIdx >= 0 ? artNo.substring(0, dashIdx) : artNo;   // "30972"
        const artNoConfig = dashIdx >= 0 ? artNo.substring(dashIdx + 1) : '';      // "96U90"
        // Existing Product = base + config (no dash) + company code, e.g. "3097296U90BF2"
        const existingProduct = artNoBase + artNoConfig + company;

        const row = [
            '',              // Quote
            company,         // Company
            existingProduct, // Existing Product
            artNoBase,       // Product number
            artNoConfig,     // Product configuration
            item.department || '', // Department
            String(item.quantity), // Quantity
            'Created',       // Sales Quotation Status
            'PCS',           // Unit
            ''               // Special Item name (empty for standard catalog products)
        ];
        rows.push(row.map(formatCartCsvCell).join(';'));
    });
    
    const csvContent = rows.join('\n');
    // Use a data: URI so Firefox extension CSP does not block the download
    const dataUri = 'data:text/csv;charset=utf-8,' + encodeURIComponent(csvContent);
    const a = document.createElement('a');
    a.href = dataUri;
    a.setAttribute('download', createCartCsvFileName());
    a.style.cssText = 'position:fixed;top:-999px;left:-999px;';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => document.body.removeChild(a), 500);
}

function initCartExportUi() {
    const checkoutTable = document.querySelector('table.js-checkoutCartItems, table.cart-items');
    // Pick the VISIBLE .mini-cart-container-content — there are two in the DOM,
    // one is a 0×0 hidden duplicate. We want the one with real dimensions.
    const contentDiv = Array.from(document.querySelectorAll('.mini-cart-container-content'))
        .find(el => el.getBoundingClientRect().width > 0);
    const cartTable = document.querySelector('.cart-table');

    const container = checkoutTable || contentDiv || cartTable;
    if (!container) return;

    // Guard: don't inject twice
    if (container.querySelector('.les-cart-export-actions')) return;

    // Only inject when there are actually items in the cart
    const hasItems = container.querySelector('li.js-miniCartItem, .cart-ul li, .cart-table tbody tr, table.js-checkoutCartItems tbody tr, tbody tr.js-checkoutCartItem, tbody tr.js-cartItem');
    if (!hasItems) return;

    const actionRow = document.createElement('div');
    actionRow.className = 'les-cart-export-actions';
    // Use setAttribute style + !important via a <style> tag approach to override any site CSS
    actionRow.setAttribute('style', [
        'display:flex !important',
        'flex-direction:row !important',
        'gap:8px !important',
        'width:100% !important',
        'box-sizing:border-box !important',
        'margin:8px 0 !important',
        'padding:8px 0 !important',
        'border-top:1px solid rgba(0,0,0,0.15) !important',
        'min-height:44px !important',
        'height:auto !important',
        'overflow:visible !important',
        'visibility:visible !important',
        'opacity:1 !important',
        'clear:both !important',
        'float:none !important',
        'position:relative !important',
        'z-index:2 !important'
    ].join(';'));

    function makeExportBtn(label, clickHandler) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.textContent = label;
        btn.className = 'les-cart-export-btn';
        btn.setAttribute('style', [
            'display:inline-flex !important',
            'align-items:center !important',
            'justify-content:center !important',
            'flex:1 1 0 !important',
            'min-width:60px !important',
            'min-height:36px !important',
            'height:auto !important',
            'width:auto !important',
            'background:#107569 !important',
            'color:#fff !important',
            'border:none !important',
            'border-radius:4px !important',
            'padding:6px 10px !important',
            'font-size:13px !important',
            'font-weight:700 !important',
            'cursor:pointer !important',
            'box-sizing:border-box !important',
            'visibility:visible !important',
            'opacity:1 !important',
            'overflow:visible !important',
            'position:relative !important',
            'z-index:9999 !important'
        ].join(';'));
        btn.addEventListener('click', clickHandler);
        return btn;
    }

    const pptBtn = makeExportBtn('PPT', (e) => {
        e.preventDefault();
        e.stopPropagation();
        exportCartToPpt(pptBtn);
    });

    const csvBtn = makeExportBtn('CSV', (e) => {
        e.preventDefault();
        e.stopPropagation();
        exportCartToCsv();
    });

    actionRow.appendChild(pptBtn);
    actionRow.appendChild(csvBtn);

    if (checkoutTable) {
        const exportRow = document.createElement('tr');
        exportRow.className = 'les-cart-export-row print-view-hide';
        const exportCell = document.createElement('td');
        const firstItemRow = checkoutTable.querySelector('tbody tr');
        exportCell.colSpan = firstItemRow && firstItemRow.children.length ? firstItemRow.children.length : 8;
        exportCell.style.cssText = 'border:none !important;padding:0 !important;';
        exportCell.appendChild(actionRow);
        exportRow.appendChild(exportCell);

        let tfoot = checkoutTable.querySelector('tfoot');
        if (!tfoot) {
            tfoot = document.createElement('tfoot');
            checkoutTable.appendChild(tfoot);
        }
        const totalRow = tfoot.querySelector('.checkout-total-row') ? tfoot.querySelector('.checkout-total-row').closest('tr') : null;
        if (totalRow) tfoot.insertBefore(exportRow, totalRow);
        else tfoot.appendChild(exportRow);
    } else if (contentDiv) {
        const kassalle = contentDiv.querySelector('a.button-submit');
        if (kassalle) {
            const miniCartExportWrap = document.createElement('div');
            miniCartExportWrap.className = 'les-mini-cart-export-wrap';
            miniCartExportWrap.setAttribute('style', [
                'display:block !important',
                'width:100% !important',
                'box-sizing:border-box !important',
                'clear:both !important',
                'float:none !important',
                'position:relative !important',
                'z-index:2 !important',
                'margin:8px 0 12px 0 !important',
                'padding:0 !important',
                'overflow:visible !important'
            ].join(';'));
            actionRow.style.setProperty('margin', '0', 'important');
            actionRow.style.setProperty('clear', 'both', 'important');
            actionRow.style.setProperty('float', 'none', 'important');
            miniCartExportWrap.appendChild(actionRow);
            kassalle.style.setProperty('display', 'block', 'important');
            kassalle.style.setProperty('clear', 'both', 'important');
            kassalle.style.setProperty('float', 'none', 'important');
            kassalle.style.setProperty('position', 'relative', 'important');
            kassalle.style.setProperty('z-index', '1', 'important');
            kassalle.style.setProperty('margin-top', '8px', 'important');
            contentDiv.insertBefore(miniCartExportWrap, kassalle);
        } else {
            contentDiv.appendChild(actionRow);
        }
    } else if (cartTable) {
        const totals = document.querySelector('.cart-totals, .cart-actions');
        if (totals) totals.appendChild(actionRow);
        else cartTable.parentElement.appendChild(actionRow);
    }

}

function closeCompareModal() {
    const modal = document.querySelector('.les-compare-modal-backdrop');
    if (modal) modal.remove();
    document.body.classList.remove('les-compare-modal-open');
}

function ensureCompareModal() {
    closeCompareModal();

    const backdrop = document.createElement('div');
    backdrop.className = 'les-compare-modal-backdrop';
    const modal = lesCreateElement(
        'div',
        { className: 'les-compare-modal', attrs: { role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Product comparison' } },
        lesCreateElement(
            'div',
            { className: 'les-compare-modal-header' },
            lesCreateElement(
                'div',
                {},
                lesCreateElement('h2', { text: 'Product comparison' }),
                lesCreateElement('p', { text: 'Selected products side by side with the details that matter for purchasing.' })
            ),
            lesCreateElement('button', { type: 'button', className: 'les-compare-modal-close', text: '×', attrs: { 'aria-label': 'Close' } })
        ),
        lesCreateElement('div', { className: 'les-compare-modal-body' })
    );
    backdrop.appendChild(modal);

    backdrop.addEventListener('click', (event) => {
        if (event.target === backdrop) closeCompareModal();
    });
    backdrop.querySelector('.les-compare-modal-close').addEventListener('click', closeCompareModal);
    document.body.appendChild(backdrop);
    document.body.classList.add('les-compare-modal-open');
    return backdrop;
}

async function openProductComparison() {
    await ensureComparisonStateLoaded();
    if (comparisonItems.length < COMPARE_MIN_ITEMS) {
        showCompareToast('Select at least 2 products to compare.');
        return;
    }

    const modal = ensureCompareModal();
    renderComparisonLoading(modal);

    const resolvedItems = await Promise.all(comparisonItems.map(async item => {
        try {
            return await resolveComparisonItemDetails(item);
        } catch (error) {
            return sanitizeCompareItem({
                ...item,
                loadError: (error && error.message) ? error.message : 'Could not load details'
            });
        }
    }));

    comparisonItems = resolvedItems.filter(Boolean).slice(0, COMPARE_MAX_ITEMS);
    await persistComparisonState();
    renderComparePanel();
    syncCompareButtons();
    syncListButtons();
    renderComparisonTable(modal, comparisonItems);
}

function renderComparisonLoading(modal) {
    const body = modal.querySelector('.les-compare-modal-body');
    if (!body) return;
    lesReplaceChildren(
        body,
        lesCreateElement(
            'div',
            { className: 'les-compare-loading' },
            lesCreateElement('div', { className: 'lekolar-spinner' }),
            lesCreateElement('span', { text: 'Loading product details...' })
        )
    );
}

function getComparisonPriceView(item) {
    const price = item && item.price;
    if (!price || !price.display) return { display: '-', value: null, simulated: false };

    const numericValue = Number(price.value);
    const config = getPriceAdjustmentConfig();
    if (config.active && Number.isFinite(numericValue) && numericValue > 0) {
        const adjustedValue = numericValue * (1 + config.percent / 100);
        const currencyMatch = String(price.display).match(/€|kr|SEK|NOK|DKK|EUR/i);
        return {
            display: formatComparePrice(adjustedValue, currencyMatch ? currencyMatch[0] : '€'),
            value: adjustedValue,
            simulated: true,
            label: `sim ${formatPriceAdjustmentPercent(config.percent)}`,
            color: config.color
        };
    }

    return {
        display: price.display,
        value: Number.isFinite(numericValue) ? numericValue : null,
        simulated: false
    };
}

function getComparisonPriceExtremes(priceViews) {
    const values = priceViews
        .map((view, index) => ({ index, value: Number(view.value) }))
        .filter(entry => Number.isFinite(entry.value) && entry.value > 0);
    if (values.length < 2) return { cheapest: -1, expensive: -1 };

    const min = Math.min(...values.map(entry => entry.value));
    const max = Math.max(...values.map(entry => entry.value));
    if (Math.abs(max - min) < 0.005) return { cheapest: -1, expensive: -1 };

    return {
        cheapest: values.find(entry => Math.abs(entry.value - min) < 0.005).index,
        expensive: values.find(entry => Math.abs(entry.value - max) < 0.005).index
    };
}

async function resolveComparisonItemDetails(item) {
    const cacheKey = item.url;
    if (comparisonDetailsCache.has(cacheKey)) {
        return comparisonDetailsCache.get(cacheKey);
    }

    const currentUrl = normalizeCompareUrl(window.location.href);
    const doc = normalizeCompareUrl(item.url) === currentUrl ? document : await fetchHtmlDocument(item.url);
    const resolved = buildCompareMetaFromDoc(doc, item.url, item);
    comparisonDetailsCache.set(cacheKey, resolved);
    return resolved;
}

function renderComparisonTable(modal, items) {
    const body = modal.querySelector('.les-compare-modal-body');
    if (!body) return;
    lesReplaceChildren(body);

    const priceViews = items.map(getComparisonPriceView);
    const priceExtremes = getComparisonPriceExtremes(priceViews);

    const grid = document.createElement('div');
    grid.className = 'les-compare-grid';
    grid.style.gridTemplateColumns = `150px repeat(${items.length}, minmax(170px, 1fr))`;

    const corner = document.createElement('div');
    corner.className = 'les-compare-grid-corner';
    corner.textContent = 'Product';
    grid.appendChild(corner);

    items.forEach(item => {
        const header = document.createElement('div');
        header.className = 'les-compare-product-head';

        if (item.imageUrl) {
            const image = document.createElement('img');
            image.src = item.imageUrl;
            image.alt = '';
            image.loading = 'lazy';
            header.appendChild(image);
        }

        const link = document.createElement('a');
        link.href = item.url;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        link.textContent = item.name;
        header.appendChild(link);

        const remove = document.createElement('button');
        remove.type = 'button';
        remove.textContent = 'Remove';
        remove.addEventListener('click', async () => {
            const index = findComparisonIndex(item.id);
            if (index >= 0) {
                comparisonItems.splice(index, 1);
                await persistComparisonState();
                if (comparisonItems.length < COMPARE_MIN_ITEMS) {
                    closeCompareModal();
                } else {
                    renderComparisonTable(modal, comparisonItems);
                }
                queueComparisonUiRefresh();
            }
        });
        header.appendChild(remove);
        grid.appendChild(header);
    });

    const rows = [
        { label: 'Item no.', getValue: item => item.articleNumber },
        { label: 'Dimensions', getValue: formatComparisonDimensions },
        { label: 'Materials', getValue: item => item.materials.join('\n') },
        { label: 'Environmental labels', getValue: item => item.environmentalLabels.join(', ') },
        { label: 'Toxic-free', getValue: item => item.toxicFree },
        { label: 'Series', getValue: item => item.series },
        { label: 'Seat height', getValue: item => item.seatHeight },
        { label: 'Description', getValue: item => item.shortDescription, cellClass: 'les-compare-cell--description' },
        { label: 'Load status', getValue: item => item.loadError }
    ];

    rows.forEach(row => {
        const values = items.map(item => normalizeWhitespace(row.getValue(item) || ''));
        if (values.every(value => !value)) return;

        const label = document.createElement('div');
        label.className = 'les-compare-row-label';
        label.textContent = row.label;
        grid.appendChild(label);

        values.forEach(value => {
            const cell = document.createElement('div');
            cell.className = 'les-compare-cell' + (row.cellClass ? ` ${row.cellClass}` : '');
            cell.textContent = value || '-';
            grid.appendChild(cell);
        });
    });

    const priceLabel = document.createElement('div');
    priceLabel.className = 'les-compare-row-label les-compare-row-label--price';
    priceLabel.textContent = 'Price';
    grid.appendChild(priceLabel);

    priceViews.forEach((priceView, index) => {
        const cell = document.createElement('div');
        cell.className = 'les-compare-cell les-compare-cell--price';
        if (priceView.display === '-') {
            cell.textContent = '-';
            grid.appendChild(cell);
            return;
        }

        const priceValue = document.createElement('span');
        priceValue.className = 'les-compare-price-value';
        priceValue.textContent = priceView.display;
        if (priceView.simulated) {
            priceValue.classList.add('les-price-adjusted');
            priceValue.dataset.lesPriceAdjustmentLabel = priceView.label;
            priceValue.style.setProperty('--les-price-adjustment-color', priceView.color);
            priceValue.title = 'Simulated comparison price';
        }
        cell.appendChild(priceValue);

        if (index === priceExtremes.cheapest || index === priceExtremes.expensive) {
            const light = document.createElement('span');
            const isCheapest = index === priceExtremes.cheapest;
            light.className = `les-compare-price-light ${isCheapest ? 'is-cheapest' : 'is-expensive'}`;
            light.title = isCheapest ? 'Cheapest product' : 'Most expensive product';
            light.setAttribute('aria-label', light.title);
            cell.appendChild(light);
        }
        grid.appendChild(cell);
    });

    body.appendChild(grid);
}

function foldCompareText(value) {
    return normalizeWhitespace(value)
        .toLowerCase()
        .replace(/[åäæ]/g, 'a')
        .replace(/[öø]/g, 'o')
        .replace(/[éè]/g, 'e');
}

function compareLabelMatches(label, tokens) {
    const folded = foldCompareText(label).replace(/:$/, '');
    return tokens.some(token => folded.includes(foldCompareText(token)));
}

function extractComparisonProperties(doc) {
    const properties = [];
    doc.querySelectorAll('.product-properties li, tr').forEach(row => {
        const labelEl = row.querySelector('.heading, th, dt, .product-attributes__name');
        if (!labelEl) return;

        const label = normalizeWhitespace(labelEl.textContent || '').replace(/:$/, '');
        if (!label) return;

        const colorTitles = Array.from(row.querySelectorAll('.color-bubble[title]')).map(el => el.getAttribute('title'));
        const clone = row.cloneNode(true);
        clone.querySelectorAll('.heading, th, dt, .product-attributes__name, .les-spec-checkbox, button').forEach(el => el.remove());
        const value = normalizeWhitespace(clone.textContent || '') || colorTitles.join(', ');
        if (!value) return;

        properties.push({ label, value });
    });
    return properties;
}

function getComparisonPropertyValue(properties, tokens, excludeTokens = []) {
    const row = properties.find(prop => {
        if (!compareLabelMatches(prop.label, tokens)) return false;
        return excludeTokens.length === 0 || !compareLabelMatches(prop.label, excludeTokens);
    });
    return row ? row.value : '';
}

function getComparisonPropertyValues(properties, tokens, includeLabel = false) {
    return uniqueNonEmpty(properties
        .filter(prop => compareLabelMatches(prop.label, tokens))
        .map(prop => includeLabel ? `${prop.label}: ${prop.value}` : prop.value));
}

function formatComparisonDimensions(item) {
    const dims = item.dimensions || {};
    const parts = [
        dims.length ? `Length: ${dims.length}` : '',
        dims.width ? `Width: ${dims.width}` : '',
        dims.height ? `Height: ${dims.height}` : '',
        dims.depth ? `Depth: ${dims.depth}` : '',
        dims.diameter ? `Diameter: ${dims.diameter}` : ''
    ];
    return uniqueNonEmpty(parts).join('\n');
}

function extractProductDescriptionFromDoc(doc) {
    const description = doc.querySelector('.product-info .description, .product-description, .js-productInfo .description');
    if (description) return normalizeWhitespace(description.textContent || '');

    const metaDescription = doc.querySelector('meta[name="description"]');
    if (metaDescription && metaDescription.content) return normalizeWhitespace(metaDescription.content);

    return '';
}

function formatComparePrice(price, currency) {
    return `${price.toLocaleString('fi-FI', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${currency}`;
}

function extractPriceFromElement(root) {
    if (!root) return null;
    const selectors = '.price-buy-info .product-price, .price-buy-info .sales-price, .price-buy-info .price, .product-price, .sales-price, .price, .amount, [class*="price"]';
    const elements = root.querySelectorAll ? root.querySelectorAll(selectors) : [];
    for (const el of elements) {
        if (el.closest && el.closest('.lekolar-sort-container, .les-card-actions, .les-buttons-bar, .filter, .facet, nav, header, footer, aside')) continue;
        if (root === document && el.offsetParent === null && el.closest('.hidden')) continue;
        const text = normalizeWhitespace(el.textContent || '');
        if (!text || !/\d/.test(text)) continue;
        if (!/(€|kr|SEK|NOK|DKK|EUR)/i.test(text)) continue;
        const numberMatch = text.match(/\d[\d\s .]*[,.]?\d{0,2}/);
        if (!numberMatch) continue;
        const price = parseNordicPrice(numberMatch[0]);
        if (price === null || price <= 0) continue;
        const currencyMatch = text.match(/€|kr|SEK|NOK|DKK|EUR/i);
        return { value: price, display: formatComparePrice(price, currencyMatch ? currencyMatch[0] : '€') };
    }
    return null;
}

function extractLiveProductPagePrice() {
    const container = document.querySelector('.price-buy-info, .js-buyInfo, .product-info');
    return extractPriceFromElement(container || document.body);
}

function extractCardDisplayPrice(card) {
    const result = extractPriceFromElement(card);
    if (result) return result;
    const value = extractPriceFromCard(card);
    if (value === null) return null;
    return { value, display: formatComparePrice(value, '€') };
}

function extractProductPriceFromDoc(doc) {
    const scopeSelectors = [
        '.price-buy-info .product-price',
        '.price-buy-info .sales-price',
        '.price-buy-info .price-info',
        '.price-buy-info .price',
        '.js-buyInfo .product-price',
        '.js-buyInfo .price',
        '.product-info .price-buy-info',
        '.price-buy-info'
    ];

    for (const selector of scopeSelectors) {
        const elements = doc.querySelectorAll(selector);
        for (const el of elements) {
            if (el.closest('.lekolar-sort-container, .les-card-actions, .les-buttons-bar, .filter, .facet, nav, header, footer, aside')) continue;
            const text = normalizeWhitespace(el.textContent || '');
            if (!text || !/\d/.test(text)) continue;
            if (!/(€|kr|SEK|NOK|DKK|EUR)/i.test(text)) continue;
            const numberMatch = text.match(/\d[\d\s .]*[,.]?\d{0,2}/);
            if (!numberMatch) continue;
            const price = parseNordicPrice(numberMatch[0]);
            if (price === null || price <= 0) continue;
            const currencyMatch = text.match(/€|kr|SEK|NOK|DKK|EUR/i);
            const currency = currencyMatch ? currencyMatch[0] : '€';
            return { value: price, display: `${price.toLocaleString('fi-FI', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${currency}` };
        }
    }
    return null;
}

function extractProductNameFromDoc(doc) {
    const h1 = doc.querySelector('.product-info h1, .product-page-wrapper h1, .product-page h1, h1');
    if (h1) {
        const clone = h1.cloneNode(true);
        clone.querySelectorAll('.lekolar-copy-btn, .les-product-name-search-btn, .les-product-compare-btn, .les-product-note-btn').forEach(el => el.remove());
        const text = normalizeWhitespace(clone.textContent || '');
        if (text) return text;
    }

    const ogTitle = doc.querySelector('meta[property="og:title"]');
    return ogTitle && ogTitle.content ? normalizeWhitespace(ogTitle.content) : '';
}

function findProductImageLinkForArticle(doc, articleNumber) {
    const normalizedArticle = normalizeWhitespace(articleNumber || '');
    if (!doc || !normalizedArticle) return null;

    const candidates = doc.querySelectorAll('.product-image-wrapper .js-productImage[data-articlenr], .product-image-wrapper [data-articlenr]');
    for (const candidate of candidates) {
        if (normalizeWhitespace(candidate.getAttribute('data-articlenr') || '') === normalizedArticle) {
            return candidate;
        }
    }

    return null;
}

function extractProductImageFromDoc(doc, baseUrl, articleNumber = '') {
    if (doc === document) return getMainProductImageUrl();

    const variantImageLink = findProductImageLinkForArticle(doc, articleNumber);
    const imageLink = variantImageLink || doc.querySelector('.product-image-wrapper .js-currentImage, .product-image-wrapper .current-image, .product-image-wrapper .js-productImage');
    const href = imageLink ? imageLink.getAttribute('href') : '';
    if (href) return new URL(href, baseUrl).href;

    const image = doc.querySelector('.product-image-wrapper img.product-image, .product-image-wrapper img, meta[property="og:image"]');
    const src = image ? (image.getAttribute('src') || image.getAttribute('content')) : '';
    return src ? new URL(src, baseUrl).href : '';
}

function inferSeriesFromProductUrl(url) {
    try {
        const segments = new URL(url, window.location.href).pathname.split('/').filter(Boolean);
        if (segments.length < 3) return '';
        const candidate = (segments[segments.length - 3] || '').replace(/-\d.*$/g, '');
        if (!candidate) return '';
        if (/^\d{4}$/.test(candidate)) return `${candidate.slice(0, 2)}:${candidate.slice(2)}`;
        return candidate
            .replace(/-/g, ' ')
            .replace(/\b\w/g, char => char.toUpperCase());
    } catch (_) {
        return '';
    }
}

function buildCompareMetaFromDoc(doc, url, fallback = {}) {
    const properties = extractComparisonProperties(doc);
    const symbols = extractComparisonSymbolLabels(doc);
    const environmentalLabels = getComparisonPropertyValues(properties, [
        'ympäristömerkinnät', 'ymparistomerkinnat', 'ecolabel', 'miljomarkning', 'miljomerking', 'miljomaerkning'
    ]);
    const allEnvironmentLabels = uniqueNonEmpty([...environmentalLabels, ...symbols.filter(label => {
        const folded = foldCompareText(label);
        return folded.includes('fsc') || folded.includes('mobelfakta') || folded.includes('ymparisto') || folded.includes('eco');
    })]);

    const toxicText = foldCompareText([...symbols, ...properties.map(prop => `${prop.label} ${prop.value}`)].join(' '));
    const isToxicFree = toxicText.includes('haitta-aineeton') || toxicText.includes('toxicfree') || toxicText.includes('giftfri');

    const dimensions = {
        length: getComparisonPropertyValue(properties, ['pituus', 'length', 'langd', 'laengde']),
        width: getComparisonPropertyValue(properties, ['leveys', 'width', 'bredde', 'bredd'], ['istuinleveys', 'seat width', 'sittebredde', 'sittbredd', 'siddebredde', 'saedebredde']),
        height: getComparisonPropertyValue(properties, ['korkeus', 'height', 'hojde', 'hoyde'], ['istuinkorkeus', 'seat height', 'sitthojd', 'sittehoyde', 'siddehojde', 'saedehojde']),
        depth: getComparisonPropertyValue(properties, ['syvyys', 'depth', 'djup', 'dybde'], ['istuinsyvyys', 'seat depth', 'sittedybde', 'sittdjup', 'siddedybde', 'saededybde']),
        diameter: getComparisonPropertyValue(properties, ['halkaisija', 'diameter'])
    };

    return sanitizeCompareItem({
        ...fallback,
        url,
        name: extractProductNameFromDoc(doc) || fallback.name,
        imageUrl: extractProductImageFromDoc(doc, url) || fallback.imageUrl,
        articleNumber: extractProductNumberFromDoc(doc) || fallback.articleNumber,
        shortDescription: extractProductDescriptionFromDoc(doc) || fallback.shortDescription,
        flags: uniqueNonEmpty([...symbols, ...(fallback.flags || [])]),
        dimensions,
        materials: getComparisonPropertyValues(properties, ['materiaali', 'material'], true),
        environmentalLabels: allEnvironmentLabels,
        toxicFree: isToxicFree ? 'Yes' : '',
        series: getComparisonPropertyValue(properties, ['tuoteperhe', 'sarja', 'product series', 'produktserie', 'serie']) || inferSeriesFromProductUrl(url),
        seatHeight: getComparisonPropertyValue(properties, ['istuinkorkeus', 'seat height', 'sitthojd', 'sittehoyde', 'siddehojde', 'saedehojde']),
        price: (fallback && fallback.price) || (doc === document ? extractLiveProductPagePrice() : null) || extractProductPriceFromDoc(doc) || null,
        productProperties: properties,
        source: 'product-page',
        loadError: '',
        fetchedAt: Date.now()
    });
}

function initProductComparisonUi() {
    if (!document.body) return;
    ensureComparisonStateLoaded().then(() => {
        injectCompareControls();
        renderComparePanel();
        syncCompareButtons();
    syncListButtons();
    });
}

// --- Personal Product Notes ---

function normalizeProductNoteUrl(url) {
    if (!url) return '';
    try {
        const parsed = new URL(url, window.location.href);
        const variant = parsed.searchParams.get('variant');
        parsed.hash = '';
        parsed.search = '';
        if (variant) parsed.searchParams.set('variant', variant);
        return parsed.href;
    } catch (_) {
        return String(url || '').trim();
    }
}

function normalizeProductNoteKey(key) {
    return normalizeWhitespace(key).slice(0, 180);
}

function normalizeProductNoteText(text) {
    return String(text || '')
        .replace(/\r\n?/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, PRODUCT_NOTE_MAX_LENGTH);
}

function normalizeProductNoteUser(user) {
    return normalizeWhitespace(user || '').slice(0, 80) || 'Me';
}

function createProductNoteLineId(createdAt = Date.now()) {
    return `${createdAt}-${Math.random().toString(36).slice(2, 8)}`;
}

function buildProductNoteKey(meta) {
    if (!meta) return '';
    if (meta.articleNumber) return normalizeProductNoteKey(`article:${meta.articleNumber}`);
    if (meta.url) return normalizeProductNoteKey(`url:${normalizeProductNoteUrl(meta.url)}`);
    return '';
}

function getCurrentProductNoteMeta() {
    if (isListPage()) return null;

    const articleNumber = normalizeWhitespace(
        getSelectedVariantArticleNumber() ||
        getMainProductNumber() ||
        getProductNumber() ||
        ''
    );
    const url = normalizeProductNoteUrl(window.location.href);
    const productName = getProductName() || '';
    const productId = extractBaseItemNumber(articleNumber) || '';
    const meta = {
        articleNumber,
        productId,
        country: getCurrentCountryCode(),
        productName,
        url
    };
    meta.key = buildProductNoteKey(meta);
    return meta.key ? meta : null;
}

function sanitizeProductNoteEntry(raw, fallbackKey = '') {
    if (!raw) return null;

    const source = typeof raw === 'string' ? { note: raw } : raw;
    const key = normalizeProductNoteKey(source.key || fallbackKey);
    if (!key) return null;

    const now = Date.now();
    const rawLines = Array.isArray(source.notes) ? source.notes : [];
    const notes = rawLines
        .map(line => sanitizeProductNoteLine(line))
        .filter(Boolean);

    const legacyText = normalizeProductNoteText(source.note || source.text || '');
    if (legacyText) {
        notes.push(sanitizeProductNoteLine({
            id: source.id,
            createdAt: source.createdAt || source.updatedAt,
            user: source.user || source.author || source.username,
            text: legacyText
        }));
    }

    const cleanNotes = notes
        .filter(Boolean)
        .sort((a, b) => a.createdAt - b.createdAt);
    if (cleanNotes.length === 0) return null;

    const createdAt = Number(source.createdAt) > 0 ? Number(source.createdAt) : cleanNotes[0].createdAt || now;
    const updatedAt = Number(source.updatedAt) > 0 ? Number(source.updatedAt) : cleanNotes[cleanNotes.length - 1].createdAt || createdAt;

    return {
        key,
        notes: cleanNotes,
        productId: normalizeWhitespace(source.productId || ''),
        articleNumber: normalizeWhitespace(source.articleNumber || ''),
        country: normalizeWhitespace(source.country || ''),
        productName: normalizeWhitespace(source.productName || ''),
        url: normalizeProductNoteUrl(source.url || ''),
        createdAt,
        updatedAt
    };
}

function sanitizeProductNoteLine(raw) {
    if (!raw) return null;
    const source = typeof raw === 'string' ? { text: raw } : raw;
    const text = normalizeProductNoteText(source.text || source.note || source.value || '');
    if (!text) return null;

    const createdAt = Number(source.createdAt || source.timestamp || source.time) > 0
        ? Number(source.createdAt || source.timestamp || source.time)
        : Date.now();

    return {
        id: normalizeWhitespace(source.id || '') || createProductNoteLineId(createdAt),
        createdAt,
        user: normalizeProductNoteUser(source.user || source.author || source.username || productNoteUserName),
        text
    };
}

function sanitizeProductNotesMap(rawNotes) {
    const result = {};
    const source = rawNotes && typeof rawNotes === 'object' ? rawNotes : {};

    Object.entries(source).forEach(([key, raw]) => {
        const entry = sanitizeProductNoteEntry(raw, key);
        if (entry) result[entry.key] = entry;
    });

    return result;
}

function ensureProductNotesLoaded() {
    if (productNotesLoaded) return Promise.resolve(productNotesByKey);
    if (productNotesLoadPromise) return productNotesLoadPromise;

    productNotesLoadPromise = storageLocalGet([PRODUCT_NOTES_STORAGE_KEY, PRODUCT_NOTES_USER_KEY])
        .then(data => {
            productNoteUserName = normalizeProductNoteUser(data && data[PRODUCT_NOTES_USER_KEY]);
            productNotesByKey = sanitizeProductNotesMap(data && data[PRODUCT_NOTES_STORAGE_KEY]);
            productNotesLoaded = true;
            return productNotesByKey;
        })
        .catch(error => {
            console.warn('LES: Could not load personal product notes', error);
            productNotesByKey = {};
            productNotesLoaded = true;
            return productNotesByKey;
        })
        .finally(() => {
            productNotesLoadPromise = null;
        });

    return productNotesLoadPromise;
}

function persistProductNotes() {
    return storageLocalSet({ [PRODUCT_NOTES_STORAGE_KEY]: productNotesByKey }).catch(error => {
        console.warn('LES: Could not save personal product notes', error);
    });
}

function persistProductNoteUserName(userName) {
    productNoteUserName = normalizeProductNoteUser(userName);
    return storageLocalSet({ [PRODUCT_NOTES_USER_KEY]: productNoteUserName }).catch(error => {
        console.warn('LES: Could not save product note user name', error);
    });
}

function createNoteSvg(size = 14) {
    const svgNS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(svgNS, 'svg');
    svg.setAttribute('width', String(size));
    svg.setAttribute('height', String(size));
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '2');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');

    const rect = document.createElementNS(svgNS, 'path');
    rect.setAttribute('d', 'M5 3h12l2 2v16H5z');
    const fold = document.createElementNS(svgNS, 'path');
    fold.setAttribute('d', 'M17 3v4h4');
    const line1 = document.createElementNS(svgNS, 'path');
    line1.setAttribute('d', 'M8 11h8');
    const line2 = document.createElementNS(svgNS, 'path');
    line2.setAttribute('d', 'M8 15h6');

    svg.appendChild(rect);
    svg.appendChild(fold);
    svg.appendChild(line1);
    svg.appendChild(line2);
    return svg;
}

function syncProductNoteButtonState() {
    const button = document.querySelector('.les-product-note-btn');
    if (!button) return;

    const meta = button.__lesProductNoteMeta || getCurrentProductNoteMeta();
    const entry = meta && productNotesByKey[meta.key];
    const noteCount = entry && Array.isArray(entry.notes) ? entry.notes.length : 0;
    const hasNote = noteCount > 0;
    const label = button.querySelector('.les-product-note-btn-label');

    button.__lesProductNoteMeta = meta;
    button.classList.toggle('has-note', hasNote);
    button.setAttribute('aria-pressed', hasNote ? 'true' : 'false');
    button.title = hasNote ? `Open ${noteCount} product notes` : 'Add product note';
    button.setAttribute('aria-label', hasNote ? `Open ${noteCount} product notes` : 'Add product note');
    if (label) label.textContent = hasNote ? `${noteCount} note${noteCount === 1 ? '' : 's'}` : 'Note';
}

function cleanupProductNoteUi() {
    const button = document.querySelector('.les-product-note-btn');
    if (button) button.remove();

    const panel = document.querySelector('.les-product-note-panel');
    if (panel) panel.remove();

    document.querySelectorAll('.les-has-product-note-panel').forEach(host => {
        host.classList.remove('les-has-product-note-panel');
    });

    const buttonsBar = document.querySelector('.les-buttons-bar');
    if (buttonsBar && buttonsBar.children.length === 0) {
        buttonsBar.remove();
    }
}

function formatProductNoteTimestamp(value) {
    const time = Number(value);
    if (!time) return '';
    try {
        const date = new Date(time);
        const pad = number => String(number).padStart(2, '0');
        return [
            date.getFullYear(),
            pad(date.getMonth() + 1),
            pad(date.getDate())
        ].join('-') + ' ' + [pad(date.getHours()), pad(date.getMinutes())].join(':');
    } catch (_) {
        return '';
    }
}

function ensureProductNotePanel(meta) {
    let panel = document.querySelector('.les-product-note-panel');
    if (!panel) {
        panel = document.createElement('section');
        panel.className = 'les-product-note-panel';
        const header = lesCreateElement(
            'div',
            { className: 'les-product-note-header' },
            lesCreateElement(
                'div',
                {},
                lesCreateElement('strong', { text: 'Personal notes' }),
                lesCreateElement('div', { className: 'les-product-note-product' })
            ),
            lesCreateElement('button', { type: 'button', className: 'les-product-note-close', text: 'Close', attrs: { 'aria-label': 'Close note' } })
        );
        const userNameInput = lesCreateElement('input', {
            type: 'text',
            className: 'les-product-note-user-input',
            attrs: { maxlength: '80', autocomplete: 'off', placeholder: 'Your name' }
        });
        const userRow = lesCreateElement(
            'label',
            { className: 'les-product-note-user-row' },
            lesCreateElement('span', { text: 'User' }),
            userNameInput
        );
        const table = lesCreateElement('table', { className: 'les-product-note-table' });
        const thead = document.createElement('thead');
        const headRow = document.createElement('tr');
        headRow.appendChild(lesCreateElement('th', { className: 'les-product-note-select-col', attrs: { title: 'Delete' } }));
        headRow.appendChild(lesCreateElement('th', { text: 'Time/date' }));
        headRow.appendChild(lesCreateElement('th', { text: 'User' }));
        headRow.appendChild(lesCreateElement('th', { text: 'Note' }));
        thead.appendChild(headRow);
        table.appendChild(thead);
        table.appendChild(document.createElement('tbody'));
        const tableWrap = lesCreateElement(
            'div',
            { className: 'les-product-note-table-wrap' },
            table,
            lesCreateElement('div', { className: 'les-product-note-empty', text: 'No notes yet.' })
        );
        const noteTextInput = lesCreateElement('input', {
            type: 'text',
            className: 'les-product-note-input',
            attrs: { maxlength: PRODUCT_NOTE_MAX_LENGTH, placeholder: 'Add one-line note' }
        });
        const compose = lesCreateElement(
            'div',
            { className: 'les-product-note-compose' },
            noteTextInput,
            lesCreateElement('button', { type: 'button', className: 'les-product-note-save', text: 'Add note' })
        );
        const footer = lesCreateElement(
            'div',
            { className: 'les-product-note-footer' },
            lesCreateElement('span', { className: 'les-product-note-status' }),
            lesCreateElement(
                'div',
                { className: 'les-product-note-actions' },
                lesCreateElement('button', { type: 'button', className: 'les-product-note-delete', text: 'Delete selected' })
            )
        );
        panel.appendChild(header);
        panel.appendChild(userRow);
        panel.appendChild(tableWrap);
        panel.appendChild(compose);
        panel.appendChild(footer);

        const buttonsBar = ensureProductActionBar();
        if (buttonsBar && buttonsBar.parentElement) {
            buttonsBar.parentElement.classList.add('les-has-product-note-panel');
            buttonsBar.insertAdjacentElement('afterend', panel);
        } else {
            document.body.appendChild(panel);
        }

        panel.querySelector('.les-product-note-close').addEventListener('click', closeProductNotePanel);
        const noteInput = panel.querySelector('.les-product-note-input');
        const userInput = panel.querySelector('.les-product-note-user-input');
        if (userInput) {
            userInput.addEventListener('change', async () => {
                await persistProductNoteUserName(userInput.value);
                renderProductNotePanel(panel, panel.__lesProductNoteMeta || getCurrentProductNoteMeta());
            });
        }
        if (noteInput) {
            noteInput.addEventListener('keydown', (event) => {
                if (event.key !== 'Enter') return;
                event.preventDefault();
                panel.querySelector('.les-product-note-save').click();
            });
        }
        panel.querySelector('.les-product-note-save').addEventListener('click', async () => {
            const activeMeta = panel.__lesProductNoteMeta || getCurrentProductNoteMeta();
            if (!activeMeta) return;
            const currentNoteInput = panel.querySelector('.les-product-note-input');
            const currentUserInput = panel.querySelector('.les-product-note-user-input');
            await addProductNote(activeMeta, currentNoteInput ? currentNoteInput.value : '', currentUserInput ? currentUserInput.value : '');
            if (currentNoteInput) currentNoteInput.value = '';
            renderProductNotePanel(panel, activeMeta);
            if (currentNoteInput) currentNoteInput.focus();
        });
        panel.querySelector('.les-product-note-delete').addEventListener('click', async () => {
            const activeMeta = panel.__lesProductNoteMeta || getCurrentProductNoteMeta();
            if (!activeMeta) return;
            const ids = Array.from(panel.querySelectorAll('.les-product-note-select:checked'))
                .map(input => input.value)
                .filter(Boolean);
            if (ids.length === 0) {
                showCompareToast('Select your notes to delete.');
                return;
            }
            await deleteSelectedProductNotes(activeMeta, ids);
            renderProductNotePanel(panel, activeMeta);
        });
    }

    if (panel.parentElement && panel.parentElement !== document.body) {
        panel.parentElement.classList.add('les-has-product-note-panel');
    }
    panel.__lesProductNoteMeta = meta;
    renderProductNotePanel(panel, meta);
    return panel;
}

function renderProductNotePanel(panel, meta) {
    if (!panel || !meta) return;
    const entry = productNotesByKey[meta.key] || null;
    const notes = entry && Array.isArray(entry.notes) ? entry.notes : [];
    const product = panel.querySelector('.les-product-note-product');
    const status = panel.querySelector('.les-product-note-status');
    const deleteBtn = panel.querySelector('.les-product-note-delete');
    const table = panel.querySelector('.les-product-note-table');
    const tbody = panel.querySelector('.les-product-note-table tbody');
    const empty = panel.querySelector('.les-product-note-empty');
    const userInput = panel.querySelector('.les-product-note-user-input');
    const previousKey = panel.dataset.noteKey || '';
    const productChanged = Boolean(previousKey && previousKey !== meta.key);
    panel.dataset.noteKey = meta.key;

    if (productChanged) {
        const noteInput = panel.querySelector('.les-product-note-input');
        if (noteInput) noteInput.value = '';
    }
    if (userInput && document.activeElement !== userInput) {
        userInput.value = productNoteUserName;
    }
    if (product) product.textContent = meta.productName || meta.articleNumber || 'Current product';
    if (status) {
        status.textContent = notes.length > 0
            ? `${notes.length} note${notes.length === 1 ? '' : 's'} saved`
            : 'No notes yet';
    }
    if (tbody) {
        tbody.replaceChildren();
        const currentUser = normalizeProductNoteUser(userInput ? userInput.value : productNoteUserName);
        notes.forEach(line => {
            const row = document.createElement('tr');
            const selectCell = document.createElement('td');
            const timeCell = document.createElement('td');
            const userCell = document.createElement('td');
            const noteCell = document.createElement('td');
            const canDelete = normalizeProductNoteUser(line.user) === currentUser;

            selectCell.className = 'les-product-note-select-col';
            const checkbox = document.createElement('input');
            checkbox.type = 'checkbox';
            checkbox.className = 'les-product-note-select';
            checkbox.value = line.id;
            checkbox.disabled = !canDelete;
            checkbox.title = canDelete ? 'Select note to delete' : 'Only notes by the current user can be deleted here';
            selectCell.appendChild(checkbox);

            timeCell.textContent = formatProductNoteTimestamp(line.createdAt);
            userCell.textContent = line.user || '';
            noteCell.textContent = line.text || '';
            if (line.text) noteCell.title = line.text;
            row.appendChild(selectCell);
            row.appendChild(timeCell);
            row.appendChild(userCell);
            row.appendChild(noteCell);
            tbody.appendChild(row);
        });
    }
    if (table) table.hidden = notes.length === 0;
    if (empty) empty.hidden = notes.length > 0;
    if (deleteBtn) {
        deleteBtn.disabled = !notes.some(line => normalizeProductNoteUser(line.user) === normalizeProductNoteUser(userInput ? userInput.value : productNoteUserName));
    }
}

function openProductNotePanel(meta) {
    if (!meta) return;
    const panel = ensureProductNotePanel(meta);
    panel.classList.add('is-open');
    const noteInput = panel.querySelector('.les-product-note-input');
    if (noteInput) noteInput.focus();
}

function closeProductNotePanel() {
    const panel = document.querySelector('.les-product-note-panel');
    if (panel) panel.classList.remove('is-open');
}

async function addProductNote(meta, rawText, rawUser) {
    await ensureProductNotesLoaded();

    const note = normalizeProductNoteText(rawText);
    if (!note) {
        showCompareToast('Write a note first.');
        return;
    }

    const now = Date.now();
    const existing = productNotesByKey[meta.key];
    const user = normalizeProductNoteUser(rawUser || productNoteUserName);
    await persistProductNoteUserName(user);

    productNotesByKey[meta.key] = {
        key: meta.key,
        notes: [
            ...((existing && Array.isArray(existing.notes)) ? existing.notes : []),
            {
                id: createProductNoteLineId(now),
                createdAt: now,
                user,
                text: note
            }
        ],
        productId: meta.productId || '',
        articleNumber: meta.articleNumber || '',
        country: meta.country || '',
        productName: meta.productName || '',
        url: meta.url || '',
        createdAt: existing && existing.createdAt ? existing.createdAt : now,
        updatedAt: now
    };

    await persistProductNotes();
    syncProductNoteButtonState();
    showCompareToast('Product note added.');
}

async function deleteSelectedProductNotes(meta, ids) {
    await ensureProductNotesLoaded();
    const idSet = new Set(Array.isArray(ids) ? ids : []);
    if (!meta || !meta.key || !productNotesByKey[meta.key] || idSet.size === 0) return;

    const entry = productNotesByKey[meta.key];
    const remaining = Array.isArray(entry.notes)
        ? entry.notes.filter(line => !idSet.has(line.id))
        : [];

    if (remaining.length === 0) {
        delete productNotesByKey[meta.key];
    } else {
        productNotesByKey[meta.key] = {
            ...entry,
            notes: remaining,
            updatedAt: Date.now()
        };
    }
    await persistProductNotes();
    syncProductNoteButtonState();
    showCompareToast('Selected notes deleted.');
}

function createProductNoteButton(meta) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'les-product-note-btn';
    button.__lesProductNoteMeta = meta;
    button.setAttribute('aria-pressed', 'false');

    const label = document.createElement('span');
    label.className = 'les-product-note-btn-label';
    button.appendChild(createNoteSvg(14));
    button.appendChild(label);

    button.addEventListener('click', async (event) => {
        event.preventDefault();
        event.stopPropagation();
        await ensureProductNotesLoaded();
        openProductNotePanel(getCurrentProductNoteMeta() || button.__lesProductNoteMeta);
    });

    return button;
}

function injectProductNoteButton() {
    const meta = getCurrentProductNoteMeta();
    if (!meta) {
        cleanupProductNoteUi();
        return;
    }

    let button = document.querySelector('.les-product-note-btn');
    if (!button) {
        button = createProductNoteButton(meta);
    }

    button.__lesProductNoteMeta = meta;
    syncProductNoteButtonState();

    const buttonsBar = ensureProductActionBar();
    if (buttonsBar && button.parentElement !== buttonsBar) {
        const compareBtn = buttonsBar.querySelector('.les-product-compare-btn');
        if (compareBtn && compareBtn.nextSibling) {
            buttonsBar.insertBefore(button, compareBtn.nextSibling);
        } else if (compareBtn) {
            buttonsBar.appendChild(button);
        } else {
            buttonsBar.insertBefore(button, buttonsBar.firstChild);
        }
    }

    const panel = document.querySelector('.les-product-note-panel.is-open');
    if (panel) {
        panel.__lesProductNoteMeta = meta;
        renderProductNotePanel(panel, meta);
    }
}

function initProductNotesUi() {
    if (!document.body || isListPage()) {
        cleanupProductNoteUi();
        return;
    }

    ensureProductNotesLoaded().then(injectProductNoteButton);
}

function refreshProductNotesFromStorage() {
    productNotesLoaded = false;
    productNotesLoadPromise = null;
    ensureProductNotesLoaded().then(() => {
        injectProductNoteButton();
        const panel = document.querySelector('.les-product-note-panel.is-open');
        if (panel) renderProductNotePanel(panel, panel.__lesProductNoteMeta || getCurrentProductNoteMeta());
    });
}

function resolveSearchResultHref(doc, href) {
    const rawHref = normalizeWhitespace(href);
    if (!rawHref) return '';
    try {
        return new URL(rawHref, doc.__lesFetchedUrl || 'https://www.lekolar.se/').href;
    } catch (_) {
        return '';
    }
}

function getSearchResultProductLink(card, doc) {
    if (!card) return '';
    const link = card.querySelector('a[href*="/sortiment/"], a[href*="/webbutik/"], a[href*="/verkkokauppa/"]');
    return link ? resolveSearchResultHref(doc, link.getAttribute('href') || link.href) : '';
}

function collectSearchResultProductLinks(doc) {
    if (!doc) return [];
    const links = [];
    const seen = new Set();
    const addLink = (url) => {
        if (!url || seen.has(url)) return;
        seen.add(url);
        links.push(url);
    };

    const grid = (typeof findProductGridInDoc === 'function') ? findProductGridInDoc(doc) : null;
    if (grid) {
        Array.from(grid.children).forEach(card => addLink(getSearchResultProductLink(card, doc)));
    }

    if (links.length === 0) {
        const cards = doc.querySelectorAll('.product-item, .category-product, .product-list-item, article, .swiper-slide');
        cards.forEach(card => addLink(getSearchResultProductLink(card, doc)));
    }

    if (links.length === 0) {
        const mainContent = doc.querySelector('main') || doc.body || doc;
        mainContent.querySelectorAll('a[href*="/sortiment/"], a[href*="/webbutik/"], a[href*="/verkkokauppa/"]')
            .forEach(link => addLink(resolveSearchResultHref(doc, link.getAttribute('href') || link.href)));
    }

    return links;
}

function findSearchResultProductUrl(doc, identifiers = []) {
    if (!doc) return null;
    const productLinks = collectSearchResultProductLinks(doc);
    if (productLinks.length > 0) {
        return productLinks[0];
    }

    const cleanedIds = identifiers.map(normalizeWhitespace).filter(Boolean);
    if (cleanedIds.length === 0) return null;

    for (const productNumber of cleanedIds) {
        const selectors = [
            `.buy-info[data-articlenumber="${productNumber}"]`,
            `.js-buyInfo[data-articlenumber="${productNumber}"]`,
            `[data-articlenumber="${productNumber}"]`,
            `[data-articlenr="${productNumber}"]`,
            `[data-articleNumber="${productNumber}"]`,
            `[data-productnumber="${productNumber}"]`
        ];

        for (const selector of selectors) {
            const hit = doc.querySelector(selector);
            if (!hit) continue;
            const card = hit.closest('.product-item, .category-product, .product-list-item, article, li, .swiper-slide');
            const url = getSearchResultProductLink(card, doc);
            if (url) return url;
        }
    }

    const cards = doc.querySelectorAll('.product-item, .category-product, .product-list-item, article, li, .swiper-slide');
    for (const card of cards) {
        const text = normalizeWhitespace(card.textContent);
        if (!text) continue;
        if (!cleanedIds.some(id => text.includes(id))) continue;
        const url = getSearchResultProductLink(card, doc);
        if (url) return url;
    }

    return null;
}

function extractSwedishProductData(doc, fallbackUrl) {
    const title = normalizeWhitespace((doc.querySelector('.product-info h1, .product-page-wrapper h1, .product-page h1') || {}).textContent || '');
    const description = normalizeWhitespace((doc.querySelector('.product-info .description .description-wrapper, .product-info .description, .description-wrapper') || {}).textContent || '');
    const articleNumber = normalizeWhitespace((extractProductNumberFromDoc(doc) || '').toString());

    return {
        title,
        description,
        articleNumber,
        url: fallbackUrl || ''
    };
}

async function resolveSwedishReference(productNumber) {
    const normalizedNumber = normalizeWhitespace(productNumber);
    if (!normalizedNumber) throw new Error('Missing product number');
    if (swedishReferenceCache.has(normalizedNumber)) return swedishReferenceCache.get(normalizedNumber);

    const productCode = getMainProductCode();
    const productName = normalizeWhitespace(getProductName());
    const searchBaseUrl = 'https://www.lekolar.se/sok/';
    const queries = [normalizedNumber, productCode, productName]
        .filter(Boolean)
        .filter((query, index, list) => list.indexOf(query) === index);
    const identifiers = [normalizedNumber, productCode].filter(Boolean);

    const lookupErrors = [];
    for (const query of queries) {
        const searchUrl = (typeof buildLekolarSearchUrl === 'function')
            ? buildLekolarSearchUrl(searchBaseUrl, query, {})
            : `${searchBaseUrl}?query=${encodeURIComponent(query)}`;

        let searchDoc = null;
        try {
            searchDoc = await fetchHtmlDocument(searchUrl);
        } catch (error) {
            lookupErrors.push(error);
            continue;
        }

        let productUrl = '';
        const fetchedUrl = normalizeWhitespace(searchDoc.__lesFetchedUrl || '');
        if (fetchedUrl.includes('/sortiment/')) {
            productUrl = fetchedUrl;
        } else {
            productUrl = findSearchResultProductUrl(searchDoc, identifiers);
        }
        if (!productUrl) continue;

        try {
            const productDoc = await fetchHtmlDocument(productUrl);
            const result = extractSwedishProductData(productDoc, productUrl);
            if (!result.description) throw new Error('Swedish description was empty');

            swedishReferenceCache.set(normalizedNumber, result);
            return result;
        } catch (error) {
            lookupErrors.push(error);
        }
    }

    const blockingError = lookupErrors.find(error => !isMissingRemotePageError(error));
    if (blockingError) throw blockingError;
    throw new Error('Could not find Swedish product page');
}

function renderSwedishReferencePanel(panel, data) {
    if (!panel) return;

    const status = panel.querySelector('.les-sv-reference-status');
    const body = panel.querySelector('.les-sv-reference-body');
    const actions = panel.querySelector('.les-sv-reference-actions');

    if (status) {
        status.textContent = data.title
            ? `Matched Swedish page: ${data.title}${data.articleNumber ? ` (${data.articleNumber})` : ''}`
            : 'Matched Swedish product page.';
    }

    if (body) {
        body.hidden = false;
        body.replaceChildren();

        const article = document.createElement('article');
        article.className = 'les-sv-reference-column';

        const heading = document.createElement('h4');
        heading.textContent = 'Swedish original';

        const text = document.createElement('p');
        text.className = 'les-sv-reference-text';
        text.textContent = data.description || '';

        article.appendChild(heading);
        article.appendChild(text);
        body.appendChild(article);
    }

    if (actions) {
        const targetLang = getInlineTranslationLanguage();
        const targetLabel = targetLang === 'fi'
            ? 'Finnish'
            : targetLang === 'no'
                ? 'Norwegian'
                : targetLang === 'da'
                    ? 'Danish'
                    : 'English';

        actions.hidden = false;
        actions.replaceChildren();

        const translateButton = document.createElement('button');
        translateButton.type = 'button';
        translateButton.className = 'les-sv-reference-translate-btn';
        translateButton.dataset.state = 'original';
        translateButton.dataset.targetLang = targetLang;
        translateButton.dataset.originalText = data.description || '';
        translateButton.textContent = `Translate in place (${targetLabel})`;

        lesHasExternalServicesConsentFromStorage().then(hasConsent => {
            lesApplyConsentStateToTranslateButton(translateButton, hasConsent);
        });

        const link = document.createElement('a');
        link.href = data.url || '#';
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        link.textContent = 'Open Swedish page';

        actions.appendChild(translateButton);
        actions.appendChild(link);

        const translateBtn = actions.querySelector('.les-sv-reference-translate-btn');
        const textEl = body.querySelector('.les-sv-reference-text');
        const titleEl = body.querySelector('h4');

        if (translateBtn && textEl && titleEl) {
            translateBtn.addEventListener('click', async () => {
                const state = translateBtn.dataset.state || 'original';
                const originalText = translateBtn.dataset.originalText || data.description;
                const translatedText = translateBtn.dataset.translatedText || '';

                if (state === 'translated' && originalText) {
                    textEl.textContent = originalText;
                    titleEl.textContent = 'Swedish original';
                    translateBtn.dataset.state = 'original';
                    translateBtn.textContent = `Translate in place (${targetLabel})`;
                    return;
                }

                translateBtn.disabled = true;
                const oldLabel = translateBtn.textContent;
                translateBtn.textContent = 'Translating...';

                try {
                    let nextText = translatedText;
                    if (!nextText) {
                        nextText = await requestInlineTranslation(originalText, targetLang);
                        translateBtn.dataset.translatedText = nextText;
                    }

                    textEl.textContent = nextText;
                    titleEl.textContent = `Auto-translated (${targetLabel})`;
                    translateBtn.dataset.state = 'translated';
                    translateBtn.textContent = 'Show Swedish original';
                } catch (error) {
                    translateBtn.textContent = oldLabel;
                    status.textContent = `Translation failed: ${formatExternalServiceError(error)}`;
                } finally {
                    translateBtn.disabled = false;
                }
            });
        }
    }
}

function renderSwedishReferenceError(panel, message) {
    if (!panel) return;
    const status = panel.querySelector('.les-sv-reference-status');
    const body = panel.querySelector('.les-sv-reference-body');
    const actions = panel.querySelector('.les-sv-reference-actions');

    if (status) status.textContent = message || 'Could not load Swedish reference.';
    if (body) {
        body.hidden = true;
        lesReplaceChildren(body);
    }
    if (actions) {
        actions.hidden = true;
        lesReplaceChildren(actions);
    }
}

async function showSwedishReference(productNumber, button) {
    const panel = ensureSwedishReferencePanel();
    renderSwedishReferenceError(panel, 'Loading Swedish reference...');
    updateSwedishReferenceButtonState(button, 'loading');

    try {
        const data = await resolveSwedishReference(productNumber);
        renderSwedishReferencePanel(panel, data);
    } catch (error) {
        renderSwedishReferenceError(panel, formatSwedishReferenceError(error));
    } finally {
        updateSwedishReferenceButtonState(button, 'idle');
    }
}

function applyEnvironmentalLogoVisibility() {
    const shouldHide = Boolean(currentSettings.hideEnvironmentalLogo) && isListPage();
    document.documentElement.classList.toggle('les-hide-environmental-logo', shouldHide);
}

function clampProductLayoutNumber(value, min, max) {
    const number = Number(value);
    if (!Number.isFinite(number)) return min;
    return Math.min(Math.max(number, min), max);
}

function sanitizeProductLayoutPreference(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const ratio = Number(raw.detailsRatio);
    if (!Number.isFinite(ratio)) return null;
    return {
        detailsRatio: clampProductLayoutNumber(ratio, 0.18, 0.55)
    };
}

function ensureProductLayoutPreferenceLoaded() {
    if (productLayoutPreferenceLoaded) return Promise.resolve(productLayoutPreference);
    if (productLayoutPreferenceLoadPromise) return productLayoutPreferenceLoadPromise;

    productLayoutPreferenceLoadPromise = storageLocalGet(PRODUCT_LAYOUT_STORAGE_KEY)
        .then(data => {
            productLayoutPreference = sanitizeProductLayoutPreference(data && data[PRODUCT_LAYOUT_STORAGE_KEY]);
            productLayoutPreferenceLoaded = true;
            return productLayoutPreference;
        })
        .catch(error => {
            console.warn('LES: Could not load product column layout', error);
            productLayoutPreference = null;
            productLayoutPreferenceLoaded = true;
            return productLayoutPreference;
        })
        .finally(() => {
            productLayoutPreferenceLoadPromise = null;
        });

    return productLayoutPreferenceLoadPromise;
}

function persistProductLayoutPreference(detailsWidth, contentWidth) {
    const ratio = contentWidth > 0 ? detailsWidth / contentWidth : 0;
    productLayoutPreference = {
        detailsRatio: clampProductLayoutNumber(ratio, 0.18, 0.55)
    };
    productLayoutPreferenceLoaded = true;
    syncProductLayoutResetButton();

    return storageLocalSet({ [PRODUCT_LAYOUT_STORAGE_KEY]: productLayoutPreference }).catch(error => {
        console.warn('LES: Could not save product column layout', error);
    });
}

function resetProductLayoutPreference() {
    productLayoutPreference = null;
    productLayoutPreferenceLoaded = true;
    syncProductLayoutResetButton();

    return storageLocalRemove(PRODUCT_LAYOUT_STORAGE_KEY).catch(error => {
        console.warn('LES: Could not reset product column layout', error);
    });
}

function getProductLayoutElements() {
    const content = document.querySelector('.product-page-wrapper .product-content, .jsProductPage .product-content');
    if (!content) return null;

    const children = Array.from(content.children || []);
    const images = children.find(el => el.classList && el.classList.contains('product-images'));
    const info = children.find(el =>
        el.classList &&
        el.classList.contains('product-info') &&
        (el.classList.contains('js-productInfo') || el.querySelector('h1'))
    );
    const details = children.find(el => el.classList && el.classList.contains('product-details'));

    if (!images || !info || !details) return null;
    return { content, images, info, details };
}

function measureProductLayout(elements) {
    const contentRect = elements.content.getBoundingClientRect();
    const contentWidth = contentRect.width;
    if (!contentWidth || contentWidth < 920) return null;

    // Reject measurements when children haven't been laid out yet (background-tab
    // hydration can fire callbacks before images/details have real widths). A
    // silent fallback here would bake bad numbers into __lesProductLayoutState
    // and stick — the grid override is !important.
    const rawImagesWidth = elements.images.getBoundingClientRect().width;
    const rawDetailsWidth = elements.details.getBoundingClientRect().width;
    if (rawImagesWidth < 200 || rawDetailsWidth < 200) return null;

    const measuredImagesWidth = Math.round(rawImagesWidth);
    const measuredDetailsWidth = Math.round(rawDetailsWidth);
    const maxImagesWidth = Math.max(260, Math.round(contentWidth * 0.45));
    const imagesWidth = Math.round(clampProductLayoutNumber(measuredImagesWidth, 260, maxImagesWidth));
    const maxDetailsWidth = Math.round(contentWidth - imagesWidth - PRODUCT_LAYOUT_MIN_INFO_WIDTH - PRODUCT_LAYOUT_HANDLE_WIDTH);

    if (maxDetailsWidth < PRODUCT_LAYOUT_MIN_DETAILS_WIDTH + 20) return null;

    return {
        contentWidth,
        imagesWidth,
        defaultDetailsWidth: Math.round(clampProductLayoutNumber(
            measuredDetailsWidth,
            PRODUCT_LAYOUT_MIN_DETAILS_WIDTH,
            maxDetailsWidth
        )),
        maxDetailsWidth
    };
}

function getProductLayoutState(content) {
    return content && content.__lesProductLayoutState ? content.__lesProductLayoutState : null;
}

function getProductLayoutWidthBounds(content) {
    const state = getProductLayoutState(content);
    const contentWidth = content.getBoundingClientRect().width;
    const imagesWidth = state && state.imagesWidth ? state.imagesWidth : Math.round(contentWidth * 0.34);
    const maxDetailsWidth = Math.round(contentWidth - imagesWidth - PRODUCT_LAYOUT_MIN_INFO_WIDTH - PRODUCT_LAYOUT_HANDLE_WIDTH);

    return {
        contentWidth,
        min: PRODUCT_LAYOUT_MIN_DETAILS_WIDTH,
        max: Math.max(PRODUCT_LAYOUT_MIN_DETAILS_WIDTH, maxDetailsWidth)
    };
}

function applyProductLayoutDetailsWidth(content, width) {
    const bounds = getProductLayoutWidthBounds(content);
    const detailsWidth = Math.round(clampProductLayoutNumber(width, bounds.min, bounds.max));
    content.style.setProperty('--les-product-details-width', `${detailsWidth}px`);

    const state = getProductLayoutState(content);
    if (state) state.detailsWidth = detailsWidth;

    return detailsWidth;
}

function createProductLayoutResetIcon() {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');

    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', 'M7 7h6a5 5 0 1 1-4.3 7.6');
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke', 'currentColor');
    path.setAttribute('stroke-width', '2');
    path.setAttribute('stroke-linecap', 'round');
    path.setAttribute('stroke-linejoin', 'round');

    const arrow = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    arrow.setAttribute('d', 'M7 7v5H2');
    arrow.setAttribute('fill', 'none');
    arrow.setAttribute('stroke', 'currentColor');
    arrow.setAttribute('stroke-width', '2');
    arrow.setAttribute('stroke-linecap', 'round');
    arrow.setAttribute('stroke-linejoin', 'round');

    svg.appendChild(path);
    svg.appendChild(arrow);
    return svg;
}

function syncProductLayoutResetButton(root) {
    const scope = root || document;
    const buttons = scope.querySelectorAll ? scope.querySelectorAll('.les-product-divider-reset') : [];
    const hasCustomLayout = !!productLayoutPreference;
    buttons.forEach(button => {
        button.disabled = !hasCustomLayout;
        button.classList.toggle('is-active', hasCustomLayout);
        button.title = hasCustomLayout ? 'Reset product columns to default' : 'Product columns are at default';
    });
}

function createProductLayoutDivider(content) {
    const divider = document.createElement('div');
    divider.className = 'les-product-divider';
    divider.setAttribute('role', 'separator');
    divider.setAttribute('aria-orientation', 'vertical');
    divider.title = 'Drag to resize product details';

    const resetButton = document.createElement('button');
    resetButton.type = 'button';
    resetButton.className = 'les-product-divider-reset';
    resetButton.setAttribute('aria-label', 'Reset product columns to default');
    resetButton.appendChild(createProductLayoutResetIcon());
    divider.appendChild(resetButton);

    divider.addEventListener('pointerdown', event => {
        if (event.button !== undefined && event.button !== 0) return;
        if (event.target && event.target.closest && event.target.closest('.les-product-divider-reset')) return;

        event.preventDefault();
        const state = getProductLayoutState(content);
        if (!state) return;

        divider.classList.add('is-dragging');
        document.documentElement.classList.add('les-product-divider-dragging');

        const move = moveEvent => {
            const bounds = getProductLayoutWidthBounds(content);
            const proposedWidth = bounds.contentWidth - (moveEvent.clientX - content.getBoundingClientRect().left) - (PRODUCT_LAYOUT_HANDLE_WIDTH / 2);
            const detailsWidth = applyProductLayoutDetailsWidth(content, proposedWidth);
            divider.setAttribute('aria-valuenow', String(detailsWidth));
        };

        const finish = finishEvent => {
            document.removeEventListener('pointermove', move);
            document.removeEventListener('pointerup', finish);
            document.removeEventListener('pointercancel', finish);
            divider.classList.remove('is-dragging');
            document.documentElement.classList.remove('les-product-divider-dragging');

            const currentState = getProductLayoutState(content);
            const bounds = getProductLayoutWidthBounds(content);
            if (currentState && bounds.contentWidth > 0) {
                persistProductLayoutPreference(currentState.detailsWidth, bounds.contentWidth);
            }

            if (finishEvent) finishEvent.preventDefault();
        };

        move(event);
        document.addEventListener('pointermove', move);
        document.addEventListener('pointerup', finish);
        document.addEventListener('pointercancel', finish);
    });

    resetButton.addEventListener('click', event => {
        event.preventDefault();
        event.stopPropagation();

        const state = getProductLayoutState(content);
        if (!state) return;

        const detailsWidth = applyProductLayoutDetailsWidth(content, state.defaultDetailsWidth);
        divider.setAttribute('aria-valuenow', String(detailsWidth));
        resetProductLayoutPreference();
    });

    return divider;
}

function cleanupProductLayoutResizer() {
    document.querySelectorAll('.les-product-divider').forEach(el => el.remove());
    document.querySelectorAll('.product-content.les-resizable-product-content').forEach(content => {
        content.classList.remove('les-resizable-product-content');
        content.style.removeProperty('--les-product-images-width');
        content.style.removeProperty('--les-product-details-width');
        content.__lesProductLayoutState = null;
    });
    document.documentElement.classList.remove('les-product-divider-dragging');
}

function setupProductLayoutResizer(elements, preference) {
    if (!elements || !elements.content || !elements.content.isConnected) return;

    const content = elements.content;
    let state = getProductLayoutState(content);

    if (!state) {
        const measurements = measureProductLayout(elements);
        if (!measurements) {
            cleanupProductLayoutResizer();
            return;
        }

        state = {
            imagesWidth: measurements.imagesWidth,
            defaultDetailsWidth: measurements.defaultDetailsWidth,
            detailsWidth: measurements.defaultDetailsWidth
        };
        content.__lesProductLayoutState = state;
        content.style.setProperty('--les-product-images-width', `${measurements.imagesWidth}px`);
    }

    let divider = content.querySelector(':scope > .les-product-divider');
    if (!divider) {
        divider = createProductLayoutDivider(content);
        content.insertBefore(divider, elements.details);
    }

    content.classList.add('les-resizable-product-content');

    const bounds = getProductLayoutWidthBounds(content);
    const preferredWidth = preference && preference.detailsRatio
        ? bounds.contentWidth * preference.detailsRatio
        : state.defaultDetailsWidth;
    const detailsWidth = applyProductLayoutDetailsWidth(content, preferredWidth);

    divider.setAttribute('aria-valuemin', String(PRODUCT_LAYOUT_MIN_DETAILS_WIDTH));
    divider.setAttribute('aria-valuemax', String(bounds.max));
    divider.setAttribute('aria-valuenow', String(detailsWidth));
    syncProductLayoutResetButton(content);
}

let productLayoutVisibilityWaiter = null;

function initProductLayoutResizer() {
    if (!document.body || isListPage() || window.innerWidth < 900 || currentSettings.productLayoutDivider === false) {
        cleanupProductLayoutResizer();
        return;
    }

    // Background-tab rendering is throttled: getBoundingClientRect can return
    // pre-hydration sizes, which would get baked into the grid. Defer until the
    // tab is actually shown — the resizer isn't usable until then anyway.
    if (document.visibilityState === 'hidden') {
        if (productLayoutVisibilityWaiter) return;
        productLayoutVisibilityWaiter = () => {
            if (document.visibilityState !== 'hidden') {
                document.removeEventListener('visibilitychange', productLayoutVisibilityWaiter);
                productLayoutVisibilityWaiter = null;
                initProductLayoutResizer();
            }
        };
        document.addEventListener('visibilitychange', productLayoutVisibilityWaiter);
        return;
    }

    const elements = getProductLayoutElements();
    if (!elements) {
        cleanupProductLayoutResizer();
        return;
    }

    ensureProductLayoutPreferenceLoaded().then(preference => {
        setupProductLayoutResizer(elements, preference);
    });
}

function findAndInject() {
    if (!document.body) return; // Wait for body

    // 1. Inject Product Number Buttons
    // On list/search pages the DOM contains unreliable article numbers
    // (e.g. series IDs instead of real product numbers), so skip XPath
    // injection there — the hover/prefetch system handles those correctly.
    if (!isListPage()) {
        const xpath = "//*[contains(text(), 'Tuotenro') or contains(text(), 'Art.nr') or contains(text(), 'Varenr')]";
        try {
            const result = document.evaluate(xpath, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
            for (let i = 0; i < result.snapshotLength; i++) {
                const element = result.snapshotItem(i);
                const text = element.textContent.trim();
                let number = null;
                let target = null;
                let method = 'append';

                let match = text.match(/(?:Tuotenro|Art\.nr|Varenr)[\.\s:]*\s*([\d-]+)/i);
                if (match) {
                    number = match[1];
                    target = element;
                } else if (text.match(/Tuotenro|Art\.nr|Varenr/i)) {
                    let next = element.nextSibling;
                    while (next && (next.nodeType === 8 || (next.nodeType === 3 && !next.textContent.trim()))) {
                        next = next.nextSibling;
                    }
                    if (next && next.textContent) {
                        const nextText = next.textContent.trim();
                        const numberMatch = nextText.match(/^:?\s*([\d-]+)/);
                        if (numberMatch) {
                            number = numberMatch[1];
                            if (next.nodeType === 1) target = next;
                            else {
                                target = next.parentNode;
                                if (next.nextSibling) {
                                    target = next.nextSibling;
                                    method = 'insertBefore';
                                } else {
                                    target = next.parentNode;
                                }
                            }
                        }
                    }
                }

                if (number && target) {
                    let alreadyExists = false;
                    if (method === 'append') {
                        if (target.querySelector(`.lekolar-copy-btn[data-value="${number}"]`)) alreadyExists = true;
                    } else if (method === 'insertBefore') {
                        if (target.previousElementSibling &&
                            target.previousElementSibling.classList.contains('lekolar-copy-btn') &&
                            target.previousElementSibling.dataset.value === number) {
                            alreadyExists = true;
                        }
                    }

                    if (!alreadyExists) {
                        const btn = createCopyButton(number, 'number');
                        if (method === 'insertBefore') target.parentNode.insertBefore(btn, target);
                        else target.appendChild(btn);
                    }
                }
            }
        } catch (e) {
            console.error("LES Error: Failed during findAndInject", e);
        }
    }

    // 2. Inject Product Name Button + similar-name search control.
    const productNameHeading = getProductNameElement();
    if (productNameHeading) {
        const productName = getProductNameFromElement(productNameHeading);
        if (productName) {
            productNameHeading.dataset.lesProductName = productName;

            ensureProductNameSearchControl(productNameHeading);
        }
    }

    // 2b. Inject product image copy button
    if (!document.querySelector('.les-image-copy-btn')) {
        ensureProductImageActionButton();
    }

    // 2c. Product-page one-click product card export
    ensureProductCardPptButton();

    // 3. Inject Swedish reference button (product pages only)
    if (!isListPage()) {
        const mainProductNumber = getMainProductNumber();
        const baseNumber = extractBaseItemNumber(mainProductNumber);

        if (baseNumber) {
            let btn = document.querySelector('.les-sv-reference-btn');
            if (!btn) {
                btn = document.createElement('button');
                btn.type = 'button';
                btn.className = 'les-sv-reference-btn';
                btn.title = 'Show Swedish source text for this product';
                btn.setAttribute('aria-label', 'Show Swedish source text for this product');

                const svgNS = 'http://www.w3.org/2000/svg';
                const svg = document.createElementNS(svgNS, 'svg');
                svg.setAttribute('width', '14');
                svg.setAttribute('height', '14');
                svg.setAttribute('viewBox', '0 0 24 24');
                svg.setAttribute('fill', 'none');
                svg.setAttribute('stroke', 'currentColor');
                svg.setAttribute('stroke-width', '2');
                svg.setAttribute('stroke-linecap', 'round');
                svg.setAttribute('stroke-linejoin', 'round');
                const globe1 = document.createElementNS(svgNS, 'circle');
                globe1.setAttribute('cx', '12');
                globe1.setAttribute('cy', '12');
                globe1.setAttribute('r', '10');
                const globe2 = document.createElementNS(svgNS, 'path');
                globe2.setAttribute('d', 'M2 12h20');
                const globe3 = document.createElementNS(svgNS, 'path');
                globe3.setAttribute('d', 'M12 2a15.3 15.3 0 010 20');
                const globe4 = document.createElementNS(svgNS, 'path');
                globe4.setAttribute('d', 'M12 2a15.3 15.3 0 000 20');
                svg.appendChild(globe1);
                svg.appendChild(globe2);
                svg.appendChild(globe3);
                svg.appendChild(globe4);

                const label = document.createElement('span');
                label.className = 'les-sv-reference-label';
                label.textContent = 'SV text';

                btn.appendChild(svg);
                btn.appendChild(label);

                btn.addEventListener('click', async (e) => {
                    e.preventDefault();
                    e.stopPropagation();

                    const currentNumber = btn.dataset.productNumber || '';
                    const existingPanel = getSwedishReferencePanel();
                    if (existingPanel && existingPanel.dataset.productNumber === currentNumber) {
                        existingPanel.remove();
                        return;
                    }

                    if (existingPanel) existingPanel.remove();
                    const panel = ensureSwedishReferencePanel();
                    panel.dataset.productNumber = currentNumber;
                    await showSwedishReference(currentNumber, btn);
                });
            }

            btn.dataset.productNumber = baseNumber;
            const buttonsBar = ensureProductActionBar();
            if (buttonsBar && btn.parentElement !== buttonsBar) {
                buttonsBar.insertBefore(btn, buttonsBar.firstChild);
            }
        } else {
            cleanupSwedishReferenceUi();
        }
    } else {
        cleanupSwedishReferenceUi();
    }

    // 4. Inject Compliance Lookup Button (product pages only)
    if (!isListPage()) {
        const mainProductNumber = getMainProductNumber();
        const baseNumber = extractBaseItemNumber(mainProductNumber);
        if (baseNumber) {
            const complianceUrl = `https://lekolarab.sharepoint.com/_layouts/15/search.aspx/?q=${encodeURIComponent(baseNumber)}`;

            let btn = document.querySelector('.lekolar-compliance-btn');
            if (!btn) {
                btn = document.createElement('a');
                btn.className = 'lekolar-compliance-btn';
                btn.target = '_blank';
                btn.rel = 'noopener noreferrer';

                const svgNS = 'http://www.w3.org/2000/svg';
                const svg = document.createElementNS(svgNS, 'svg');
                svg.setAttribute('width', '14');
                svg.setAttribute('height', '14');
                svg.setAttribute('viewBox', '0 0 24 24');
                svg.setAttribute('fill', 'none');
                svg.setAttribute('stroke', 'currentColor');
                svg.setAttribute('stroke-width', '2');
                svg.setAttribute('stroke-linecap', 'round');
                svg.setAttribute('stroke-linejoin', 'round');
                const clipPath = document.createElementNS(svgNS, 'path');
                clipPath.setAttribute('d', 'M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2');
                const clipRect = document.createElementNS(svgNS, 'rect');
                clipRect.setAttribute('x', '9');
                clipRect.setAttribute('y', '3');
                clipRect.setAttribute('width', '6');
                clipRect.setAttribute('height', '4');
                clipRect.setAttribute('rx', '1');
                const chk1 = document.createElementNS(svgNS, 'line');
                chk1.setAttribute('x1', '9');
                chk1.setAttribute('y1', '12');
                chk1.setAttribute('x2', '11');
                chk1.setAttribute('y2', '14');
                const chk2 = document.createElementNS(svgNS, 'line');
                chk2.setAttribute('x1', '11');
                chk2.setAttribute('y1', '14');
                chk2.setAttribute('x2', '15');
                chk2.setAttribute('y2', '10');
                svg.appendChild(clipPath);
                svg.appendChild(clipRect);
                svg.appendChild(chk1);
                svg.appendChild(chk2);

                const label = document.createElement('span');
                label.className = 'lekolar-compliance-label';
                label.textContent = 'Search in SharePoint';

                btn.appendChild(svg);
                btn.appendChild(label);
            }

            // Always refresh URL/title in case of SPA navigation between product pages.
            btn.href = complianceUrl;
            btn.title = `Search ${baseNumber} in SharePoint`;
            btn.setAttribute('aria-label', `Search ${baseNumber} in SharePoint`);

            const buttonsBar = ensureProductActionBar();
            if (buttonsBar && btn.parentElement !== buttonsBar) {
                buttonsBar.appendChild(btn);
            } else if (!buttonsBar) {
                const sidebar = document.querySelector('.product-properties, .product-attributes, .product-details-sidebar, .product-specs');
                if (sidebar && btn.parentElement !== sidebar) {
                    sidebar.appendChild(btn);
                }
                const specsList = document.querySelector('.product-properties ul, .product-attributes ul');
                if (specsList && btn.parentElement !== specsList.parentElement) {
                    specsList.parentElement.appendChild(btn);
                }
            }
        } else {
            const staleBtn = document.querySelector('.lekolar-compliance-btn');
            if (staleBtn) staleBtn.remove();
        }
    } else {
        const staleBtn = document.querySelector('.lekolar-compliance-btn');
        if (staleBtn) staleBtn.remove();
    }

    // 5. Inject Spec Search (checkboxes + links on spec rows)
    injectSpecSearch();
}

// --- Spec Search: make product attributes into searchable links ---

function getSpecSearchBaseUrl() {
    let baseUrl = window.location.origin + '/haku/';
    const pathParts = window.location.pathname.split('/');

    if (pathParts.includes('verkkokauppa') || pathParts.includes('sortiment')) {
        if (pathParts[pathParts.length - 1] === '') pathParts.pop();

        const breadcrumbs = Array.from(document.querySelectorAll('.breadcrumbs a, .breadcrumb a'));
        if (breadcrumbs.length > 2) {
            baseUrl = breadcrumbs[breadcrumbs.length - 2].href.split('?')[0];
        } else if (breadcrumbs.length > 1) {
            baseUrl = breadcrumbs[breadcrumbs.length - 1].href.split('?')[0];
        } else {
            pathParts.pop();
            pathParts.pop();
            pathParts.pop();
            baseUrl = window.location.origin + pathParts.join('/') + '/';
        }
    }
    return baseUrl;
}

const SPEC_KEYS = [
    // Dimensions (numeric, need checkbox for combined search)
    { patterns: ['pituus', 'length', 'lengde', 'längd', 'længde'], filterKey: 'length', type: 'dimension' },
    { patterns: ['istuinkorkeus', 'seat height', 'sittehøyde', 'sitthöjd', 'siddehøjde', 'sædehøjde'], filterKey: 'seatHeight', type: 'dimension' },
    { patterns: ['korkeus', 'height', 'høyde', 'höjd', 'højde'], filterKey: 'height', type: 'dimension' },
    { patterns: ['istuinleveys', 'seat width', 'sittebredde', 'sittbredd', 'siddebredde', 'sædebredde'], filterKey: 'seatWidth', type: 'dimension' },
    { patterns: ['leveys', 'width', 'bredde', 'bredd'], filterKey: 'width', type: 'dimension' },
    { patterns: ['halkaisija', 'diameter', 'diameteren'], filterKey: 'diameter', type: 'dimension' },
    { patterns: ['istuinsyvyys', 'seat depth', 'sittedybde', 'sittdjup', 'siddedybde', 'sædedybde'], filterKey: 'seatDepth', type: 'dimension' },
    { patterns: ['syvyys', 'depth', 'dybde', 'djup'], filterKey: 'depth', type: 'dimension' },

    // Text attributes (link-only, no checkbox needed)
    { patterns: ['väri', 'color', 'colour', 'farge', 'färg', 'farve'], filterKey: 'color', type: 'text' },
    { patterns: ['materiaali', 'material', 'materiale'], filterKey: 'material', type: 'text' },
    { patterns: ['jalkojen materiaali', 'leg material', 'benmaterial'], filterKey: 'legMaterial', type: 'text' },
    { patterns: ['ympäristömerkinnät', 'ympäristömerkintä', 'ecolabel', 'miljømerking', 'miljömärkning', 'miljømærkning'], filterKey: 'ecolabel', type: 'text' },
    { patterns: ['tuoteperhe', 'product series', 'produktserie'], filterKey: 'series', type: 'text' },
    { patterns: ['pöytälevyn muoto', 'table top shape', 'bordsskivans form', 'bordpladens form'], filterKey: 'shape', type: 'text' },
];

function matchSpecKey(labelText) {
    const lower = labelText.toLowerCase().replace(/:$/, '').trim();
    for (const spec of SPEC_KEYS) {
        for (const p of spec.patterns) {
            if (lower === p || lower.startsWith(p + ' ') || lower.startsWith(p + ':')) {
                return spec;
            }
        }
    }
    return null;
}

function appendDimensionSpecLinks(valEl, fullText, spec, labelText, baseUrl) {
    if (typeof buildSpecSearchUrl !== 'function') return false;

    const dimensionPattern = /(\d+(?:[.,]\d+)?)(?:\s*(cm|mm|m))?/gi;
    const matches = Array.from(fullText.matchAll(dimensionPattern));
    if (matches.length === 0) return false;

    valEl.textContent = '';

    let cursor = 0;
    matches.forEach(match => {
        const rawValue = match[1];
        const searchValue = rawValue.replace(',', '.');
        const displayValue = match[0];
        const start = match.index || 0;

        if (start > cursor) {
            valEl.appendChild(document.createTextNode(fullText.substring(cursor, start)));
        }

        const link = document.createElement('a');
        link.className = 'les-spec-link';
        link.href = buildSpecSearchUrl(baseUrl, '', { [spec.filterKey]: searchValue });
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        link.title = `Search: ${labelText} ${displayValue}`;
        link.textContent = displayValue;
        valEl.appendChild(link);

        cursor = start + displayValue.length;
    });

    if (cursor < fullText.length) {
        valEl.appendChild(document.createTextNode(fullText.substring(cursor)));
    }

    return true;
}

function injectSpecSearch() {
    if (document.querySelector('.les-spec-checkbox, .les-spec-link')) return;

    const rows = document.querySelectorAll('tr, .d-flex, .product-properties li');
    const matchedRows = [];

    rows.forEach(row => {
        const th = row.querySelector('th, dt, .product-attributes__name, .heading');
        if (!th) return;

        let valEl;
        if (row.tagName.toLowerCase() === 'li') {
            valEl = row.querySelector('span:not(.heading):not(.color-wrapper)');
            if (!valEl) {
                const colorWrapper = row.querySelector('.color-wrapper');
                if (colorWrapper) {
                    const bubble = colorWrapper.querySelector('.color-bubble');
                    if (bubble && bubble.title) {
                        valEl = colorWrapper;
                    }
                }
            }
        } else {
            valEl = row.querySelector('td, dd, .product-attributes__value');
        }
        if (!valEl) return;

        const spec = matchSpecKey(th.innerText);
        if (!spec) return;

        let searchValue;
        if (spec.type === 'dimension') {
            const valText = valEl.innerText.trim();
            const dimMatch = valText.match(/(\d+(?:[.,]\d+)?)/);
            if (!dimMatch) return;
            searchValue = dimMatch[1].replace(',', '.');
        } else {
            const bubble = valEl.querySelector && valEl.querySelector('.color-bubble');
            if (bubble && bubble.title) {
                searchValue = bubble.title.trim();
            } else {
                searchValue = valEl.innerText.trim();
            }
            if (!searchValue) return;
        }

        matchedRows.push({ row, th, valEl, searchValue, spec });
    });

    if (matchedRows.length === 0) return;

    const baseUrl = getSpecSearchBaseUrl();
    const facetMap = window.PIM_TO_FACET_MAP || {};
    const dimensionRows = matchedRows.filter(r => r.spec.type === 'dimension' && !(r.spec.filterKey in facetMap && facetMap[r.spec.filterKey] === null));

    matchedRows.forEach(({ row, th, valEl, searchValue, spec }) => {
        if (spec.filterKey in facetMap && facetMap[spec.filterKey] === null) return;

        const hasBuildUrl = typeof buildSpecSearchUrl === 'function';
        const fullText = valEl.innerText.trim();

        if (spec.type === 'dimension') {
            if (hasBuildUrl) {
                appendDimensionSpecLinks(valEl, fullText, spec, th.innerText.replace(':', '').trim(), baseUrl);
            }

            const checkbox = document.createElement('input');
            checkbox.type = 'checkbox';
            checkbox.className = 'les-spec-checkbox';
            checkbox.dataset.filterKey = spec.filterKey;
            checkbox.dataset.searchValue = searchValue;
            checkbox.title = 'Include in dimension search';
            valEl.insertBefore(checkbox, valEl.firstChild);
        } else if (hasBuildUrl) {
            const bubble = valEl.querySelector && valEl.querySelector('.color-bubble');
            if (bubble && bubble.title) {
                const link = document.createElement('a');
                link.className = 'les-spec-link';
                link.href = buildSpecSearchUrl(baseUrl, '', { [spec.filterKey]: searchValue });
                link.target = '_blank';
                link.rel = 'noopener noreferrer';
                link.title = `Search: ${searchValue}`;
                link.textContent = searchValue;
                const wrapper = bubble.parentElement;
                wrapper.parentElement.insertBefore(link, wrapper.nextSibling);
            } else {
                valEl.textContent = '';
                const values = ['ecolabel', 'material', 'legMaterial'].includes(spec.filterKey)
                    ? fullText.split(',').map(part => part.trim()).filter(Boolean)
                    : [searchValue];

                values.forEach((value, index) => {
                    if (index > 0) {
                        valEl.appendChild(document.createTextNode(', '));
                    }

                    const link = document.createElement('a');
                    link.className = 'les-spec-link';
                    link.href = buildSpecSearchUrl(baseUrl, '', { [spec.filterKey]: value });
                    link.target = '_blank';
                    link.rel = 'noopener noreferrer';
                    link.title = `Search: ${th.innerText.replace(':', '').trim()} = ${value}`;
                    link.textContent = value;
                    valEl.appendChild(link);
                });
            }
        }
    });

    if (dimensionRows.length > 0) {
        const btn = document.createElement('button');
        btn.className = 'les-spec-search-btn';
        btn.title = 'Search by selected dimensions';
        btn.setAttribute('aria-label', 'Search by selected dimensions');

        const svgNS = 'http://www.w3.org/2000/svg';
        const svg = document.createElementNS(svgNS, 'svg');
        svg.setAttribute('width', '14');
        svg.setAttribute('height', '14');
        svg.setAttribute('viewBox', '0 0 24 24');
        svg.setAttribute('fill', 'none');
        svg.setAttribute('stroke', 'currentColor');
        svg.setAttribute('stroke-width', '2');
        svg.setAttribute('stroke-linecap', 'round');
        svg.setAttribute('stroke-linejoin', 'round');
        const circle = document.createElementNS(svgNS, 'circle');
        circle.setAttribute('cx', '11');
        circle.setAttribute('cy', '11');
        circle.setAttribute('r', '8');
        const line = document.createElementNS(svgNS, 'line');
        line.setAttribute('x1', '21');
        line.setAttribute('y1', '21');
        line.setAttribute('x2', '16.65');
        line.setAttribute('y2', '16.65');
        svg.appendChild(circle);
        svg.appendChild(line);

        const label = document.createElement('span');
        label.className = 'les-spec-search-label';
        label.textContent = 'Search';

        btn.appendChild(svg);
        btn.appendChild(label);

        btn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();

            const checked = document.querySelectorAll('.les-spec-checkbox:checked');
            if (checked.length === 0) {
                btn.classList.add('les-spec-search-shake');
                setTimeout(() => btn.classList.remove('les-spec-search-shake'), 500);
                return;
            }

            const filters = {};
            checked.forEach(cb => {
                filters[cb.dataset.filterKey] = cb.dataset.searchValue;
            });

            if (typeof buildSpecSearchUrl === 'function') {
                const searchUrl = buildSpecSearchUrl(baseUrl, '', filters);
                const opened = window.open(searchUrl, '_blank', 'noopener,noreferrer');
                if (opened) opened.opener = null;
            }
        });

        const buttonsBar = ensureProductActionBar();
        if (!buttonsBar) return;
        buttonsBar.insertBefore(btn, buttonsBar.firstChild);
    }
}

// --- Shared Utility Functions ---
function findProductGridInDoc(doc) {
    const root = doc || document;

    const isInNavOrHeader = (el) => {
        let cur = el;
        while (cur && cur !== root.body) {
            const tag = cur.tagName.toLowerCase();
            if (tag === 'header' || tag === 'footer' || tag === 'nav') return true;
            if (cur.getAttribute('role') === 'navigation') return true;
            cur = cur.parentElement;
        }
        return false;
    };

    const knownSelectors = [
        '.product-tiles-grid',
        '.product-tiles',
        '.product-list',
        '.products-grid',
        '.product-grid',
        '[class*="product-tiles"]',
    ];
    for (const sel of knownSelectors) {
        const el = root.querySelector(sel);
        if (el && !isInNavOrHeader(el)) {
            const productChildCount = Array.from(el.children).filter(child =>
                child.querySelector('a[href*="/verkkokauppa/"], a[href*="/sortiment/"]') && (child.textContent || '').trim().length > 10
            ).length;
            if (productChildCount > 0) return el;
        }
    }

    const mainContent = root.querySelector('main') || root.body;
    if (!mainContent) return null;
    const allDivs = mainContent.querySelectorAll('div, ul, section');
    let bestContainer = null;
    let maxProductChildren = 0;

    allDivs.forEach(div => {
        if (isInNavOrHeader(div)) return;
        // Skip hidden elements if checking main document
        if (!doc && div.offsetWidth === 0) return;
        if (doc && div.className && (div.className.includes('mobileOnly') || div.className.includes('mobile-only'))) return;

        let productChildrenCount = 0;
        Array.from(div.children).forEach(child => {
            if (child.querySelector('a[href*="/verkkokauppa/"], a[href*="/sortiment/"]') && (child.textContent || '').trim().length > 10) {
                productChildrenCount++;
            }
        });

        if (productChildrenCount > maxProductChildren) {
            maxProductChildren = productChildrenCount;
            bestContainer = div;
        }
    });

    if (maxProductChildren > 2) {
        return bestContainer;
    }

    return null;
}

let isPriceSortActive = false;

// @FIREFOX_ONLY_START
let originalGridContent = null;
let allSortedCards = [];

function extractPriceFromCard(card) {
    const priceTokens = [];
    const elements = card.querySelectorAll('.price, .product-price, .sales-price, [class*="price"], .amount');
    
    for (const el of elements) {
        if (el.offsetParent === null && el.closest('.hidden')) continue;
        const text = el.innerText.trim();
        if (text) priceTokens.push(text);
    }
    
    if (priceTokens.length === 0) {
        const lines = card.innerText.split('\n');
        for (const line of lines) {
            if (/(€|kr|sek|nok|dkk)/i.test(line) && /\d/.test(line)) {
                priceTokens.push(line);
            }
        }
    }
    
    for (const text of priceTokens) {
        const price = parseNordicPrice(text);
        if (price !== null) return price;
    }
    return null;
}

function parseNordicPrice(text) {
    // Strip whitespace and currency symbols/codes, keeping only digits, commas, periods.
    let s = text.replace(/\s+/g, '').replace(/€|kr|SEK|NOK|DKK|EUR/gi, '').replace(/[^\d.,]/g, '');
    if (!s) return null;

    // Period-as-thousands + comma-as-decimal: "39.953,00" or "1.234.567,89" (Denmark)
    if (/^\d{1,3}(\.\d{3})+,\d+$/.test(s)) {
        return parseFloat(s.replace(/\./g, '').replace(',', '.'));
    }

    // Comma-as-decimal, no thousands separator: "76,51" or "3154,00" (Finland, Norway after space removal)
    if (/^\d+,\d+$/.test(s)) {
        return parseFloat(s.replace(',', '.'));
    }

    // Plain integer or period-as-decimal: "3154" or "76.51"
    if (/^\d+(?:\.\d+)?$/.test(s)) {
        return parseFloat(s);
    }

    return null;
}

const PRICE_ADJUSTMENT_SELECTOR = [
    '.product-price',
    '.price-info',
    '.sales-price',
    '.campaign-price',
    '.current-price',
    '.regular-price',
    '.list-price',
    '.price',
    '.amount'
].join(', ');

function normalizePriceAdjustmentPercent(value) {
    const number = Number(value);
    if (!Number.isFinite(number)) return 0;
    return Math.min(Math.max(number, -100), 500);
}

function normalizePriceAdjustmentColor(value) {
    const color = String(value || '').trim();
    return /^#[0-9a-f]{6}$/i.test(color) ? color : '#fff3bf';
}

function getPriceAdjustmentConfig() {
    return {
        active: Boolean(currentSettings && currentSettings.priceAdjustmentEnabled),
        percent: normalizePriceAdjustmentPercent(currentSettings && currentSettings.priceAdjustmentPercent),
        color: normalizePriceAdjustmentColor(currentSettings && currentSettings.priceAdjustmentHighlightColor)
    };
}

function formatPriceAdjustmentPercent(percent) {
    const rounded = Math.round(percent * 10) / 10;
    const text = Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
    return `${rounded > 0 ? '+' : ''}${text}%`;
}

function findNordicPriceMatch(text) {
    const pattern = /((?:€|kr|SEK|NOK|DKK|EUR)\s*)(\d[\d\s\u00a0.]*[,.]?\d{0,2})|(\d[\d\s\u00a0.]*[,.]?\d{0,2})(\s*(?:€|kr|SEK|NOK|DKK|EUR))/i;
    const match = pattern.exec(text || '');
    if (!match) return null;

    const rawNumber = match[2] || match[3] || '';
    const price = parseNordicPrice(rawNumber);
    if (price === null) return null;

    return {
        index: match.index,
        full: match[0],
        rawNumber,
        price
    };
}

function getPriceNumberFormat(rawNumber) {
    const cleaned = String(rawNumber || '').replace(/\u00a0/g, ' ');
    const decimalMatch = cleaned.match(/([,.])(\d{1,2})\s*$/);
    const decimalSeparator = decimalMatch ? decimalMatch[1] : ',';
    const decimals = decimalMatch ? decimalMatch[2].length : 0;
    const integerPart = decimalMatch ? cleaned.slice(0, decimalMatch.index) : cleaned;

    let thousandsSeparator = '';
    if (/\d\s+\d{3}/.test(integerPart)) {
        thousandsSeparator = ' ';
    } else if (/\d\.\d{3}/.test(integerPart) && decimalSeparator === ',') {
        thousandsSeparator = '.';
    } else if (/\d,\d{3}/.test(integerPart) && decimalSeparator === '.') {
        thousandsSeparator = ',';
    }

    return { decimals, decimalSeparator, thousandsSeparator };
}

function groupPriceInteger(integerText, separator) {
    if (!separator) return integerText;
    const sign = integerText.startsWith('-') ? '-' : '';
    const digits = sign ? integerText.slice(1) : integerText;
    return sign + digits.replace(/\B(?=(\d{3})+(?!\d))/g, separator);
}

function formatAdjustedPriceNumber(value, rawNumber) {
    const format = getPriceNumberFormat(rawNumber);
    const fixed = Math.max(0, value).toFixed(format.decimals);
    const parts = fixed.split('.');
    const integerPart = groupPriceInteger(parts[0], format.thousandsSeparator);
    if (format.decimals === 0) return integerPart;
    return `${integerPart}${format.decimalSeparator}${parts[1]}`;
}

function buildAdjustedPriceText(originalText, percent) {
    const match = findNordicPriceMatch(originalText);
    if (!match) return null;

    const adjustedPrice = match.price * (1 + percent / 100);
    const adjustedNumber = formatAdjustedPriceNumber(adjustedPrice, match.rawNumber);
    const adjustedFull = match.full.replace(match.rawNumber, adjustedNumber);

    return {
        text: originalText.slice(0, match.index) + adjustedFull + originalText.slice(match.index + match.full.length),
        originalPrice: match.price,
        adjustedPrice
    };
}

function getTextNodes(root) {
    const nodes = [];
    if (!root) return nodes;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
            return node.nodeValue && /\d/.test(node.nodeValue)
                ? NodeFilter.FILTER_ACCEPT
                : NodeFilter.FILTER_REJECT;
        }
    });
    let node = walker.nextNode();
    while (node) {
        nodes.push(node);
        node = walker.nextNode();
    }
    return nodes;
}

function pricesAreClose(a, b) {
    return Math.abs(Number(a) - Number(b)) < 0.005;
}

function writeAdjustedPriceText(element, originalText, adjustedText, percent) {
    const originalMatch = findNordicPriceMatch(originalText);
    const adjustedMatch = findNordicPriceMatch(adjustedText);
    if (!originalMatch || !adjustedMatch) return false;

    for (const node of getTextNodes(element)) {
        const adjustedNode = buildAdjustedPriceText(node.nodeValue, percent);
        if (adjustedNode) {
            node.nodeValue = adjustedNode.text;
            return true;
        }
    }

    const originalNumberKey = originalMatch.rawNumber.replace(/[\s\u00a0]/g, '');
    const numberPattern = /\d[\d\s\u00a0.]*[,.]?\d{0,2}/g;
    for (const node of getTextNodes(element)) {
        const text = node.nodeValue;
        const replaced = text.replace(numberPattern, (token) => {
            const tokenKey = token.replace(/[\s\u00a0]/g, '');
            const tokenPrice = parseNordicPrice(token);
            if (tokenKey === originalNumberKey || (tokenPrice !== null && pricesAreClose(tokenPrice, originalMatch.price))) {
                return adjustedMatch.rawNumber;
            }
            return token;
        });
        if (replaced !== text) {
            node.nodeValue = replaced;
            return true;
        }
    }

    return false;
}

function isPriceAdjustmentCandidate(element) {
    if (!element || element.nodeType !== 1) return false;
    if (element.closest('.lekolar-sort-container, .les-card-actions, .les-buttons-bar, .les-compare-modal')) return false;
    if (element.closest('button, input, select, textarea')) return false;
    if (element.matches('.price-buy-info, .buy-info, .js-buyInfo')) return false;

    const text = (element.dataset.lesOriginalPriceText || element.textContent || '').trim();
    if (!text || !/\d/.test(text) || !/(€|kr|SEK|NOK|DKK|EUR)/i.test(text)) return false;
    return Boolean(findNordicPriceMatch(text));
}

function storePriceAdjustmentOriginalContent(element) {
    if (!priceAdjustmentOriginalNodes.has(element)) {
        priceAdjustmentOriginalNodes.set(
            element,
            Array.from(element.childNodes || []).map(node => node.cloneNode(true))
        );
    }
}

function restorePriceAdjustmentContent(element) {
    const originalNodes = priceAdjustmentOriginalNodes.get(element);
    if (originalNodes && originalNodes.length) {
        lesReplaceChildren(element, ...originalNodes.map(node => node.cloneNode(true)));
        return;
    }
    if (element.dataset.lesOriginalPriceText !== undefined) {
        element.textContent = element.dataset.lesOriginalPriceText;
    }
}

function restorePriceAdjustmentElement(element) {
    if (!element || element.nodeType !== 1) return;
    restorePriceAdjustmentContent(element);
    element.classList.remove('les-price-adjusted');
    element.style.removeProperty('--les-price-adjustment-color');
    delete element.dataset.lesOriginalPriceText;
    delete element.dataset.lesOriginalPriceHtml;
    delete element.dataset.lesPriceAdjustmentLabel;
    delete element.dataset.lesPriceAdjustmentPercent;
    delete element.dataset.lesPriceAdjustmentColor;
    delete element.dataset.lesPriceAdjusted;
    if (element.dataset.lesOriginalPriceTitle !== undefined) {
        if (element.dataset.lesOriginalPriceTitle) {
            element.setAttribute('title', element.dataset.lesOriginalPriceTitle);
        } else {
            element.removeAttribute('title');
        }
    } else {
        element.removeAttribute('title');
    }
    delete element.dataset.lesOriginalPriceTitle;
}

function restorePriceAdjustments(root) {
    const scope = root && root.querySelectorAll ? root : document;
    const elements = [];
    if (scope.matches && scope.matches('.les-price-adjusted')) elements.push(scope);
    if (scope.querySelectorAll) elements.push(...Array.from(scope.querySelectorAll('.les-price-adjusted')));
    elements.forEach(restorePriceAdjustmentElement);
    syncPriceAdjustmentBanner({ active: false });
}

function syncPriceAdjustmentBanner(config) {
    const active = config && config.active;
    document.documentElement.classList.toggle('les-price-adjustment-active', Boolean(active));
    if (active) {
        if (document.documentElement.style.getPropertyValue('--les-price-adjustment-color') !== config.color) {
            document.documentElement.style.setProperty('--les-price-adjustment-color', config.color);
        }
    } else {
        document.documentElement.style.removeProperty('--les-price-adjustment-color');
    }

    document.querySelectorAll('.les-price-simulation-banner').forEach(banner => banner.remove());
}

function applyPriceAdjustmentToElement(element, config) {
    if (!isPriceAdjustmentCandidate(element)) return;

    const percentKey = String(config.percent);
    if (
        element.dataset.lesPriceAdjusted === 'true' &&
        element.dataset.lesPriceAdjustmentPercent === percentKey &&
        element.dataset.lesPriceAdjustmentColor === config.color
    ) {
        return;
    }

    if (element.dataset.lesOriginalPriceText === undefined) {
        element.dataset.lesOriginalPriceText = element.textContent || '';
        element.dataset.lesOriginalPriceTitle = element.getAttribute('title') || '';
        storePriceAdjustmentOriginalContent(element);
    }

    const originalText = element.dataset.lesOriginalPriceText;
    const adjusted = buildAdjustedPriceText(originalText, config.percent);
    if (!adjusted) return;

    restorePriceAdjustmentContent(element);
    if (!writeAdjustedPriceText(element, originalText, adjusted.text, config.percent)) return;

    element.classList.add('les-price-adjusted');
    element.style.setProperty('--les-price-adjustment-color', config.color);
    element.dataset.lesPriceAdjusted = 'true';
    element.dataset.lesPriceAdjustmentLabel = `sim ${formatPriceAdjustmentPercent(config.percent)}`;
    element.dataset.lesPriceAdjustmentPercent = percentKey;
    element.dataset.lesPriceAdjustmentColor = config.color;
    element.title = `Simulated price. Original: ${originalText.trim()}`;
}

function collectPriceAdjustmentCandidates(root) {
    const scope = root && root.querySelectorAll ? root : document;
    const elements = [];
    if (scope.matches && scope.matches(PRICE_ADJUSTMENT_SELECTOR)) elements.push(scope);
    if (scope.querySelectorAll) elements.push(...Array.from(scope.querySelectorAll(PRICE_ADJUSTMENT_SELECTOR)));
    return elements.filter((element, index, list) => {
        return list.indexOf(element) === index &&
            !list.some(other => other !== element && element.contains(other) && isPriceAdjustmentCandidate(other));
    });
}

function applyPriceAdjustments(root) {
    const config = getPriceAdjustmentConfig();
    if (!config.active) {
        restorePriceAdjustments(root);
        return;
    }

    syncPriceAdjustmentBanner(config);
    collectPriceAdjustmentCandidates(root).forEach(element => applyPriceAdjustmentToElement(element, config));
}

async function performPriceSort(order, gridContainer) {
    if (!gridContainer) return;
    
    isPriceSortActive = true;
    
    let overlay = document.getElementById('lekolar-sort-overlay');
    if (!overlay) {
        overlay = document.createElement('div');
        overlay.id = 'lekolar-sort-overlay';
        overlay.className = 'lekolar-loading-overlay';
        
        const spinner = document.createElement('div');
        spinner.className = 'lekolar-spinner';
        
        const text = document.createElement('div');
        text.className = 'lekolar-loading-text';
        text.innerText = 'Fetching all pages for sorting...';
        
        overlay.appendChild(spinner);
        overlay.appendChild(text);
        document.body.appendChild(overlay);
    }
    overlay.style.display = 'flex';
    
    try {
        const urlParams = new URL(window.location.href).searchParams;
        let startPage = 1;
        if (urlParams.get('page')) startPage = parseInt(urlParams.get('page'));
        
        let currentCards = Array.from(gridContainer.children).filter(child => child.matches(PRODUCT_CARD_SELECTOR));
        
        let fetchPage = startPage + 1;
        let keepFetching = true;
        
        if (allSortedCards.length === 0 || allSortedCards.length < currentCards.length) {
            const textEl = overlay.querySelector('.lekolar-loading-text');
            
            while (keepFetching) {
                if (textEl) textEl.innerText = `Fetching page ${fetchPage} for sorting...`;
                
                const currentUrl = new URL(window.location.href);
                currentUrl.searchParams.set('page', fetchPage);
                const nextUrl = currentUrl.toString();
                
                const response = await fetch(nextUrl);
                if (!response.ok) {
                    keepFetching = false;
                    break;
                }
                
                const text = await response.text();
                const parser = new DOMParser();
                const doc = parser.parseFromString(text, 'text/html');
                
                const fetchedContainer = findProductGridInDoc(doc);
                if (!fetchedContainer || fetchedContainer.children.length === 0) {
                    keepFetching = false;
                    break;
                }
                
                const newItems = Array.from(fetchedContainer.children).filter(child => child.matches(PRODUCT_CARD_SELECTOR));
                if (newItems.length === 0) {
                    keepFetching = false;
                    break;
                }
                
                newItems.forEach(item => {
                    const importedNode = sanitizeImportedNode(document.importNode(item, true));
                    currentCards.push(importedNode);
                });
                
                fetchPage++;
            }
        } else {
            currentCards = allSortedCards;
        }
        
        const cardsWithPrices = currentCards.map(card => {
            return {
                element: card,
                price: extractPriceFromCard(card) || 99999999 
            };
        });
        
        cardsWithPrices.sort((a, b) => {
            if (order === 'asc') return a.price - b.price;
            if (order === 'desc') return b.price - a.price;
            return 0;
        });
        
        allSortedCards = cardsWithPrices.map(c => c.element);
        
        if (!originalGridContent) {
            originalGridContent = Array.from(gridContainer.children);
        }
        
        lesReplaceChildren(gridContainer);
        allSortedCards.forEach(card => gridContainer.appendChild(card));
        
        overlay.style.display = 'none';
        
        setTimeout(() => {
            if (currentSettings.copyButtons) {
                findAndInject();
            }
            applyPriceAdjustments();
        }, 150);
        
    } catch (e) {
        console.error("Sorting error:", e);
        const textEl = overlay.querySelector('.lekolar-loading-text');
        if (textEl) textEl.innerText = 'Error sorting: ' + e.message;
        setTimeout(() => { overlay.style.display = 'none'; }, 2000);
    }
}

function initPriceSorting() {
    if (!canUseRestrictedFeatures()) return;

    const isSearch = (window.location.pathname.includes('/haku/') || window.location.pathname.includes('/sok/') || window.location.pathname.includes('/sog/')) && window.location.search.includes('query=');
    const isCategory = window.location.pathname.includes('/verkkokauppa/') || window.location.pathname.includes('/sortiment/');
    if (!isSearch && !isCategory) return;
    
    if (document.querySelector('.lekolar-sort-container')) return;

    const allCards = document.querySelectorAll(PRODUCT_CARD_SELECTOR);
    if (!allCards || allCards.length === 0) return;
    
    let pricesFound = 0;
    for (let i = 0; i < Math.min(allCards.length, 5); i++) {
        if (extractPriceFromCard(allCards[i]) !== null) {
            pricesFound++;
        }
    }
    
    if (pricesFound === 0) return; 
    
    const container = document.createElement('div');
    container.className = 'lekolar-sort-container';
    
    const label = document.createElement('label');
    label.innerText = 'Sort: ';
    label.setAttribute('for', 'lekolar-price-sort');
    
    const select = document.createElement('select');
    select.id = 'lekolar-price-sort';
    select.className = 'lekolar-sort-select';
    [
        { value: '', label: 'Default' },
        { value: 'asc', label: 'Price: Low to High' },
        { value: 'desc', label: 'Price: High to Low' }
    ].forEach(optionConfig => {
        const option = document.createElement('option');
        option.value = optionConfig.value;
        option.textContent = optionConfig.label;
        select.appendChild(option);
    });
    
    container.appendChild(label);
    container.appendChild(select);
    
    const gridContainer = findProductGridInDoc(document);
    if (!gridContainer) return;

    // Place sort container on the SAME ROW as the result-count heading, right-aligned.
    // We wrap the h1 and sort container in a flex row so they sit side-by-side.
    const heading = document.querySelector(
        '.search-result h1, .js-searchResults h1, [class*="search-result"] h1, main h1, #main h1'
    );
    if (heading) {
        // Only create the wrapper once (guard against double-init)
        if (!heading.parentNode.classList.contains('lekolar-heading-row')) {
            const row = document.createElement('div');
            row.className = 'lekolar-heading-row';
            heading.parentNode.insertBefore(row, heading);
            row.appendChild(heading);
            row.appendChild(container);
        }
    } else {
        // Fallback: insert before the product grid
        gridContainer.parentNode.insertBefore(container, gridContainer);
    }
    
    select.addEventListener('change', async (e) => {
        const value = e.target.value;
        if (!value) {
            window.location.reload();
            return;
        }
        await performPriceSort(value, gridContainer);
    });
}
// @FIREFOX_ONLY_END

function initSearchConsolidation() {
    // Run on search pages AND category pages
    // Category pages often contain '/verkkokauppa/' in path and usually don't have 'query=' but we want to be broad
    // Check if we are on a page that likely has a product list
    const isSearch = (window.location.pathname.includes('/haku/') || window.location.pathname.includes('/sok/') || window.location.pathname.includes('/sog/')) && window.location.search.includes('query=');
    const isCategory = window.location.pathname.includes('/verkkokauppa/') || window.location.pathname.includes('/sortiment/');

    if (!isSearch && !isCategory) {
        return;
    }

    // Only run if we haven't already injected the sentinel
    if (document.getElementById('lekolar-infinite-scroll-sentinel')) return;

    // Helper: check if an element is inside header/nav/footer (should be excluded from grid search)
    const isInNavOrHeader = (el) => {
        let cur = el;
        while (cur && cur !== document.body) {
            const tag = cur.tagName.toLowerCase();
            if (tag === 'header' || tag === 'footer' || tag === 'nav') return true;
            if (cur.getAttribute('role') === 'navigation') return true;
            cur = cur.parentElement;
        }
        return false;
    };

    // Heuristic to find the product grid container
    const findProductGrid = (doc) => {
        const root = doc || document;

        // 1. Try specific known Lekolar product grid selectors first
        const knownSelectors = [
            '.product-tiles-grid',
            '.product-tiles',
            '.product-list',
            '.products-grid',
            '.product-grid',
            '[class*="product-tiles"]',
        ];
        for (const sel of knownSelectors) {
            const el = root.querySelector(sel);
            if (el && !isInNavOrHeader(el)) {
                // Verify it has actual product card children
                const productChildCount = Array.from(el.children).filter(child =>
                    child.querySelector('a[href*="/verkkokauppa/"], a[href*="/sortiment/"]') && (child.textContent || '').trim().length > 10
                ).length;
                if (productChildCount > 0) return el;
            }
        }

        // 2. Fallback heuristic — count direct children with product links,
        //    but skip any container that lives inside header/nav/footer
        const mainContent = root.querySelector('main') || root.body;
        if (!mainContent) return null;
        const allDivs = mainContent.querySelectorAll('div, ul, section');
        let bestContainer = null;
        let maxProductChildren = 0;

        allDivs.forEach(div => {
            if (isInNavOrHeader(div)) return; // Skip nav/header elements
            // Skip hidden elements (e.g. mobileOnly containers hidden via CSS)
            if (div.offsetWidth === 0) return;

            let productChildrenCount = 0;
            Array.from(div.children).forEach(child => {
                if (child.querySelector('a[href*="/verkkokauppa/"], a[href*="/sortiment/"]') && child.innerText.length > 10) {
                    productChildrenCount++;
                }
            });

            if (productChildrenCount > maxProductChildren) {
                maxProductChildren = productChildrenCount;
                bestContainer = div;
            }
        });

        if (maxProductChildren > 2) {
            return bestContainer;
        }

        return null;
    };

    // Heuristic: Check if pagination exists
    const hasPagination = () => {
        // Look for common pagination patterns or "Next" links
        // Lekolar specific might use 'pagination' class or similar
        // Also checks for links with 'page=' parameter

        const pagination = document.querySelector('.pagination, .pager, nav[aria-label="Pagination"]');
        if (pagination) return true;

        const pageLinks = document.querySelectorAll('a[href*="page="]');
        if (pageLinks.length > 0) return true;

        // Check for specific text like "Next" or ">"
        // VERY IMPORTANT: Use textContent instead of innerText here to prevent massive layout thrashing
        // which completely freezes the browser on pages with many links!
        const allLinks = document.querySelectorAll('a');
        for (let link of allLinks) {
            const text = (link.textContent || '').trim();
            if (text.includes('Seuraava') || text.includes('Nästa') || text.includes('Neste') || text.includes('Næste') || text === '>' || text === '›') {
                return true;
            }
        }
        return false;
    };

    if (!hasPagination() && !window.location.search.includes('page=')) {
        // If no pagination controls and we are on page 1 (no page param usually means page 1),
        // then we might not need infinite scroll. 
        // But some sites hide pagination if only 1 page. 
        // If there is only 1 page, we don't need infinite scroll anyway.
        return;
    }

    const container = findProductGrid(null);


    if (container) {
        // Create Sentinel for Infinite Scroll
        const sentinel = document.createElement('div');
        sentinel.id = 'lekolar-infinite-scroll-sentinel';
        sentinel.style.height = '50px';
        sentinel.style.width = '100%';
        sentinel.style.textAlign = 'center';
        sentinel.style.padding = '20px';
        sentinel.className = 'lekolar-loading-sentinel';
        sentinel.innerText = ''; // Initially empty

        // Insert sentinel after the grid container
        if (container.nextSibling) {
            container.parentNode.insertBefore(sentinel, container.nextSibling);
        } else {
            container.parentNode.appendChild(sentinel);
        }

        // Initialize state
        let currentPage = 1;
        const urlParams = new URL(window.location.href).searchParams;
        if (urlParams.get('page')) currentPage = parseInt(urlParams.get('page'));

        // Safety check
        if (currentPage < 1 || isNaN(currentPage)) currentPage = 1;

        let isLoading = false;
        let hasMore = true;

        const observer = new IntersectionObserver(async (entries) => {
            if (isPriceSortActive) return;
            if (entries[0].isIntersecting && !isLoading && hasMore) {
                isLoading = true;
                sentinel.innerText = 'Initializing fetch...';

                try {
                    const nextPage = currentPage + 1;
                    const result = await loadNextPage(container, nextPage, sentinel); // Pass sentinel for updates

                    if (result.success) {
                        currentPage = nextPage;
                        isLoading = false;
                        sentinel.innerText = ''; // Clear loading text
                    } else {
                        hasMore = false;
                        isLoading = false;
                        sentinel.innerText = result.message || 'No more products.';
                    }
                } catch (e) {
                    console.error("Critical infinite scroll error:", e);
                    isLoading = false;
                    sentinel.innerText = 'Error: ' + e.message;
                }
            }
        }, { rootMargin: '400px' }); // Start loading earlier

        observer.observe(sentinel);
    }
}

async function loadNextPage(gridContainer, page, debugElement) {
    if (debugElement) debugElement.innerText = `Fetching page ${page}...`;

    const currentUrl = new URL(window.location.href);
    currentUrl.searchParams.set('page', page);
    const nextUrl = currentUrl.toString();

    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 10000); // 10s timeout

        const response = await fetch(nextUrl, { signal: controller.signal });
        clearTimeout(timeoutId);

        if (!response.ok) return { success: false, message: 'Server error: ' + response.status };

        if (debugElement) debugElement.innerText = `Parsing page ${page}...`;
        const text = await response.text();
        const parser = new DOMParser();
        const doc = parser.parseFromString(text, 'text/html');

        const fetchedContainer = findProductGridInDoc(doc);
        const maxChildren = fetchedContainer ? fetchedContainer.children.length : 0;

        if (fetchedContainer && maxChildren > 0) {
            if (debugElement) debugElement.innerText = `Appending ${maxChildren} items...`;
            const newItems = Array.from(fetchedContainer.children);
            if (newItems.length === 0) return { success: false, message: 'No items found in grid.' };

            newItems.forEach(item => {
                const importedNode = sanitizeImportedNode(document.importNode(item, true));
                gridContainer.appendChild(importedNode);
            });
            
            setTimeout(() => {
                if (currentSettings.copyButtons) {
                    findAndInject();
                }
                applyPriceAdjustments(gridContainer);
            }, 150);

            return { success: true };
        } else {
            return { success: false, message: 'Could not find product grid on new page.' };
        }

    } catch (err) {
        console.error('Error loading page:', err);
        return { success: false, message: 'Error: ' + err.message };
    }
}

// --- Prefetching Logic for Configurable Products ---

const fetchedProducts = new Map(); // Cache URL -> Product Number
// Extract product number from a parsed HTML document
function extractProductNumberFromDoc(doc) {
    let productNumber = null;

    // Constrain the search to the main product area if possible
    const productInfoRoot =
        doc.querySelector('.product-info') ||
        doc.querySelector('.product-page .product-info') ||
        doc.querySelector('.product-page-wrapper .product-info') ||
        doc.querySelector('.product-page') ||
        doc.querySelector('.product-page-wrapper') ||
        doc;

    // 1. Check "Tuotenro" text first (shows the true selected/default variant number instead of a generic series ID)
    try {
        const xpath = ".//*[contains(text(), 'Tuotenro') or contains(text(), 'Art.nr') or contains(text(), 'Varenr')]";
        // doc.evaluate context node must be an element, so we can't use HTMLDocument directly with a relative xpath if we aren't careful
        // but passing the root element works better. If productInfoRoot is 'doc', the relative xpath './/' might fail on Document node.
        const contextNode = productInfoRoot === doc ? doc.documentElement || doc : productInfoRoot;
        const result = doc.evaluate(xpath, contextNode, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
        for (let i = 0; i < result.snapshotLength; i++) {
            const element = result.snapshotItem(i);
            const text = (element.textContent || '').trim();
            const match = text.match(/(?:Tuotenro|Art\.nr|Varenr)[\.\s:]*\s*([0-9A-Za-z-]+)/i);
            if (match) {
                productNumber = match[1];
                break;
            }

            let next = element.nextSibling;
            while (next && (next.nodeType === 8 || (next.nodeType === 3 && !(next.textContent || '').trim()))) {
                next = next.nextSibling;
            }
            if (next && next.textContent) {
                const numberMatch = next.textContent.trim().match(/^:?\s*([0-9A-Za-z-]+)/);
                if (numberMatch) {
                    productNumber = numberMatch[1];
                    break;
                }
            }
        }
    } catch (e) {
        console.error("LES Error: Failed to extract product number from doc text", e);
    }

    // 2. Fallback to data attributes on main elements
    if (!productNumber) {
        const buyInfo = doc.querySelector('.buy-info, .js-buyInfo');
        if (buyInfo && buyInfo.dataset.articlenumber) {
            productNumber = buyInfo.dataset.articlenumber;
        }
    }

    // 3. Fallback to meta tags or other data attributes
    if (!productNumber) {
        const productDiv = doc.querySelector('[data-productnumber]');
        if (productDiv) productNumber = productDiv.dataset.productnumber;
    }

    return productNumber;
}

// Direct fetch for hover — bypasses the slow queue for responsiveness
async function fetchProductNumberDirect(url) {
    if (fetchedProducts.has(url)) return fetchedProducts.get(url);

    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 8000);

        const response = await fetch(url, { signal: controller.signal });
        clearTimeout(timeoutId);

        const text = await response.text();
        const parser = new DOMParser();
        const doc = parser.parseFromString(text, 'text/html');

        const productNumber = extractProductNumberFromDoc(doc);

        if (productNumber) {
            if (fetchedProducts.size >= 500) {
                const firstKey = fetchedProducts.keys().next().value;
                fetchedProducts.delete(firstKey);
            }
            fetchedProducts.set(url, productNumber);
        }
        return productNumber;
    } catch (error) {
        console.error("Error fetching product page directly:", error);
        return null;
    }
}


// --- Hover-to-Reveal System ---

const hoverInitialized = new WeakSet();
let hoverSystemInitialized = false;

const PRODUCT_CARD_SELECTOR = '.product-item, .category-product, .product-list-item, article';

function isListPage() {
    // Product detail pages also have '/verkkokauppa/' in their URL,
    // so check for product page wrapper to exclude them
    if (document.querySelector('.product-page-wrapper, .jsProductPage')) return false;

    const path = window.location.pathname;
    const isSearch = path.includes('/haku/') || path.includes('/sok/') || path.includes('/sog/');
    const isCategory = path.includes('/verkkokauppa/') || path.includes('/sortiment/');
    return isSearch || isCategory;
}

function findProductCard(element) {
    let current = element;
    while (current && current !== document.body) {
        if (current.matches && current.matches(PRODUCT_CARD_SELECTOR)) {
            return current;
        }
        current = current.parentElement;
    }
    return null;
}

function getProductCardUrl(card) {
    const link = card.querySelector('a[href*="/verkkokauppa/"], a[href*="/sortiment/"]');
    if (!link) return null;
    try {
        if (new URL(link.href).origin !== window.location.origin) return null;
    } catch (e) { return null; }
    return link.href;
}

function getProductCardName(card) {
    if (!card) return null;

    const candidates = [
        '.product-title',
        '.inner-title',
        'h3',
        '.product-name',
        '.eS-productname',
        'a[href*="/verkkokauppa/"]',
        'a[href*="/sortiment/"]'
    ];

    for (const selector of candidates) {
        const element = card.querySelector(selector);
        const text = element ? (element.textContent || '').trim() : '';
        if (text) return text;
    }

    return null;
}

function getProductCardNameElement(card) {
    if (!card) return null;

    const selectors = [
        '.product-title a[href*="/verkkokauppa/"]',
        '.product-title a[href*="/sortiment/"]',
        '.inner-title a[href*="/verkkokauppa/"]',
        '.inner-title a[href*="/sortiment/"]',
        'h3 a[href*="/verkkokauppa/"]',
        'h3 a[href*="/sortiment/"]',
        '.product-name a[href*="/verkkokauppa/"]',
        '.product-name a[href*="/sortiment/"]',
        '.eS-productname a[href*="/verkkokauppa/"]',
        '.eS-productname a[href*="/sortiment/"]',
        '.product-title',
        '.inner-title',
        'h3',
        '.product-name',
        '.eS-productname',
        'a[href*="/verkkokauppa/"]',
        'a[href*="/sortiment/"]'
    ];

    for (const selector of selectors) {
        const element = card.querySelector(selector);
        const text = element ? normalizeWhitespace(element.textContent || '') : '';
        if (text) return element;
    }

    return null;
}

function injectNameSearchOnCard(card) {
    if (!card || card.querySelector('.les-card-name-search-btn')) return;

    const nameElement = getProductCardNameElement(card);
    if (!nameElement) return;

    const name = getProductNameFromElement(nameElement);
    if (!name) return;

    nameElement.dataset.lesProductName = name;

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'les-card-action-btn les-card-name-search-btn';
    button.dataset.type = 'similar-card-name';
    button.title = 'Find similar products from name';
    button.setAttribute('aria-label', 'Find similar products from name');
    button.setAttribute('aria-pressed', 'false');

    button.appendChild(createSearchSvg(16));
    button.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        activateProductNameSearch(nameElement, button);
    });

    const toolbar = ensureCardActionToolbar(card);
    if (toolbar) insertCardAction(toolbar, button, 20);
}

function injectCopyButtonOnCard(card, number) {
    ensureCardCopyAction(card);
    const btn = card.querySelector('.les-card-copy-btn');
    if (number) setCardProductNumber(card, number, btn);
}

async function handleProductCardHover(card) {
    injectNameSearchOnCard(card);
    ensureCardCopyAction(card);
    const copyButton = card.querySelector('.les-card-copy-btn');
    resolveCardProductNumber(card, copyButton).catch(error => {
        console.error('LES: Failed to resolve hovered card product number', error);
    });
    injectCompareButtonOnCard(card);
}

function initHoverCopySystem() {
    if (!isListPage()) return;

    if (!hoverSystemInitialized) {
        hoverSystemInitialized = true;

        // Event delegation using 'mouseover' (it bubbles, unlike mouseenter)
        document.body.addEventListener('mouseover', (e) => {
            if (!currentSettings.copyButtons) return;

            const card = findProductCard(e.target);
            if (!card || hoverInitialized.has(card)) return;

            hoverInitialized.add(card);
            handleProductCardHover(card);
        });
    }

}


// --- Compact Layout: Remove tabs and tighten spacing ---
function compactSearchPage() {
    const isSearch = window.location.pathname.includes('/haku/') || window.location.pathname.includes('/sok/') || window.location.pathname.includes('/sog/');
    const isCategory = window.location.pathname.includes('/verkkokauppa/') || window.location.pathname.includes('/sortiment/');
    if (!isSearch && !isCategory) return;

    function doCleanup() {
        // Remove the search navigation tabs (Tuotteet, Vinkkejä, Sisältö) from DOM entirely.
        document.querySelectorAll('nav.main-search-nav, nav.js-searchNavigation, .js-searchNavigation')
            .forEach(el => el.remove());

        // Remove the filter panel wrapper (tabs container) from DOM entirely.
        document.querySelectorAll('.search-filter-panel, [class*="search-filter-panel"]')
            .forEach(el => el.remove());

        // Collapse any inline margin-top the page added to compensate for the removed tabs.
        document.querySelectorAll('.search-result, .js-searchResults, [class*="search-result"], [data-content-type="products"]')
            .forEach(el => {
                el.style.setProperty('margin-top', '0', 'important');
                el.style.setProperty('padding-top', '0', 'important');
            });

        // Find the result-count h1 and aggressively collapse all ghost space around it.
        const h1 = document.querySelector(
            '.search-result h1, .js-searchResults h1, [class*="search-result"] h1, main h1, #main h1'
        );
        if (!h1) return;

        // 1. Collapse ALL spacing on h1's direct parent — including any site-set min-height/height
        const h1Parent = h1.parentNode;
        h1Parent.style.setProperty('padding-top',    '0',    'important');
        h1Parent.style.setProperty('padding-bottom', '0',    'important');
        h1Parent.style.setProperty('margin-top',     '0',    'important');
        h1Parent.style.setProperty('margin-bottom',  '0',    'important');
        h1Parent.style.setProperty('min-height',     '0',    'important');
        h1Parent.style.setProperty('height',         'auto', 'important');

        // Also zero the grandparent in case the heading is nested one level deeper
        const h1GrandParent = h1Parent.parentNode;
        if (h1GrandParent && h1GrandParent !== document.body) {
            h1GrandParent.style.setProperty('padding-bottom', '0',    'important');
            h1GrandParent.style.setProperty('margin-bottom',  '0',    'important');
            h1GrandParent.style.setProperty('min-height',     '0',    'important');
            h1GrandParent.style.setProperty('height',         'auto', 'important');
        }

        // Known culprit from site diagnostics: .category-content has min-height:240px
        // which reserves empty space even when content is smaller.
        document.querySelectorAll('.category-content, [class*="category-content"]').forEach(el => {
            el.style.setProperty('min-height',     '0',    'important');
            el.style.setProperty('height',         'auto', 'important');
            el.style.setProperty('padding-bottom', '0',    'important');
        });

        // Known culprit from site diagnostics: .product-list-wrapper has ~58px margin-top
        // set as an inline style, so the CSS sibling selector can't reach it.
        document.querySelectorAll('.product-list-wrapper, [class*="product-list-wrapper"]').forEach(el => {
            el.style.setProperty('margin-top',  '0', 'important');
            el.style.setProperty('padding-top', '0', 'important');
        });

        // 2. Remove empty children of h1's parent (ghost wrappers left by removed tabs)
        Array.from(h1Parent.children).forEach(child => {
            if (child === h1) return;
            if (child.classList && child.classList.contains('lekolar-heading-row')) return;
            const hasText = child.textContent.trim().length > 0;
            const hasInteractive = child.querySelector('input, select, button');
            if (!hasText && !hasInteractive) child.remove();
        });

        // 3. Also scan SIBLINGS of h1's parent — the gap may live at a higher DOM level,
        //    between the heading container and the filter row.
        let sibling = h1Parent.nextElementSibling;
        while (sibling) {
            const next = sibling.nextElementSibling;
            const hasText = sibling.textContent.trim().length > 0;
            const hasInteractive = sibling.querySelector('input, select, button');
            if (!hasText && !hasInteractive) {
                sibling.remove();
            } else {
                break; // hit real content — stop
            }
            sibling = next;
        }
    }

    // Run immediately, then re-run at short intervals to catch dynamically rendered content
    // (Lekolar renders parts of the page via JavaScript after DOMContentLoaded).
    doCleanup();
    setTimeout(doCleanup, 200);
    setTimeout(doCleanup, 800);
}


// Settings
async function loadSettingsAndInit() {
    try {
        // Pull everything we know about; merge against defaults to fill gaps.
        const items = await storageSyncGet(null);
        currentSettings = (typeof lesMergeSettings === 'function')
            ? lesMergeSettings(items)
            : { ...currentSettings, ...items };
    } catch (error) {
        console.error('LES Error: Failed to read settings', error);
    }

    // Initialize non-restricted features immediately while entitlement probe runs.
    initAll();

    try {
        await resolveRestrictedFeatureAccess(false);
        lesDebugLog('entitlement status:', restrictedFeatureAccess);
    } catch (error) {
        // Fail closed for restricted features if probe resolution throws.
        restrictedFeatureAccess = {
            status: 'error',
            entitled: false,
            checkedAt: Date.now(),
            error: (error && error.message) ? error.message : String(error)
        };
        console.warn('LES: SharePoint entitlement check failed, restricted features disabled', error);
    }

    initAll();
}

// --- Variant hints --------------------------------------------------------
// Lekolar product pages only render the *next* variant dropdown after the
// previous one has been chosen (e.g. "Korkeus" only appears after "Väri"
// is picked). The page's own VariantUtil knows about every dropdown up
// front. We inject a bridge into the page world that mirrors the full
// dropdown list to a dataset attribute on <html>, and from the content
// script we add greyed-out placeholders for any dropdowns that aren't
// rendered yet.

let lesVariantBridgeInstalled = false;
let lesVariantHintsObserver = null;

function lesInstallVariantBridge() {
    if (lesVariantBridgeInstalled) return;
    if (!document.documentElement) return;
    lesVariantBridgeInstalled = true;
    const script = document.createElement('script');
    script.textContent = `(function(){
        function write() {
            try {
                var vu = window.productPage && window.productPage.variantUtil;
                var dd = vu && vu._dropdowns;
                if (Array.isArray(dd)) {
                    document.documentElement.dataset.lesDropdowns = JSON.stringify(dd);
                    document.documentElement.dispatchEvent(new CustomEvent('les-variant-bridge-update'));
                }
            } catch (e) {}
        }
        function hook() {
            try {
                if (!window.productPage || window.__lesVariantBridgeHooked) return false;
                window.__lesVariantBridgeHooked = true;
                var origInit = window.productPage.initVariants;
                if (typeof origInit === 'function') {
                    window.productPage.initVariants = function() {
                        var r = origInit.apply(this, arguments);
                        write();
                        return r;
                    };
                }
                var origUpdate = window.productPage.updateVariant;
                if (typeof origUpdate === 'function') {
                    window.productPage.updateVariant = function() {
                        var r = origUpdate.apply(this, arguments);
                        write();
                        return r;
                    };
                }
                write();
                return true;
            } catch (e) { return false; }
        }
        if (!hook()) {
            var tries = 0;
            var iv = setInterval(function(){
                if (hook() || ++tries > 40) clearInterval(iv);
            }, 250);
        }
    })();`;
    (document.head || document.documentElement).appendChild(script);
    script.remove();
    document.documentElement.addEventListener('les-variant-bridge-update', () => {
        if (!lesContentDisabled() && currentSettings.variantHints !== false) {
            renderVariantHints();
        }
    });
}

function readVariantDropdowns() {
    try {
        const raw = document.documentElement && document.documentElement.dataset
            ? document.documentElement.dataset.lesDropdowns
            : '';
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : null;
    } catch (e) { return null; }
}

function formatVariantHintOptions(options) {
    if (!Array.isArray(options) || options.length === 0) return '';
    const visibleOptions = options
        .slice(0, 2)
        .map(option => String(option || '').trim())
        .filter(Boolean);
    if (visibleOptions.length === 0) return '';
    const remainingCount = Math.max(0, options.length - visibleOptions.length);
    return remainingCount > 0
        ? `${visibleOptions.join(' · ')} · +${remainingCount}`
        : visibleOptions.join(' · ');
}

function renderVariantHints() {
    const container = document.querySelector('.product-variants.jsProductVariants');
    if (!container) return;
    const dropdowns = readVariantDropdowns();
    if (!dropdowns || dropdowns.length === 0) {
        container.querySelectorAll('.les-variant-hint').forEach(n => n.remove());
        return;
    }
    const rendered = new Set();
    container.querySelectorAll('select').forEach(sel => {
        const first = sel.options && sel.options[0];
        if (first && first.value === '' && first.textContent) {
            rendered.add(first.textContent.trim());
        }
    });
    const existingHintLabels = new Set();
    container.querySelectorAll('.les-variant-hint').forEach(hint => {
        const label = hint.dataset.lesHintLabel;
        if (rendered.has(label)) {
            hint.remove();
        } else {
            existingHintLabels.add(label);
        }
    });
    dropdowns.forEach(dd => {
        if (!dd || typeof dd.Label !== 'string') return;
        const label = dd.Label.trim();
        if (!label || rendered.has(label) || existingHintLabels.has(label)) return;
        const options = Array.isArray(dd.Options) ? dd.Options : [];
        const hint = document.createElement('div');
        hint.className = 'les-variant-hint';
        hint.dataset.lesHintLabel = label;
        hint.title = 'Valitse edellinen vaihtoehto avataksesi tämän';

        const fake = document.createElement('div');
        fake.className = 'les-variant-hint-dropdown';
        const labelSpan = document.createElement('span');
        labelSpan.className = 'les-variant-hint-label';
        labelSpan.textContent = label;
        const optsSpan = document.createElement('span');
        optsSpan.className = 'les-variant-hint-options';
        optsSpan.textContent = formatVariantHintOptions(options);
        const lock = document.createElement('span');
        lock.className = 'les-variant-hint-lock';
        lock.textContent = '🔒';
        lock.setAttribute('aria-hidden', 'true');
        fake.appendChild(lock);
        fake.appendChild(labelSpan);
        if (optsSpan.textContent) fake.appendChild(optsSpan);
        hint.appendChild(fake);
        container.appendChild(hint);
    });
}

function initVariantHints() {
    if (lesContentDisabled() || currentSettings.variantHints === false) {
        document.querySelectorAll('.les-variant-hint').forEach(n => n.remove());
        if (lesVariantHintsObserver) {
            lesVariantHintsObserver.disconnect();
            lesVariantHintsObserver = null;
        }
        return;
    }
    const container = document.querySelector('.product-variants.jsProductVariants');
    if (!container) return;
    lesInstallVariantBridge();
    renderVariantHints();
    if (lesVariantHintsObserver) lesVariantHintsObserver.disconnect();
    lesVariantHintsObserver = new MutationObserver(() => {
        renderVariantHints();
    });
    lesVariantHintsObserver.observe(container, { childList: true, subtree: true });
}

// Initialize
function initAll() {
    if (lesContentDisabled()) {
        // Master switch off, or this country is disabled. Tear down any UI
        // that may have been injected before the flag flipped.
        cleanupRestrictedUi();
        cleanupProductTreeUi();
        cleanupProductNoteUi();
        cleanupProductCardPptButton();
        cleanupProductLayoutResizer();
        restorePriceAdjustments();
        try { applyEnvironmentalLogoVisibility(); } catch (e) {}
        return;
    }

    if (!canUseRestrictedFeatures()) {
        cleanupRestrictedUi();
    }

    applyEnvironmentalLogoVisibility();
    compactSearchPage();
    initProductTreeExplorer();
    initProductLayoutResizer();
    initProductComparisonUi();
    initCartExportUi();
    initProductNotesUi();
    initVariantHints();
    applyPriceAdjustments();
    if (currentSettings.infiniteScroll) {
        initSearchConsolidation();
    }
    if (currentSettings.copyButtons) {
        findAndInject();
        initHoverCopySystem();
    }
    // @FIREFOX_ONLY_START
    if (canUseRestrictedFeatures()) {
        initPriceSorting();
    }
    // @FIREFOX_ONLY_END
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', loadSettingsAndInit);
} else {
    loadSettingsAndInit();
}
window.addEventListener('load', () => {
    // One late pass catches UI rendered after full page hydration.
    setTimeout(initAll, 300);
}, { once: true });

let productLayoutResizeTimeout = null;
window.addEventListener('resize', () => {
    clearTimeout(productLayoutResizeTimeout);
    productLayoutResizeTimeout = setTimeout(() => {
        if (!lesContentDisabled()) initProductLayoutResizer();
    }, 150);
});

// Watch for settings changes
chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'sync') {
        loadSettingsAndInit();
        return;
    }

    if (area === 'local' && changes[PRODUCT_NOTES_STORAGE_KEY]) {
        productNotesByKey = sanitizeProductNotesMap(changes[PRODUCT_NOTES_STORAGE_KEY].newValue);
        productNotesLoaded = true;
        syncProductNoteButtonState();
        const panel = document.querySelector('.les-product-note-panel.is-open');
        if (panel) renderProductNotePanel(panel, panel.__lesProductNoteMeta || getCurrentProductNoteMeta());
    }

    if (area === 'local' && changes[PRODUCT_LAYOUT_STORAGE_KEY]) {
        productLayoutPreference = sanitizeProductLayoutPreference(changes[PRODUCT_LAYOUT_STORAGE_KEY].newValue);
        productLayoutPreferenceLoaded = true;
        syncProductLayoutResetButton();
        initProductLayoutResizer();
    }
});

// Watch for DOM changes (Infinite Scroll, Navigation)
let lastUrl = window.location.href;
let mutationTimeout = null;

const pageObserver = new MutationObserver((mutations) => {
    // Check for URL change
    const url = window.location.href;
    if (url !== lastUrl) {
        lastUrl = url;
        clearTimeout(mutationTimeout);
        setTimeout(loadSettingsAndInit, 1500); // Re-load settings just in case
    } else {
        // Standard mutation (infinite scroll loading new items)
        // Debounce to improve performance
        clearTimeout(mutationTimeout);
        mutationTimeout = setTimeout(() => {
            if (lesContentDisabled()) return;
            initProductTreeExplorer();
            initProductLayoutResizer();
            if (currentSettings.infiniteScroll) initSearchConsolidation();
            initProductComparisonUi();
            initCartExportUi();
            initProductNotesUi();
            initVariantHints();
            applyPriceAdjustments();
            if (currentSettings.copyButtons) {
                findAndInject();
            }
        }, 250);
    }
});

let pageObserverStarted = false;
function startPageObserverWhenReady() {
    if (pageObserverStarted) return;
    if (!document.body) {
        setTimeout(startPageObserverWhenReady, 100);
        return;
    }
    pageObserverStarted = true;
    pageObserver.observe(document.body, { childList: true, subtree: true });
}

startPageObserverWhenReady();

// Dedicated observer for the mini-cart flyout.
// Strategy: watch the .js-miniCart element's class attribute.
// When the site adds 'cart-open', the flyout has just been opened and the
// AJAX content is about to (or has just) rendered. We retry on a short
// interval until .mini-cart-container-content appears, then inject.
let miniCartObserver = null;
let cartInjectRetryTimer = null;

function tryInjectCartButtons(attempts) {
    attempts = attempts || 0;
    clearTimeout(cartInjectRetryTimer);
    if (attempts > 20) return; // give up after 2 seconds

    const contentDiv = document.querySelector('.mini-cart-container-content');
    if (!contentDiv) {
        // Content not rendered yet, retry
        cartInjectRetryTimer = setTimeout(() => tryInjectCartButtons(attempts + 1), 100);
        return;
    }

    // Already injected and still there
    if (contentDiv.querySelector('.les-cart-export-actions')) return;

    initCartExportUi();
}

function startMiniCartObserver() {
    if (miniCartObserver) return;
    const miniCartEl = document.querySelector('.js-miniCart');
    if (!miniCartEl) return;

    let wasOpen = miniCartEl.classList.contains('cart-open');

    miniCartObserver = new MutationObserver(() => {
        const isOpen = miniCartEl.classList.contains('cart-open');
        if (isOpen && !wasOpen) {
            // Cart just opened — start trying to inject
            tryInjectCartButtons(0);
        }
        wasOpen = isOpen;
    });
    miniCartObserver.observe(miniCartEl, { attributes: true, attributeFilter: ['class'] });

    // If cart is already open on page load, inject immediately
    if (wasOpen) tryInjectCartButtons(0);
}

// Try once on load, and again after the page settles
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', startMiniCartObserver);
} else {
    startMiniCartObserver();
}
window.addEventListener('load', () => {
    startMiniCartObserver();
}, { once: true });

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || !message.action) return;

    if (message.action === 'lesRefreshProductNotes') {
        refreshProductNotesFromStorage();
        sendResponse({ ok: true });
        return;
    }

    if (message.action !== 'lesRefreshEntitlement') return;

    (async () => {
        try {
            await resolveRestrictedFeatureAccess(message.forceRefresh === true);
            initAll();
            sendResponse({ ok: true, status: restrictedFeatureAccess.status });
        } catch (error) {
            sendResponse({
                ok: false,
                status: 'error',
                error: (error && error.message) ? error.message : String(error)
            });
        }
    })();

    return true;
});
