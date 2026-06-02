// background.js — Background logic for omnibox search & default settings.
// Chrome MV3 runs this as a service worker and loads siblings via importScripts.
// Firefox runs this as a background page and loads siblings via manifest.scripts.
if (typeof importScripts === 'function') {
    try {
        importScripts(
            'vendor/pptxgen-prelude.js',
            'vendor/pptxgen.bundle.js',
            'vendor/pptxgen-global.js',
            'defaults.js',
            'searchUtils.js',
            'cryptoVault.js',
            'facetVocabulary.js',
            'categoryClassifier.js',
            'aiPrompt.js',
            'aiProviders.js'
        );
    } catch (e) {
        console.error("Failed to load background scripts", e);
    }
}

const LES_AI_FI_SEARCH_BASE = 'https://www.lekolar.fi/haku/';
const LES_EXTERNAL_DATA_PERMISSIONS = ['searchTerms', 'websiteContent'];

function lesStorageSyncGetAll() {
    return new Promise(resolve => chrome.storage.sync.get(null, data => resolve(data || {})));
}

function lesGetPermissionsApi() {
    if (typeof browser !== 'undefined' && browser.permissions) return browser.permissions;
    if (typeof chrome !== 'undefined' && chrome.permissions) return chrome.permissions;
    return null;
}

function lesPermissionsGetAll() {
    const api = lesGetPermissionsApi();
    if (!api || typeof api.getAll !== 'function') return Promise.resolve(null);
    try {
        const result = api.getAll();
        if (result && typeof result.then === 'function') return result;
    } catch (_) {
        // Chrome-compatible callback API fallback.
    }
    return new Promise(resolve => {
        try {
            api.getAll(resolve);
        } catch (_) {
            resolve(null);
        }
    });
}

async function lesHasBuiltInExternalDataConsent() {
    const perms = await lesPermissionsGetAll();
    const data = perms && Array.isArray(perms.data_collection) ? perms.data_collection : null;
    if (!Array.isArray(data)) return { supported: false, granted: false };
    return {
        supported: true,
        granted: LES_EXTERNAL_DATA_PERMISSIONS.every(p => data.includes(p))
    };
}

async function lesHasExternalServicesConsent(storedSettings) {
    const stored = storedSettings || await lesStorageSyncGetAll();
    const settings = (typeof lesMergeSettings === 'function')
        ? lesMergeSettings(stored)
        : { ...DEFAULT_SETTINGS, ...stored };
    if (!settings.externalServicesConsent) return false;

    const builtIn = await lesHasBuiltInExternalDataConsent();
    return !builtIn.supported || builtIn.granted;
}

async function lesRequireExternalServicesConsent(storedSettings) {
    if (!(await lesHasExternalServicesConsent(storedSettings))) {
        throw new Error('external_services_consent_required');
    }
}

function lesAiLookupVocabulary(userText) {
    const category = lesClassifyCategory(userText);
    const vocab = LES_FACET_VOCABULARY[category] || LES_FACET_VOCABULARY._default;
    return { category, vocab };
}

async function lesAiResolveQueryViaProvider(provider, userText, model) {
    const apiKey = await lesVaultGetKey(provider);
    if (!apiKey) throw new Error('missing_api_key');
    const { category, vocab } = lesAiLookupVocabulary(userText);
    const systemPrompt = lesAiBuildSystemPrompt(PIM_TO_FACET_MAP, vocab);
    const raw = await lesAiExtractFacets({ provider, userText, systemPrompt, apiKey, model });
    const extracted = lesAiValidateExtraction(raw, PIM_TO_FACET_MAP, vocab);
    extracted.category = category;
    return extracted;
}

