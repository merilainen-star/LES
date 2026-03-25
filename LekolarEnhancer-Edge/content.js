// content.js
let currentSettings = {
    infiniteScroll: true,
    copyButtons: true,
    hideEnvironmentalLogo: false,
    modifierKey: 'shiftKey'
};
console.info('LES content script loaded');

const SHAREPOINT_PROBE_URL = 'https://lekolarab.sharepoint.com/_api/web/currentuser?$select=Id,Title';
const ENTITLEMENT_CACHE_KEY = 'lesSharePointEntitlement';
const ENTITLEMENT_CACHE_TTL_MS = 3 * 60 * 60 * 1000;

let restrictedFeatureAccess = {
    status: 'unknown',
    entitled: false,
    checkedAt: 0,
    error: null
};
let entitlementCheckInFlight = null;

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
    const sortContainer = document.querySelector('.lekolar-sort-container');
    if (sortContainer) sortContainer.remove();

    const sortOverlay = document.getElementById('lekolar-sort-overlay');
    if (sortOverlay) sortOverlay.remove();

    const complianceBtn = document.querySelector('.lekolar-compliance-btn');
    if (complianceBtn) complianceBtn.remove();

    const specSearchBtn = document.querySelector('.les-spec-search-btn');
    if (specSearchBtn) specSearchBtn.remove();

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

        const timeoutId = setTimeout(() => {
            finish({
                status: 'error',
                entitled: false,
                error: 'probe_timeout',
                checkedAt: Date.now()
            });
        }, 3000);

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

