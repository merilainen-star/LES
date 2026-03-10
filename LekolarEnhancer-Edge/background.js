// background.js — Service worker for omnibox search & default settings

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

// Omnibox — user types the keyword ("l") then a search term
chrome.omnibox.onInputEntered.addListener((text, disposition) => {
    const query = text.trim();
    if (!query) return;

    chrome.storage.sync.get('countries', (data) => {
        const countries = data.countries || DEFAULT_SETTINGS.countries;
        // Find first enabled country
        let searchUrl = DEFAULT_SETTINGS.countries.fi.url; // fallback
        for (const code of ['fi', 'se', 'no', 'dk']) {
            if (countries[code] && countries[code].enabled) {
                searchUrl = countries[code].url;
                break;
            }
        }

        const fullUrl = searchUrl + encodeURIComponent(query);

        switch (disposition) {
            case 'currentTab':
                chrome.tabs.update({ url: fullUrl });
                break;
            case 'newForegroundTab':
                chrome.tabs.create({ url: fullUrl });
                break;
            case 'newBackgroundTab':
                chrome.tabs.create({ url: fullUrl, active: false });
                break;
        }
    });
});

// Provide suggestions as user types (optional nice-to-have)
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
        suggest(suggestions);
    });
});

// Handle country-prefixed searches (e.g. "se:matte")
chrome.omnibox.onInputEntered.addListener((text, disposition) => {
    const countryMatch = text.match(/^(fi|se|no|dk):(.+)$/i);
    if (!countryMatch) return; // handled by first listener

    const code = countryMatch[1].toLowerCase();
    const query = countryMatch[2].trim();
    if (!query) return;

    chrome.storage.sync.get('countries', (data) => {
        const countries = data.countries || DEFAULT_SETTINGS.countries;
        const searchUrl = (countries[code] && countries[code].url) || DEFAULT_SETTINGS.countries[code].url;
        const fullUrl = searchUrl + encodeURIComponent(query);

        switch (disposition) {
            case 'currentTab':
                chrome.tabs.update({ url: fullUrl });
                break;
            case 'newForegroundTab':
                chrome.tabs.create({ url: fullUrl });
                break;
            case 'newBackgroundTab':
                chrome.tabs.create({ url: fullUrl, active: false });
                break;
        }
    });
});