// DEFAULT_SETTINGS now lives in defaults.js (LES_DEFAULT_SETTINGS) so popup,
// content, and background share one source of truth.
const DEFAULT_SETTINGS = (typeof LES_DEFAULT_SETTINGS !== 'undefined')
    ? LES_DEFAULT_SETTINGS
    : {
        extensionEnabled: true,
        enabledCountries: { fi: true, se: true, no: true, dk: true },
        infiniteScroll: true,
        copyButtons: true,
        modifierKey: 'shiftKey',
        countries: {
            fi: { enabled: true, url: 'https://www.lekolar.fi/haku/?query=' },
            se: { enabled: false, url: 'https://www.lekolar.se/sok/?query=' },
            no: { enabled: false, url: 'https://www.lekolar.no/sok/?query=' },
            dk: { enabled: false, url: 'https://www.lekolar.dk/sog/?query=' }
        }
    };

const DEFAULT_SHAREPOINT_PROBE_URL = 'https://lekolarab.sharepoint.com/_api/web/currentuser?$select=Id,Title';
const SHAREPOINT_REQUEST_TIMEOUT_MS = 12000;

// Set defaults on install / upgrade. Always write the merged result so any
// new defaults added in this version land in storage on first launch.
chrome.runtime.onInstalled.addListener(() => {
    chrome.storage.sync.get(null, (existing) => {
        const merged = (typeof lesMergeSettings === 'function')
            ? lesMergeSettings(existing || {})
            : { ...DEFAULT_SETTINGS, ...(existing || {}) };
        chrome.storage.sync.set(merged);
    });
});

// Parse query string into filters and search phrase
function parseOmniboxQuery(text) {
    const filters = {};
    let queryArgs = [];
    
    // Split by spaces
    const parts = text.split(/\s+/);
    
    const knownKeys = {
        'length': 'length', 'pituus': 'length',
        'width': 'width', 'leveys': 'width',
        'height': 'height', 'korkeus': 'height',
        'depth': 'depth', 'syvyys': 'depth',
        'diameter': 'diameter', 'halkaisija': 'diameter',
        'color': 'color', 'väri': 'color', 'vari': 'color',
        'series': 'series', 'tuoteperhe': 'series',
        'material': 'material', 'materiaali': 'material',
        'ecolabel': 'ecolabel', 'ympäristö': 'ecolabel'
    };
    
    for (let i = 0; i < parts.length; i++) {
        let part = parts[i].toLowerCase();
        let matched = false;
        
        if (part.includes(':') || part.includes('=')) {
            const sep = part.includes(':') ? ':' : '=';
            const [k, v] = part.split(sep);
            if (knownKeys[k]) {
                filters[knownKeys[k]] = v;
                matched = true;
            }
        } else if (knownKeys[part] && i + 1 < parts.length) {
            filters[knownKeys[part]] = parts[i + 1];
            i++; 
            matched = true;
        }
        
        if (!matched) {
            queryArgs.push(parts[i]);
        }
    }
    
    return {
        query: queryArgs.join(' '),
        filters: filters
    };
}

// Combined Omnibox Listener (Handles country prefix + filters)
chrome.omnibox.onInputEntered.addListener((text, disposition) => {
    if (!text.trim()) return;

    // Check for country prefix like "fi: tuoli"
    const countryMatch = text.match(/^(fi|se|no|dk):\s*(.+)$/i);
    let code = null;
    let queryText = text.trim();

    if (countryMatch) {
        code = countryMatch[1].toLowerCase();
        queryText = countryMatch[2].trim();
    }

    chrome.storage.sync.get(null, (data) => {
        if (data && data.extensionEnabled === false) return;
        const countries = (data && data.countries) || DEFAULT_SETTINGS.countries;

        if (!code) {
            for (const c of ['fi', 'se', 'no', 'dk']) {
                if (countries[c] && countries[c].enabled) {
                    code = c; break;
                }
            }
        }
        if (!code) code = 'fi';

        let presetUrl = (countries[code] && countries[code].url) || DEFAULT_SETTINGS.countries[code].url;
        let baseUrl = presetUrl.split('?')[0];

        const parsed = parseOmniboxQuery(queryText);
        let fullUrl = "";

        if (typeof buildLekolarSearchUrl !== 'undefined') {
             fullUrl = buildLekolarSearchUrl(baseUrl, parsed.query, parsed.filters);
        } else {
             // Fallback if import missing
             fullUrl = presetUrl + encodeURIComponent(parsed.query);
        }

        switch (disposition) {
            case 'currentTab': chrome.tabs.update({ url: fullUrl }); break;
            case 'newForegroundTab': chrome.tabs.create({ url: fullUrl }); break;
            case 'newBackgroundTab': chrome.tabs.create({ url: fullUrl, active: false }); break;
        }
    });
});

