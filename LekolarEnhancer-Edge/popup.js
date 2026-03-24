// popup.js — Settings logic for popup

const DEFAULTS = {
    infiniteScroll: true,
    copyButtons: true,
    hideEnvironmentalLogo: false,
    modifierKey: 'shiftKey',
    countries: {
        fi: { enabled: true, url: 'https://www.lekolar.fi/haku/?query=' },
        se: { enabled: false, url: 'https://www.lekolar.se/sok/?query=' },
        no: { enabled: false, url: 'https://www.lekolar.no/sok/?query=' },
        dk: { enabled: false, url: 'https://www.lekolar.dk/sog/?query=' }
    }
};

const COUNTRY_CODES = ['fi', 'se', 'no', 'dk'];
const ENTITLEMENT_CACHE_KEY = 'lesSharePointEntitlement';
const SHAREPOINT_PROBE_URL = 'https://lekolarab.sharepoint.com/_api/web/currentuser?$select=Id,Title';
const LEKOLAR_HOST_RULES = [
    { suffix: '.lekolar.fi', pattern: '*://*.lekolar.fi/*' },
    { suffix: '.lekolar.se', pattern: '*://*.lekolar.se/*' },
    { suffix: '.lekolar.no', pattern: '*://*.lekolar.no/*' },
    { suffix: '.lekolar.dk', pattern: '*://*.lekolar.dk/*' }
];

// DOM refs
const infiniteScrollEl = document.getElementById('infiniteScroll');
const copyButtonsEl = document.getElementById('copyButtons');
const hideEnvironmentalLogoEl = document.getElementById('hideEnvironmentalLogo');
const modifierKeyEl = document.getElementById('modifierKey');
const saveIndicator = document.getElementById('saveIndicator');
const permissionWarningEl = document.getElementById('permissionWarning');
const recheckEntitlementBtn = document.getElementById('recheckEntitlementBtn');
const entitlementStatusEl = document.getElementById('entitlementStatus');

// Country refs
const countryRadios = {};
const countryUrls = {};
COUNTRY_CODES.forEach(code => {
    countryRadios[code] = document.getElementById(`country-${code}`);
    countryUrls[code] = document.getElementById(`url-${code}`);
});

// Load saved settings
function loadSettings() {
    chrome.storage.sync.get(null, (data) => {
        const settings = { ...DEFAULTS, ...data };
        if (data.countries) {
            settings.countries = { ...DEFAULTS.countries };
            COUNTRY_CODES.forEach(code => {
                settings.countries[code] = { ...DEFAULTS.countries[code], ...(data.countries[code] || {}) };
            });
        }

        infiniteScrollEl.checked = settings.infiniteScroll;
        copyButtonsEl.checked = settings.copyButtons;
        hideEnvironmentalLogoEl.checked = settings.hideEnvironmentalLogo;
        modifierKeyEl.value = settings.modifierKey;

        // Find which country is enabled and select its radio
        let activeCode = 'fi'; // Default fallback
        COUNTRY_CODES.forEach(code => {
            if (settings.countries[code].enabled) {
                activeCode = code;
            }
            // Set URLs
            countryUrls[code].value = settings.countries[code].url;
        });
        if (countryRadios[activeCode]) {
            countryRadios[activeCode].checked = true;
        }
    });
}

// Save all settings
function saveSettings() {
    const countries = {};
    COUNTRY_CODES.forEach(code => {
        countries[code] = {
            enabled: countryRadios[code].checked,
            url: countryUrls[code].value.trim() || DEFAULTS.countries[code].url
        };
    });

    const settings = {
        infiniteScroll: infiniteScrollEl.checked,
        copyButtons: copyButtonsEl.checked,
        hideEnvironmentalLogo: hideEnvironmentalLogoEl.checked,
        modifierKey: modifierKeyEl.value,
        countries
    };

    chrome.storage.sync.set(settings, () => {
        showSaveIndicator();
    });
}

function showSaveIndicator() {
    saveIndicator.classList.add('visible');
    clearTimeout(showSaveIndicator._timer);
    showSaveIndicator._timer = setTimeout(() => {
        saveIndicator.classList.remove('visible');
    }, 1500);
}

function updatePermissionWarning(hasAccess) {
    if (!permissionWarningEl) return;
    permissionWarningEl.classList.toggle('hidden', hasAccess);
}

function getLekolarPatternForUrl(url) {
    if (!url) return null;
    try {
        const host = new URL(url).hostname.toLowerCase();
        for (const rule of LEKOLAR_HOST_RULES) {
            const bare = rule.suffix.replace(/^\./, '');
            if (host === bare || host.endsWith(rule.suffix)) {
                return rule.pattern;
            }
        }
    } catch (e) {
        return null;
    }
    return null;
}

function withActiveTab(callback) {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        const tab = tabs && tabs.length ? tabs[0] : null;
        callback(tab);
    });
}

