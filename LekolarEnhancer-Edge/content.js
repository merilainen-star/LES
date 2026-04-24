// content.js
let currentSettings = {
    infiniteScroll: true,
    copyButtons: true,
    hideEnvironmentalLogo: false,
    modifierKey: 'shiftKey',
    secondaryModifierKey: 'altKey'
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
const swedishReferenceCache = new Map();

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

    // Shared helper to update tooltip based on modifier key state
    function updateTooltip(e) {
        const tooltip = button.querySelector('.tooltip');
        const isPrimary = currentSettings.modifierKey !== 'none' && e[currentSettings.modifierKey];
        const isSecondary = !isPrimary && currentSettings.secondaryModifierKey !== 'none' && e[currentSettings.secondaryModifierKey];
        if (isPrimary) {
            tooltip.innerText = "Copy number + name (Link)";
        } else if (isSecondary) {
            tooltip.innerText = "Copy number + name";
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

        let textToCopy = getValue();
        const isPrimary = currentSettings.modifierKey !== 'none' && e[currentSettings.modifierKey];
        const isSecondary = !isPrimary && currentSettings.secondaryModifierKey !== 'none' && e[currentSettings.secondaryModifierKey];

        if (isPrimary) {
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

        if (isSecondary) {
            const context = typeof getCopyContext === 'function' ? (getCopyContext() || {}) : {};
            const name = context.name || getProductName();
            const number = context.number || ((type === 'number' && textToCopy) ? textToCopy : getProductNumber());

            if (name && number) {
                navigator.clipboard.writeText(`${number} ${name}`).then(onCopySuccess).catch(err => {
                    console.error('Failed to copy text: ', err);
                });
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

function getMainProductImageUrl() {
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

function getSwedishReferencePanel() {
    return document.querySelector('.les-sv-reference-panel');
}

function ensureSwedishReferencePanel() {
    let panel = getSwedishReferencePanel();
    if (panel) return panel;

    panel = document.createElement('section');
    panel.className = 'les-sv-reference-panel';
    panel.innerHTML = `
        <div class="les-sv-reference-header">
            <div>
                <strong>Swedish source text</strong>
                <div class="les-sv-reference-subtitle">Original Swedish product text for quick reference.</div>
            </div>
            <button type="button" class="les-sv-reference-close" aria-label="Close Swedish reference">Close</button>
        </div>
        <div class="les-sv-reference-status">Loading Swedish reference...</div>
        <div class="les-sv-reference-body" hidden></div>
        <div class="les-sv-reference-actions" hidden></div>
    `;

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
                reject(new Error((response && response.error) ? response.error : 'fetch_failed'));
                return;
            }
            resolve(response);
        });
    });
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
        throw new Error((error && error.message) ? error.message : 'NetworkError when attempting to fetch resource.');
    }
}

function findSearchResultProductUrl(doc, identifiers = []) {
    if (!doc) return null;
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
            const link = card ? card.querySelector('a[href*="/sortiment/"], a[href*="/verkkokauppa/"]') : null;
            if (link && link.href) return link.href;
        }
    }

    const cards = doc.querySelectorAll('.product-item, .category-product, .product-list-item, article, li, .swiper-slide');
    for (const card of cards) {
        const text = normalizeWhitespace(card.textContent);
        if (!text) continue;
        if (!cleanedIds.some(id => text.includes(id))) continue;
        const link = card.querySelector('a[href*="/sortiment/"], a[href*="/verkkokauppa/"]');
        if (link && link.href) return link.href;
    }

    const candidateLinks = Array.from(doc.querySelectorAll('a[href*="/sortiment/"]'))
        .map(link => link.href)
        .filter(Boolean)
        .filter((href, index, list) => list.indexOf(href) === index);

    if (candidateLinks.length === 1) {
        return candidateLinks[0];
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
    const queries = [normalizedNumber, productCode, productName].filter(Boolean);
    const identifiers = [normalizedNumber, productCode].filter(Boolean);

    let productUrl = '';
    for (const query of queries) {
        const searchUrl = (typeof buildLekolarSearchUrl === 'function')
            ? buildLekolarSearchUrl(searchBaseUrl, query, {})
            : `${searchBaseUrl}?query=${encodeURIComponent(query)}`;
        const searchDoc = await fetchHtmlDocument(searchUrl);
        const fetchedUrl = normalizeWhitespace(searchDoc.__lesFetchedUrl || '');
        if (fetchedUrl.includes('/sortiment/')) {
            productUrl = fetchedUrl;
        } else {
            productUrl = findSearchResultProductUrl(searchDoc, identifiers);
        }
        if (productUrl) break;
    }

    if (!productUrl) throw new Error('Could not find Swedish product page');

    const productDoc = await fetchHtmlDocument(productUrl);
    const result = extractSwedishProductData(productDoc, productUrl);
    if (!result.description) throw new Error('Swedish description was empty');

    swedishReferenceCache.set(normalizedNumber, result);
    return result;
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
                    status.textContent = `Translation failed: ${(error && error.message) ? error.message : 'unknown_error'}`;
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
        body.innerHTML = '';
    }
    if (actions) {
        actions.hidden = true;
        actions.innerHTML = '';
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
        renderSwedishReferenceError(panel, (error && error.message) ? error.message : 'Could not load Swedish reference.');
    } finally {
        updateSwedishReferenceButtonState(button, 'idle');
    }
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

    // 2b. Inject product image copy button
    if (!document.querySelector('.les-image-copy-btn')) {
        ensureProductImageActionButton();
    }

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

    const restrictedEnabled = canUseRestrictedFeatures();

    // 4. Inject Compliance Lookup Button (product pages only)
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

    // 5. Inject Spec Search (checkboxes + links on spec rows)
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
                const numericPart = fullText.match(/(\d+(?:[.,]\d+)?)\s*(cm|mm|m)?/);
                if (numericPart) {
                    const link = document.createElement('a');
                    link.className = 'les-spec-link';
                    link.href = buildSpecSearchUrl(baseUrl, '', { [spec.filterKey]: searchValue });
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
        
        gridContainer.innerHTML = '';
        allSortedCards.forEach(card => gridContainer.appendChild(card));
        
        overlay.style.display = 'none';
        
        setTimeout(() => {
            if (currentSettings.copyButtons) {
                findAndInject();
            }
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
    select.innerHTML = `
        <option value="">Default</option>
        <option value="asc">Price: Low to High</option>
        <option value="desc">Price: High to Low</option>
    `;
    
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
        const items = await storageSyncGet({
            infiniteScroll: true,
            copyButtons: true,
            hideEnvironmentalLogo: false,
            modifierKey: 'shiftKey',
            secondaryModifierKey: 'altKey'
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