// Provide suggestions as user types
chrome.omnibox.onInputChanged.addListener((text, suggest) => {
    const query = text.trim();
    if (!query) return;

    chrome.storage.sync.get(null, (data) => {
        if (data && data.extensionEnabled === false) {
            suggest([]);
            return;
        }
        const countries = (data && data.countries) || DEFAULT_SETTINGS.countries;
        const suggestions = [];
        for (const code of ['fi', 'se', 'no', 'dk']) {
            if (countries[code] && countries[code].enabled) {
                suggestions.push({
                    content: `${code}:${query}`,
                    description: `Search Lekolar ${code.toUpperCase()}: "${query}"`
                });
            }
        }

        // Add smart hint if filters are detected
        if (text.includes(':') || text.includes('=')) {
             suggestions.unshift({
                 content: query,
                 description: `Apply smart filters: ${query}`
             });
        }

        suggest(suggestions);
    });
});

function classifySharePointResponse(response, bodyText) {
    const finalUrl = (response.url || '').toLowerCase();
    const text = (bodyText || '').toLowerCase();
    const isOnTargetTenant = finalUrl.includes('lekolarab.sharepoint.com');

    if (response.type === 'opaqueredirect') {
        return { status: 'login_required', entitled: false };
    }

    if (response.status === 401 || response.status === 407) {
        return { status: 'login_required', entitled: false };
    }

    if (response.status === 403) {
        return { status: 'no_access', entitled: false };
    }

    if ([301, 302, 303, 307, 308].includes(response.status)) {
        return { status: 'login_required', entitled: false };
    }

    const deniedIndicators = [
        'access denied',
        'you do not have permission',
        'du har inte behörighet',
        'sinulla ei ole käyttöoikeutta',
        'ei käyttöoikeutta',
        'ingen åtkomst',
        'ingen adgang'
    ];
    if (deniedIndicators.some(token => text.includes(token))) {
        return { status: 'no_access', entitled: false };
    }

    const loginIndicators = [
        'login.microsoftonline.com',
        '/_layouts/15/authenticate.aspx',
        '/_forms/default.aspx?wa=wsignin1.0',
        'sign in to your account',
        'logga in på ditt konto',
        'kirjaudu tilillesi',
        'logg på kontoen din'
    ];
    if (!isOnTargetTenant || loginIndicators.some(token => finalUrl.includes(token) || text.includes(token))) {
        return { status: 'login_required', entitled: false };
    }

    if (response.ok) {
        return { status: 'entitled', entitled: true };
    }

    return { status: 'error', entitled: false };
}

async function probeSharePointEntitlement(probeUrl) {
    const targetUrl = probeUrl || DEFAULT_SHAREPOINT_PROBE_URL;
    if (!targetUrl.startsWith('https://lekolarab.sharepoint.com/')) {
        return {
            status: 'error',
            entitled: false,
            checkedUrl: targetUrl,
            error: 'invalid_probe_url',
            checkedAt: Date.now()
        };
    }
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), SHAREPOINT_REQUEST_TIMEOUT_MS);

    try {
        const response = await fetch(targetUrl, {
            method: 'GET',
            credentials: 'include',
            cache: 'no-store',
            redirect: 'follow',
            signal: controller.signal
        });

        const body = await response.text();
        const bodySnippet = body.slice(0, 12000);
        const classified = classifySharePointResponse(response, bodySnippet);

        return {
            ...classified,
            checkedUrl: targetUrl,
            finalUrl: response.url || targetUrl,
            httpStatus: response.status,
            checkedAt: Date.now()
        };
    } catch (error) {
        const timedOut = error && error.name === 'AbortError';
        return {
            status: 'error',
            entitled: false,
            checkedUrl: targetUrl,
            error: timedOut ? 'timeout' : (error && error.message) ? error.message : String(error),
            checkedAt: Date.now()
        };
    } finally {
        clearTimeout(timeoutId);
    }
}