function checkLekolarPermissions() {
    if (!chrome.permissions || !chrome.permissions.contains) {
        // If API is unavailable, don't show a false warning.
        updatePermissionWarning(true);
        return;
    }

    withActiveTab((tab) => {
        const originPattern = getLekolarPatternForUrl(tab && tab.url ? tab.url : '');
        if (!originPattern) {
            updatePermissionWarning(true);
            return;
        }

        chrome.permissions.contains({ origins: [originPattern] }, (hasAccess) => {
            if (chrome.runtime.lastError) {
                console.warn('LES popup: permission check failed', chrome.runtime.lastError.message);
                updatePermissionWarning(true);
                return;
            }
            updatePermissionWarning(Boolean(hasAccess));
        });
    });
}

function setEntitlementStatus(text, tone = '') {
    if (!entitlementStatusEl) return;
    entitlementStatusEl.textContent = text;
    entitlementStatusEl.classList.remove('ok', 'warn', 'error');
    if (tone) entitlementStatusEl.classList.add(tone);
}

function renderEntitlementStatus(result) {
    if (!result || !result.status) {
        setEntitlementStatus('Status: Unknown', 'warn');
        return;
    }
    if (result.status === 'entitled') {
        setEntitlementStatus('Status: Enabled (SharePoint access detected)', 'ok');
    } else if (result.status === 'login_required') {
        setEntitlementStatus('Status: Sign in to SharePoint and re-check', 'warn');
    } else if (result.status === 'no_access') {
        setEntitlementStatus('Status: SharePoint access missing', 'warn');
    } else {
        const details = result.error ? ` (${result.error})` : '';
        setEntitlementStatus(`Status: Could not verify now${details}`, 'error');
    }
}

function loadCachedEntitlementStatus() {
    if (!chrome.storage || !chrome.storage.local) {
        setEntitlementStatus('Status: Unknown', 'warn');
        return;
    }
    chrome.storage.local.get(ENTITLEMENT_CACHE_KEY, (data) => {
        if (chrome.runtime.lastError) {
            setEntitlementStatus('Status: Could not read cache', 'error');
            return;
        }
        renderEntitlementStatus(data[ENTITLEMENT_CACHE_KEY]);
    });
}

function requestEntitlementProbe() {
    return new Promise((resolve) => {
        chrome.runtime.sendMessage({ action: 'probeSharePointEntitlement', probeUrl: SHAREPOINT_PROBE_URL }, (response) => {
            if (chrome.runtime.lastError) {
                resolve({
                    status: 'error',
                    entitled: false,
                    error: chrome.runtime.lastError.message,
                    checkedAt: Date.now()
                });
                return;
            }
            resolve(response || {
                status: 'error',
                entitled: false,
                error: 'empty_response',
                checkedAt: Date.now()
            });
        });
    });
}

function persistEntitlementResult(result) {
    return new Promise((resolve) => {
        if (!chrome.storage || !chrome.storage.local) {
            resolve();
            return;
        }
        const shouldCache = result && (
            result.status === 'entitled' ||
            result.status === 'login_required' ||
            result.status === 'no_access'
        );
        if (shouldCache) {
            chrome.storage.local.set({ [ENTITLEMENT_CACHE_KEY]: result }, () => resolve());
        } else if (result && result.status === 'error') {
            // Keep the previous known state if probe failed transiently.
            resolve();
        } else {
            chrome.storage.local.remove(ENTITLEMENT_CACHE_KEY, () => resolve());
        }
    });
}

function notifyActiveTabRefresh() {
    return new Promise((resolve) => {
        withActiveTab((tab) => {
            if (!tab || !tab.id) {
                resolve();
                return;
            }
            chrome.tabs.sendMessage(tab.id, { action: 'lesRefreshEntitlement' }, () => {
                // Ignore "receiving end" errors if content script isn't on the active tab.
                resolve();
            });
        });
    });
}

async function recheckEntitlementNow() {
    if (!recheckEntitlementBtn) return;
    recheckEntitlementBtn.disabled = true;
    recheckEntitlementBtn.textContent = 'Checking...';
    setEntitlementStatus('Status: Checking SharePoint access...', 'warn');

    const result = await requestEntitlementProbe();
    await persistEntitlementResult(result);
    await notifyActiveTabRefresh();
    if (result.status === 'error') {
        loadCachedEntitlementStatus();
        const details = result.error ? ` (${result.error})` : '';
        setEntitlementStatus(`Status: Could not verify now${details}. Kept previous access state.`, 'error');
    } else {
        renderEntitlementStatus(result);
    }

    recheckEntitlementBtn.disabled = false;
    recheckEntitlementBtn.textContent = 'Re-check SharePoint Access';
}

// Auto-save on change
infiniteScrollEl.addEventListener('change', saveSettings);
copyButtonsEl.addEventListener('change', saveSettings);
hideEnvironmentalLogoEl.addEventListener('change', saveSettings);
modifierKeyEl.addEventListener('change', saveSettings);

COUNTRY_CODES.forEach(code => {
    countryRadios[code].addEventListener('change', saveSettings);
    // Debounce URL input saves
    let urlTimer;
    countryUrls[code].addEventListener('input', () => {
        clearTimeout(urlTimer);
        urlTimer = setTimeout(saveSettings, 500);
    });
});

// Initialize
document.getElementById('versionLabel').textContent = 'v' + chrome.runtime.getManifest().version;
loadSettings();
checkLekolarPermissions();
loadCachedEntitlementStatus();
if (recheckEntitlementBtn) {
    recheckEntitlementBtn.addEventListener('click', recheckEntitlementNow);
}
