// background.js — Background logic for omnibox search & default settings.
// Chrome MV3 runs this as a service worker and loads siblings via importScripts.
// Firefox runs this as a background page and loads siblings via manifest.scripts.
if (typeof importScripts === 'function') {
    try {
        importScripts(
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

const DEFAULT_SETTINGS = {
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

// Set defaults on install
chrome.runtime.onInstalled.addListener(() => {
    chrome.storage.sync.get(null, (existing) => {
        const merged = { ...DEFAULT_SETTINGS };
        // Preserve any existing settings
        if (existing && Object.keys(existing).length > 0) {
            if (existing.infiniteScroll !== undefined) merged.infiniteScroll = existing.infiniteScroll;
            if (existing.copyButtons !== undefined) merged.copyButtons = existing.copyButtons;
            if (existing.modifierKey !== undefined) merged.modifierKey = existing.modifierKey;
            if (existing.countries) {
                for (const code of ['fi', 'se', 'no', 'dk']) {
                    if (existing.countries[code]) {
                        merged.countries[code] = { ...DEFAULT_SETTINGS.countries[code], ...existing.countries[code] };
                    }
                }
            }
        }
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

    chrome.storage.sync.get('countries', (data) => {
        const countries = data.countries || DEFAULT_SETTINGS.countries;
        
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

    chrome.storage.sync.get('countries', (data) => {
        const countries = data.countries || DEFAULT_SETTINGS.countries;
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

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || !message.action) {
        return;
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
                const extracted = await lesAiResolveQueryViaProvider(
                    message.provider,
                    message.userText,
                    message.model
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
        translateTextViaMyMemory(message.text, message.sourceLang, message.targetLang)
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
