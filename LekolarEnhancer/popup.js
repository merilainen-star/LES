// popup.js — Slim popup. Just the master power switch, the SharePoint
// entitlement status, and a button that opens the full settings page.

const ENTITLEMENT_CACHE_KEY = 'lesSharePointEntitlement';
const SHAREPOINT_PROBE_URL = 'https://lekolarab.sharepoint.com/_api/web/currentuser?$select=Id,Title';
const EDGE_ADDON_URL = 'https://microsoftedge.microsoft.com/addons/detail/poiadopjpbekbageflcbghabcidpbjhj';
const LEKOLAR_HOST_RULES = [
    { suffix: '.lekolar.fi', pattern: '*://*.lekolar.fi/*' },
    { suffix: '.lekolar.se', pattern: '*://*.lekolar.se/*' },
    { suffix: '.lekolar.no', pattern: '*://*.lekolar.no/*' },
    { suffix: '.lekolar.dk', pattern: '*://*.lekolar.dk/*' }
];

const powerBtn = document.getElementById('powerBtn');
const powerLabel = document.getElementById('powerLabel');
const powerHint = document.getElementById('powerHint');
const permissionWarningEl = document.getElementById('permissionWarning');
const recheckEntitlementBtn = document.getElementById('recheckEntitlementBtn');
const entitlementStatusEl = document.getElementById('entitlementStatus');
const openSettingsBtn = document.getElementById('openSettingsBtn');
const shareAddonBtn = document.getElementById('shareAddonBtn');
const shareToastEl = document.getElementById('shareToast');
const priceSimulationStatusEl = document.getElementById('priceSimulationStatus');

let isEnabled = true;
let shareToastTimer = null;

function paintPower() {
    powerBtn.classList.toggle('off', !isEnabled);
    if (isEnabled) {
        powerLabel.textContent = 'Enabled';
        powerLabel.style.color = '#a6e3a1';
        powerHint.textContent = 'Click to disable on all Lekolar sites';
    } else {
        powerLabel.textContent = 'Disabled';
        powerLabel.style.color = '#f38ba8';
        powerHint.textContent = 'Click to re-enable';
    }
}

function loadPower() {
    chrome.storage.sync.get('extensionEnabled', (data) => {
        isEnabled = data.extensionEnabled !== false;
        paintPower();
    });
}

function normalizePriceAdjustmentPercent(value) {
    const number = Number(value);
    if (!Number.isFinite(number)) return 0;
    return Math.min(Math.max(number, -100), 500);
}

function formatPriceAdjustmentPercent(percent) {
    const rounded = Math.round(percent * 10) / 10;
    const text = Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
    return `${rounded > 0 ? '+' : ''}${text}%`;
}

function paintPriceSimulationStatus(settings) {
    if (!priceSimulationStatusEl) return;
    const enabled = Boolean(settings && settings.priceAdjustmentEnabled);
    priceSimulationStatusEl.classList.toggle('hidden', !enabled);
    if (!enabled) return;
    const percent = normalizePriceAdjustmentPercent(settings.priceAdjustmentPercent);
    priceSimulationStatusEl.textContent = `Price simulation ON: ${formatPriceAdjustmentPercent(percent)} shown on product prices.`;
}

function loadPriceSimulationStatus() {
    chrome.storage.sync.get(null, (data) => {
        const settings = (typeof lesMergeSettings === 'function')
            ? lesMergeSettings(data)
            : (data || {});
        paintPriceSimulationStatus(settings);
    });
}

powerBtn.addEventListener('click', () => {
    isEnabled = !isEnabled;
    paintPower();
    chrome.storage.sync.set({ extensionEnabled: isEnabled });
});

openSettingsBtn.addEventListener('click', () => {
    if (chrome.runtime.openOptionsPage) {
        chrome.runtime.openOptionsPage();
    } else {
        chrome.tabs.create({ url: chrome.runtime.getURL('options.html') });
    }
});

function showShareToast(text, tone) {
    if (!shareToastEl) return;
    shareToastEl.textContent = text;
    shareToastEl.classList.toggle('error', tone === 'error');
    shareToastEl.classList.remove('hidden');
    window.clearTimeout(shareToastTimer);
    shareToastTimer = window.setTimeout(() => {
        shareToastEl.classList.add('hidden');
    }, 3600);
}