async function fetchRemoteHtml(targetUrl) {
    if (!/^https:\/\/www\.lekolar\.(fi|se|no|dk)\//i.test(targetUrl || '')) {
        return {
            ok: false,
            error: 'invalid_remote_url',
            url: targetUrl || ''
        };
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 12000);

    try {
        const response = await fetch(targetUrl, {
            method: 'GET',
            credentials: 'omit',
            cache: 'no-store',
            redirect: 'follow',
            signal: controller.signal
        });

        if (!response.ok) {
            return {
                ok: false,
                error: `http_${response.status}`,
                status: response.status,
                url: response.url || targetUrl
            };
        }

        const html = await response.text();
        return {
            ok: true,
            html,
            url: response.url || targetUrl,
            status: response.status
        };
    } catch (error) {
        return {
            ok: false,
            error: (error && error.name === 'AbortError') ? 'timeout' : ((error && error.message) ? error.message : String(error)),
            url: targetUrl
        };
    } finally {
        clearTimeout(timeoutId);
    }
}

async function translateChunkViaMyMemory(chunk, source, target) {
    const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(chunk)}&langpair=${encodeURIComponent(source)}|${encodeURIComponent(target)}`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 12000);
    try {
        const response = await fetch(url, {
            method: 'GET',
            cache: 'no-store',
            redirect: 'follow',
            signal: controller.signal
        });
        if (!response.ok) {
            return { ok: false, error: `translation_http_${response.status}` };
        }
        const payload = await response.json();
        const translatedText = payload && payload.responseData && payload.responseData.translatedText
            ? String(payload.responseData.translatedText).trim()
            : '';
        if (!translatedText) {
            return { ok: false, error: 'translation_empty' };
        }
        return { ok: true, translation: translatedText };
    } catch (error) {
        return {
            ok: false,
            error: (error && error.name === 'AbortError') ? 'translation_timeout' : ((error && error.message) ? error.message : String(error))
        };
    } finally {
        clearTimeout(timeoutId);
    }
}

function splitIntoChunks(text, maxLen) {
    const chunks = [];
    let remaining = text;
    while (remaining.length > maxLen) {
        // Try to split at sentence boundary (". ") within the limit
        let splitAt = remaining.lastIndexOf('. ', maxLen);
        if (splitAt > 0) {
            splitAt += 1; // include the period
        } else {
            // Fall back to last space within limit
            splitAt = remaining.lastIndexOf(' ', maxLen);
        }
        if (splitAt <= 0) {
            splitAt = maxLen; // Hard cut if no whitespace found
        }
        chunks.push(remaining.slice(0, splitAt).trim());
        remaining = remaining.slice(splitAt).trim();
    }
    if (remaining.length > 0) {
        chunks.push(remaining);
    }
    return chunks;
}

async function translateTextViaMyMemory(text, sourceLang, targetLang) {
    const normalizedText = String(text || '').trim();
    if (!normalizedText) {
        return { ok: false, error: 'empty_text' };
    }

    const source = String(sourceLang || 'sv').trim().toLowerCase();
    const target = String(targetLang || 'en').trim().toLowerCase();

    const MAX_CHUNK = 480; // MyMemory limit is 500; stay safely under
    const chunks = splitIntoChunks(normalizedText, MAX_CHUNK);

    const translatedParts = [];
    for (const chunk of chunks) {
        const result = await translateChunkViaMyMemory(chunk, source, target);
        if (!result.ok) {
            return result;
        }
        translatedParts.push(result.translation);
    }

    return { ok: true, translation: translatedParts.join(' ') };
}

const LES_PRODUCT_CARD_PPTX_MIME = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';

function lesProductCardStripControlChars(value) {
    return String(value == null ? '' : value).replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');
}

function lesProductCardSafeFileName(value) {
    const cleaned = lesProductCardStripControlChars(value || 'product-card')
        .replace(/[<>:"/\\|?*]/g, '-')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 140)
        .replace(/[. ]+$/g, '');
    return cleaned || 'product-card';
}

function lesCreateProductCardFileName(product) {
    const title = product && (product.title || product.name) ? (product.title || product.name) : 'Product card';
    const sku = product && product.sku ? product.sku : '';
    return `${lesProductCardSafeFileName(`${sku ? sku + ' - ' : ''}${title}`)}.pptx`;
}

function lesCreateProductCardDeckFileName(fileName) {
    const raw = String(fileName || '').replace(/\.pptx$/i, '').trim();
    const requested = raw ? lesProductCardSafeFileName(raw) : 'Lekolar_Cart_Product_Cards';
    return `${requested || 'Lekolar_Cart_Product_Cards'}.pptx`;
}

function lesGetPptxGenConstructor() {
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
        throw new Error('PptxGenJS is not loaded in the extension background context.');
    }
    return ctor.default || ctor;
}

function lesGetProductCardImagePlacement(imageSize, frame) {
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

function lesGetProductCardLogoPlacement(imageSize, frame) {
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

function lesGetProductCardPptSettings(raw) {
    if (typeof lesCloneProductCardPptSettings === 'function') {
        return lesCloneProductCardPptSettings(raw);
    }
    return {
        bannerColor: '#B5121B',
        labels: { item: 'Item', description: 'Description', specifications: 'Specifications' },
        linkFormat: { tokens: [{ type: 'url' }] }
    };
}

function lesProductCardPptColor(value, fallback = 'B5121B') {
    const color = String(value || '').trim();
    return /^#[0-9a-f]{6}$/i.test(color) ? color.slice(1).toUpperCase() : fallback;
}

function lesTruncateProductCardText(value, maxLength) {
    const text = String(value || '').replace(/\s+/g, ' ').trim();
    if (!maxLength || text.length <= maxLength) return text;
    return text.slice(0, Math.max(0, maxLength - 1)).trimEnd() + '...';
}

function lesGetProductCardLinkText(product, settings) {
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
    return lesTruncateProductCardText(text || context.url, 240);
}

const LES_BG_PRODUCT_CARD_MASTER_NAME = 'LES_PRODUCT_CARD';

function lesGetProductCardTemplate(settings) {
    const tpl = settings && settings.template;
    if (tpl && typeof tpl === 'object') return tpl;
    if (typeof lesCloneProductCardPptTemplate === 'function') {
        return lesCloneProductCardPptTemplate(null);
    }
    return null;
}

function lesAddProductCardFooterLogos(slide, product, template) {
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
        const box = lesGetProductCardLogoPlacement(logo.imageSize, { x, y: env.y, w: env.slotW, h: env.h });
        if (box.x + box.w > env.maxRight) return;
        slide.addImage({ data: logo.dataUri, x: box.x, y: box.y, w: box.w, h: box.h });
        x = box.x + box.w + env.gap;
    });

    const lekolarLogo = product && product.lekolarLogo;
    if (lekolarLogo && lekolarLogo.dataUri) {
        const box = lesGetProductCardLogoPlacement(lekolarLogo.imageSize, {
            x: lek.rightX - lek.w,
            y: lek.y,
            w: lek.w,
            h: lek.h
        });
        slide.addImage({ data: lekolarLogo.dataUri, x: box.x, y: box.y, w: box.w, h: box.h });
    }
}

function lesCreateProductCardDeck(PptxGenJS, title, subject = 'Product card', pptSettings = null) {
    const pptx = new PptxGenJS();
    pptx.layout = 'LAYOUT_WIDE';
    pptx.author = 'Lekolar Enhancer';
    pptx.company = 'Lekolar';
    pptx.subject = subject;
    pptx.title = title || subject || 'Product card';
    pptx.lang = 'en-US';

    const settings = lesGetProductCardPptSettings(pptSettings);
    const template = lesGetProductCardTemplate(settings);
    const accentColor = lesProductCardPptColor(settings.bannerColor);
    const bgColor = lesProductCardPptColor(template && template.background, 'FFFFFF');
    const bannerHcm = (template && template.banner && template.banner.h) || 2.18;
    const rectShape = (pptx.ShapeType && pptx.ShapeType.rect) || 'rect';

    pptx.defineSlideMaster({
        title: LES_BG_PRODUCT_CARD_MASTER_NAME,
        background: { color: bgColor },
        objects: [
            { rect: { x: 0, y: 0, w: 13.333, h: lesCmToIn(bannerHcm), fill: { color: accentColor }, line: { color: accentColor } } }
        ]
    });

    pptx._lesProductCardCtx = { template, accentColor, bgColor, rectShape };
    return pptx;
}

function lesAddProductCardSlide(pptx, product) {
    const pptSettings = lesGetProductCardPptSettings(product.pptSettings);
    const ctx = pptx._lesProductCardCtx || {
        template: lesGetProductCardTemplate(pptSettings),
        accentColor: lesProductCardPptColor(pptSettings.bannerColor),
        rectShape: (pptx.ShapeType && pptx.ShapeType.rect) || 'rect'
    };
    const template = ctx.template;
    const accentColor = ctx.accentColor;
    const rectShape = ctx.rectShape;
    const blocks = (template && template.blocks) || {};
    const slide = pptx.addSlide({ masterName: LES_BG_PRODUCT_CARD_MASTER_NAME });

    const imageData = product.imageData || '';
    const title = product.title || 'Product card';
    const skuText = product.sku ? `${pptSettings.labels.item} ${product.sku}` : 'Product card';
    const descText = product.description || 'No product description found on page.';
    const specLines = product.specs && product.specs.length ? product.specs : ['No product specifications found on page.'];
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
        const imageBox = lesGetProductCardImagePlacement(product.imageSize, {
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

    const departmentText = String(product.department || '').replace(/\s+/g, ' ').trim();
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

    if (product.url) {
        const lB = inBox(blocks.link);
        slide.addText(lesGetProductCardLinkText(product, pptSettings), {
            ...lB,
            fontFace: 'Arial', fontSize: blocks.link.fontSize, color: '2563EB', margin: 0,
            hyperlink: { url: product.url, tooltip: 'Open product page' },
            fit: 'shrink'
        });
    }

    lesAddProductCardFooterLogos(slide, product, template);
    return slide;
}

async function lesCreateProductCardPptx(product) {
    const PptxGenJS = lesGetPptxGenConstructor();
    const pptx = lesCreateProductCardDeck(PptxGenJS, product.title || 'Product card', 'Product card', product.pptSettings);
    lesAddProductCardSlide(pptx, product);
    const base64 = await pptx.write({ outputType: 'base64', compression: true });
    return {
        ok: true,
        fileName: lesCreateProductCardFileName(product),
        mimeType: LES_PRODUCT_CARD_PPTX_MIME,
        base64
    };
}

async function lesCreateProductCardDeckPptx(products, fileName) {
    const validProducts = Array.isArray(products) ? products.filter(Boolean) : [];
    if (validProducts.length === 0) throw new Error('No products supplied for cart PPT.');

    const PptxGenJS = lesGetPptxGenConstructor();
    const pptx = lesCreateProductCardDeck(PptxGenJS, 'Lekolar cart product cards', 'Cart product cards', validProducts[0] && validProducts[0].pptSettings);
    validProducts.forEach(product => lesAddProductCardSlide(pptx, product));
    const base64 = await pptx.write({ outputType: 'base64', compression: true });
    return {
        ok: true,
        fileName: lesCreateProductCardDeckFileName(fileName),
        mimeType: LES_PRODUCT_CARD_PPTX_MIME,
        base64
    };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || !message.action) {
        return;
    }

    if (message.action === 'lesCreateProductCardPptx') {
        lesCreateProductCardPptx(message.product || {})
            .then(sendResponse)
            .catch((error) => {
                console.error('LES: Background product card PPT generation failed:', error);
                sendResponse({
                    ok: false,
                    error: (error && error.message) ? error.message : String(error)
                });
            });

        return true;
    }

    if (message.action === 'lesCreateProductCardDeckPptx') {
        lesCreateProductCardDeckPptx(message.products || [], message.fileName)
            .then(sendResponse)
            .catch((error) => {
                console.error('LES: Background cart product card PPT generation failed:', error);
                sendResponse({
                    ok: false,
                    error: (error && error.message) ? error.message : String(error)
                });
            });

        return true;
    }

    if (message.action === 'probeSharePointEntitlement') {
        probeSharePointEntitlement(message.probeUrl)
            .then(sendResponse)
            .catch((error) => {
                sendResponse({
                    status: 'error',
                    entitled: false,
                    error: (error && error.message) ? error.message : String(error),
                    checkedAt: Date.now()
                });
            });

        return true;
    }

    if (message.action === 'lesFetchRemoteHtml') {
        fetchRemoteHtml(message.url)
            .then(sendResponse)
            .catch((error) => {
                sendResponse({
                    ok: false,
                    error: (error && error.message) ? error.message : String(error),
                    url: message.url || ''
                });
            });

        return true;
    }

    if (message.action === 'lesAiSearch') {
        (async () => {
            try {
                const stored = await new Promise(r => chrome.storage.sync.get(null, r));
                if (stored && stored.aiBetaEnabled === false) {
                    sendResponse({ ok: false, error: 'beta_disabled' });
                    return;
                }
                await lesRequireExternalServicesConsent(stored);
                const provider = message.provider || (stored && stored.aiProvider) || 'openai';
                const model = message.model || (stored && stored.aiModels && stored.aiModels[provider]) || '';
                const extracted = await lesAiResolveQueryViaProvider(
                    provider,
                    message.userText,
                    model
                );
                const url = buildLekolarSearchUrl(
                    LES_AI_FI_SEARCH_BASE,
                    extracted.query,
                    extracted.filters
                );
                sendResponse({ ok: true, extracted, url });
            } catch (error) {
                sendResponse({
                    ok: false,
                    error: (error && error.message) ? error.message : String(error)
                });
            }
        })();
        return true;
    }

    if (message.action === 'lesAiTestKey') {
        (async () => {
            try {
                const stored = await lesStorageSyncGetAll();
                await lesRequireExternalServicesConsent(stored);
                const apiKey = await lesVaultGetKey(message.provider);
                if (!apiKey) {
                    sendResponse({ ok: false, error: 'missing_api_key' });
                    return;
                }
                const result = await lesAiTestKey({
                    provider: message.provider,
                    apiKey,
                    model: message.model
                });
                sendResponse(result);
            } catch (error) {
                sendResponse({
                    ok: false,
                    error: (error && error.message) ? error.message : String(error)
                });
            }
        })();
        return true;
    }

    if (message.action === 'lesTranslateText') {
        (async () => {
            const stored = await lesStorageSyncGetAll();
            await lesRequireExternalServicesConsent(stored);
            return translateTextViaMyMemory(message.text, message.sourceLang, message.targetLang);
        })()
            .then(sendResponse)
            .catch((error) => {
                sendResponse({
                    ok: false,
                    error: (error && error.message) ? error.message : String(error)
                });
            });

        return true;
    }
});