function getProductName() {
    // Only target the main product h1 by looking inside product page wrappers
    const h1 = document.querySelector('.product-info h1, .product-page-wrapper h1, .product-page h1');
    return h1 ? h1.innerText.trim() : null;
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

    // Shared helper to update tooltip based on modifier key state
    function updateTooltip(isModifier) {
        const tooltip = button.querySelector('.tooltip');
        if (isModifier) {
            tooltip.innerText = "Copy number + name (Link)";
        } else {
            tooltip.innerText = `Copy ${type}`;
        }
    }

    // Key listeners for when the mouse is stationary over the button
    function onKeyDown(e) {
        if (e.key === 'Shift' || e.key === 'Control' || e.key === 'Alt') {
            updateTooltip(e[currentSettings.modifierKey]);
        }
    }
    function onKeyUp(e) {
        if (e.key === 'Shift' || e.key === 'Control' || e.key === 'Alt') {
            updateTooltip(e[currentSettings.modifierKey]);
        }
    }

    button.addEventListener('mouseenter', (e) => {
        updateTooltip(e[currentSettings.modifierKey]);
        document.addEventListener('keydown', onKeyDown);
        document.addEventListener('keyup', onKeyUp);
    });

    button.addEventListener('mouseleave', () => {
        document.removeEventListener('keydown', onKeyDown);
        document.removeEventListener('keyup', onKeyUp);
    });

    button.addEventListener('mousemove', (e) => {
        updateTooltip(e[currentSettings.modifierKey]);
    });

    button.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();

        let textToCopy = getValue();

        if (e[currentSettings.modifierKey]) {
            const context = typeof getCopyContext === 'function' ? (getCopyContext() || {}) : {};
            const name = context.name || getProductName();
            const number = context.number || ((type === 'number' && textToCopy) ? textToCopy : getProductNumber());
            const url = context.url || window.location.href;

            if (name && number) {
                const plainText = `${number} ${name} - ${url}`;
                const htmlText = `<a href="${escapeHtml(url)}">${escapeHtml(number)} ${escapeHtml(name)}</a>`;

                try {
                    const clipboardItem = new ClipboardItem({
                        "text/plain": new Blob([plainText], { type: "text/plain" }),
                        "text/html": new Blob([htmlText], { type: "text/html" })
                    });

                    navigator.clipboard.write([clipboardItem]).then(onCopySuccess).catch(err => {
                        console.warn('LES: Failed to copy rich text:', err);
                        navigator.clipboard.writeText(plainText).then(onCopySuccess);
                    });
                } catch (e) {
                    // Fallback for browsers (like some Firefox setups) that don't support ClipboardItem natively
                    navigator.clipboard.writeText(plainText).then(onCopySuccess);
                }
                return;
            }
        }

        if (textToCopy) {
            navigator.clipboard.writeText(textToCopy).then(onCopySuccess).catch(err => {
                console.error('Failed to copy text: ', err);
            });
        }

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

function applyEnvironmentalLogoVisibility() {
    const shouldHide = Boolean(currentSettings.hideEnvironmentalLogo) && isListPage();
    document.documentElement.classList.toggle('les-hide-environmental-logo', shouldHide);
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

    // 2. Inject Product Name Button
    if (!document.querySelector('.lekolar-copy-btn[data-type="name"]')) {
        // Strict targeting so it doesn't accidentally attach to search result counters or category titles
        const h1 = document.querySelector('.product-info h1, .product-page-wrapper h1, .product-page h1');
        if (h1) {
            const name = h1.innerText.trim();
            const btn = createCopyButton(name, 'name');
            h1.appendChild(btn);
        }
    }

    const restrictedEnabled = canUseRestrictedFeatures();

    // 3. Inject Compliance Lookup Button (product pages only)
    if (restrictedEnabled && !isListPage()) {
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
                label.textContent = 'Search in SharePoint';

                btn.appendChild(svg);
                btn.appendChild(label);
            }

            // Always refresh URL/title in case of SPA navigation between product pages.
            btn.href = complianceUrl;
            btn.title = `Search ${baseNumber} in SharePoint`;

            // Keep placement at bottom of the Tuotetiedot / product-properties sidebar.
            const sidebar = document.querySelector('.product-properties, .product-attributes, .product-details-sidebar, .product-specs');
            if (sidebar && btn.parentElement !== sidebar) {
                sidebar.appendChild(btn);
            } else if (!sidebar) {
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

    // 4. Inject Spec Search (checkboxes + links on spec rows)
    if (restrictedEnabled) {
        injectSpecSearch();
    } else {
        const staleSpecBtn = document.querySelector('.les-spec-search-btn');
        if (staleSpecBtn) staleSpecBtn.remove();
    }
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
    { patterns: ['pituus', 'length', 'längd'], filterKey: 'length', type: 'dimension' },
    { patterns: ['istuinkorkeus', 'seat height', 'sitthöjd'], filterKey: 'seatHeight', type: 'dimension' },
    { patterns: ['korkeus', 'height', 'höjd'], filterKey: 'height', type: 'dimension' },
    { patterns: ['istuinleveys', 'seat width', 'sittbredd'], filterKey: 'seatWidth', type: 'dimension' },
    { patterns: ['leveys', 'width', 'bredd'], filterKey: 'width', type: 'dimension' },
    { patterns: ['halkaisija', 'diameter'], filterKey: 'diameter', type: 'dimension' },
    { patterns: ['istuinsyvyys', 'seat depth', 'sittdjup'], filterKey: 'seatDepth', type: 'dimension' },
    { patterns: ['syvyys', 'depth', 'djup'], filterKey: 'depth', type: 'dimension' },

    // Text attributes (link-only, no checkbox needed)
    { patterns: ['väri', 'color', 'colour', 'färg'], filterKey: 'color', type: 'text' },
    { patterns: ['materiaali', 'material'], filterKey: 'material', type: 'text' },
    { patterns: ['jalkojen materiaali', 'leg material', 'benmaterial'], filterKey: 'legMaterial', type: 'text' },
    { patterns: ['ympäristömerkinnät', 'ympäristömerkintä', 'ecolabel', 'miljömärkning'], filterKey: 'ecolabel', type: 'text' },
    { patterns: ['tuoteperhe', 'product series', 'produktserie'], filterKey: 'series', type: 'text' },
    { patterns: ['pöytälevyn muoto', 'table top shape', 'bordsskivans form'], filterKey: 'shape', type: 'text' },
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

        const hasBuildUrl = typeof window.buildLekolarSearchUrl === 'function';
        const fullText = valEl.innerText.trim();

        if (spec.type === 'dimension') {
            if (hasBuildUrl) {
                const numericPart = fullText.match(/(\d+(?:[.,]\d+)?)\s*(cm|mm|m)?/);
                if (numericPart) {
                    const link = document.createElement('a');
                    link.className = 'les-spec-link';
                    link.href = window.buildLekolarSearchUrl(baseUrl, '', { [spec.filterKey]: searchValue });
                    link.target = '_blank';
                    link.rel = 'noopener noreferrer';
                    link.title = `Search: ${th.innerText.replace(':', '').trim()} ${numericPart[0]}`;
                    link.textContent = numericPart[0];

                    const rest = fullText.substring(numericPart.index + numericPart[0].length);
                    valEl.textContent = fullText.substring(0, numericPart.index);
                    valEl.appendChild(link);
                    if (rest) valEl.appendChild(document.createTextNode(rest));
                }
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
                link.href = window.buildLekolarSearchUrl(baseUrl, '', { [spec.filterKey]: searchValue });
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
                    link.href = window.buildLekolarSearchUrl(baseUrl, '', { [spec.filterKey]: value });
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
        label.textContent = ' Search';

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

            if (typeof window.buildLekolarSearchUrl === 'function') {
                const searchUrl = window.buildLekolarSearchUrl(baseUrl, '', filters);
                const opened = window.open(searchUrl, '_blank', 'noopener,noreferrer');
                if (opened) opened.opener = null;
            }
        });

        let buttonsBar = document.querySelector('.les-buttons-bar');
        if (!buttonsBar) {
            buttonsBar = document.createElement('div');
            buttonsBar.className = 'les-buttons-bar';
            const complianceBtn = document.querySelector('.lekolar-compliance-btn');
            if (complianceBtn) {
                complianceBtn.parentElement.insertBefore(buttonsBar, complianceBtn);
                buttonsBar.appendChild(complianceBtn);
            } else {
                const sidebar = document.querySelector('.product-properties, .product-attributes, .product-details-sidebar, .product-specs');
                if (sidebar) {
                    sidebar.appendChild(buttonsBar);
                }
            }
        }
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
            const match = text.match(/(?:Tuotenro|Art\.nr|Varenr)[\.\s:]*\s*([\d-]+)/i);
            if (match) {
                productNumber = match[1];
                break;
            }

            let next = element.nextSibling;
            while (next && (next.nodeType === 8 || (next.nodeType === 3 && !(next.textContent || '').trim()))) {
                next = next.nextSibling;
            }
            if (next && next.textContent) {
                const numberMatch = next.textContent.trim().match(/^:?\s*([\d-]+)/);
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

function injectCopyButtonOnCard(card, number) {
    if (card.querySelector('.lekolar-copy-btn[data-type="number"]')) return;

    const btn = createCopyButton(number, 'number', {
        getCopyContext: () => ({
            number,
            name: getProductCardName(card),
            url: getProductCardUrl(card)
        })
    });
    btn.classList.add('lekolar-hover-copy');

    let target = card.querySelector('.product-artno, .eS-product-artno, [class*="artno"]');

    if (target) {
        target.textContent = `Tuotenro: ${number} `;
        target.appendChild(btn);
    } else {
        target = card.querySelector('.product-title, .inner-title, h3, .product-name, [class*="title"], .eS-productname');
        if (!target) target = card.querySelector('a') || card;
        target.appendChild(btn);
    }
}

async function handleProductCardHover(card) {
    if (card.querySelector('.lekolar-copy-btn[data-type="number"]')) return;

    const url = getProductCardUrl(card);
    if (!url) return;

    // Check cache first — instant show
    if (fetchedProducts.has(url)) {
        const number = fetchedProducts.get(url);
        if (number) injectCopyButtonOnCard(card, number);
        return;
    }

    // Direct fetch (bypass slow queue) for responsiveness
    const number = await fetchProductNumberDirect(url);
    if (number) injectCopyButtonOnCard(card, number);
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

    // Remove the search navigation tabs (Tuotteet, Vinkkejä, Sisältö)
    const navs = document.querySelectorAll('nav.main-search-nav, nav.js-searchNavigation, .js-searchNavigation');
    navs.forEach(nav => {
        nav.style.display = 'none';
        nav.style.height = '0';
        nav.style.margin = '0';
        nav.style.padding = '0';
        nav.style.overflow = 'hidden';
    });

    // Also hide the parent container (.search-filter-panel) which has display:contents inline
    const panels = document.querySelectorAll('.search-filter-panel, [class*="search-filter-panel"]');
    panels.forEach(panel => {
        panel.style.setProperty('display', 'none', 'important');
        panel.style.setProperty('height', '0', 'important');
        panel.style.setProperty('margin', '0', 'important');
        panel.style.setProperty('padding', '0', 'important');
    });

    // Also try to find elements by data-content-type="products" parent container
    const searchResults = document.querySelectorAll('[data-content-type="products"]');
    searchResults.forEach(el => {
        // We no longer zero out the margin here for everything
    });

    // The search page has a massive inline 10em margin-top because we hid the tabs.
    // We strictly apply a margin-fix ONLY on search pages, so product pages are untouched.
    if (isSearch) {
        const searchResultEls = document.querySelectorAll('.search-result, .js-searchResults');
        searchResultEls.forEach(el => {
            el.style.setProperty('margin-top', '20px', 'important'); // 20px clearance below header
            el.style.setProperty('padding-top', '0', 'important');
        });
    }
}


// Settings
async function loadSettingsAndInit() {
    try {
        const items = await storageSyncGet({
            infiniteScroll: true,
            copyButtons: true,
            hideEnvironmentalLogo: false,
            modifierKey: 'shiftKey'
        });
        currentSettings = items;
    } catch (error) {
        console.error('LES Error: Failed to read settings', error);
    }

    // Initialize non-restricted features immediately while entitlement probe runs.
    initAll();

    try {
        await resolveRestrictedFeatureAccess(false);
        console.info('LES entitlement status:', restrictedFeatureAccess);
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

// Initialize
function initAll() {
    if (!canUseRestrictedFeatures()) {
        cleanupRestrictedUi();
    }

    applyEnvironmentalLogoVisibility();
    compactSearchPage();
    if (currentSettings.infiniteScroll) {
        initSearchConsolidation();
    }
    if (currentSettings.copyButtons) {
        findAndInject();
        initHoverCopySystem();
    }
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

// Watch for settings changes
chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'sync') {
        loadSettingsAndInit();
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
            if (currentSettings.infiniteScroll) initSearchConsolidation();
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

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || message.action !== 'lesRefreshEntitlement') return;

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