async function copyShareLinkToClipboard() {
    if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(EDGE_ADDON_URL);
        return;
    }

    const textArea = document.createElement('textarea');
    textArea.value = EDGE_ADDON_URL;
    textArea.setAttribute('readonly', '');
    textArea.style.position = 'fixed';
    textArea.style.top = '-1000px';
    document.body.appendChild(textArea);
    textArea.select();
    const copied = document.execCommand('copy');
    textArea.remove();
    if (!copied) throw new Error('copy_failed');
}

if (shareAddonBtn) {
    shareAddonBtn.addEventListener('click', async () => {
        shareAddonBtn.disabled = true;
        try {
            await copyShareLinkToClipboard();
            showShareToast('Link to add-on copied to clipboard. Please share it with a colleague :)');
        } catch (error) {
            showShareToast('Could not copy the add-on link automatically.', 'error');
        } finally {
            shareAddonBtn.disabled = false;
        }
    });
}

// --- SharePoint entitlement ---
function setEntitlementStatus(text, tone) {
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
                    status: 'error', entitled: false,
                    error: chrome.runtime.lastError.message,
                    checkedAt: Date.now()
                });
                return;
            }
            resolve(response || { status: 'error', entitled: false, error: 'empty_response', checkedAt: Date.now() });
        });
    });
}

function persistEntitlementResult(result) {
    return new Promise((resolve) => {
        if (!chrome.storage || !chrome.storage.local) { resolve(); return; }
        const shouldCache = result && (
            result.status === 'entitled' ||
            result.status === 'login_required' ||
            result.status === 'no_access'
        );
        if (shouldCache) {
            chrome.storage.local.set({ [ENTITLEMENT_CACHE_KEY]: result }, () => resolve());
        } else if (result && result.status === 'error') {
            resolve();
        } else {
            chrome.storage.local.remove(ENTITLEMENT_CACHE_KEY, () => resolve());
        }
    });
}

function withActiveTab(callback) {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        callback(tabs && tabs.length ? tabs[0] : null);
    });
}

function notifyActiveTabRefresh() {
    return new Promise((resolve) => {
        withActiveTab((tab) => {
            if (!tab || !tab.id) { resolve(); return; }
            chrome.tabs.sendMessage(tab.id, { action: 'lesRefreshEntitlement' }, () => resolve());
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
    recheckEntitlementBtn.textContent = 'Re-check';
}

// --- Lekolar host permission warning (kept from old popup) ---
function getLekolarPatternForUrl(url) {
    if (!url) return null;
    try {
        const host = new URL(url).hostname.toLowerCase();
        for (const rule of LEKOLAR_HOST_RULES) {
            const bare = rule.suffix.replace(/^\./, '');
            if (host === bare || host.endsWith(rule.suffix)) return rule.pattern;
        }
    } catch (e) { return null; }
    return null;
}

function updatePermissionWarning(hasAccess) {
    if (!permissionWarningEl) return;
    permissionWarningEl.classList.toggle('hidden', hasAccess);
}

function checkLekolarPermissions() {
    if (!chrome.permissions || !chrome.permissions.contains) {
        updatePermissionWarning(true);
        return;
    }
    withActiveTab((tab) => {
        const originPattern = getLekolarPatternForUrl(tab && tab.url ? tab.url : '');
        if (!originPattern) { updatePermissionWarning(true); return; }
        chrome.permissions.contains({ origins: [originPattern] }, (hasAccess) => {
            if (chrome.runtime.lastError) { updatePermissionWarning(true); return; }
            updatePermissionWarning(Boolean(hasAccess));
        });
    });
}

// Init
document.getElementById('versionLabel').textContent = 'v' + chrome.runtime.getManifest().version;
loadPower();
loadPriceSimulationStatus();
checkLekolarPermissions();
loadCachedEntitlementStatus();
if (recheckEntitlementBtn) {
    recheckEntitlementBtn.addEventListener('click', recheckEntitlementNow);
}

chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync') return;
    if (
        changes.priceAdjustmentEnabled ||
        changes.priceAdjustmentPercent ||
        changes.priceAdjustmentHighlightColor
    ) {
        loadPriceSimulationStatus();
    }
});
