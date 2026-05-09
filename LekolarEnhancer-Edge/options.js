// options.js — Full settings page. Tab navigation, settings load/save,
// copy-format builder, AI key vault wiring, import/export, reset, and
// changelog/README rendering.

const ENTITLEMENT_CACHE_KEY = 'lesSharePointEntitlement';
const SHAREPOINT_PROBE_URL = 'https://lekolarab.sharepoint.com/_api/web/currentuser?$select=Id,Title';
const AI_HISTORY_KEY = 'lesAiQueryHistory';
const AI_PROVIDERS = ['openai', 'anthropic', 'gemini'];

let lesSettings = lesMergeSettings(null);

// =====================================================================
// Tab navigation
// =====================================================================
function lesActivateTab(name) {
    if (!name) name = 'general';
    document.querySelectorAll('.nav-item').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.tab === name);
    });
    document.querySelectorAll('.tab-panel').forEach(panel => {
        panel.classList.toggle('active', panel.dataset.tabPanel === name);
    });
    if (location.hash !== '#' + name) {
        history.replaceState(null, '', '#' + name);
    }
    if (name === 'whatsnew') {
        chrome.storage.sync.set({ lastSeenVersion: chrome.runtime.getManifest().version });
        document.getElementById('navWhatsNewDot').classList.add('hidden');
    }
}

function lesWireTabs() {
    document.querySelectorAll('.nav-item').forEach(btn => {
        btn.addEventListener('click', () => lesActivateTab(btn.dataset.tab));
    });
    const initial = (location.hash || '').replace('#', '') || 'general';
    lesActivateTab(initial);
}

// =====================================================================
// Save indicator
// =====================================================================
function lesShowSaveIndicator() {
    const el = document.getElementById('saveIndicator');
    if (!el) return;
    el.classList.add('visible');
    clearTimeout(lesShowSaveIndicator._t);
    lesShowSaveIndicator._t = setTimeout(() => el.classList.remove('visible'), 1500);
}

// =====================================================================
// Storage helpers
// =====================================================================
function lesStorageSet(patch) {
    return new Promise(r => chrome.storage.sync.set(patch, () => {
        lesShowSaveIndicator();
        r();
    }));
}

function lesStorageGet(keyOrNull) {
    return new Promise(r => chrome.storage.sync.get(keyOrNull, r));
}

// =====================================================================
// General tab — feature toggles, per-country grid, master switch, beta
// =====================================================================
function lesPaintGeneral() {
    document.getElementById('masterEnabled').checked = lesSettings.extensionEnabled !== false;
    document.getElementById('infiniteScroll').checked = !!lesSettings.infiniteScroll;
    document.getElementById('copyButtons').checked = !!lesSettings.copyButtons;
    document.getElementById('hideEnvironmentalLogo').checked = !!lesSettings.hideEnvironmentalLogo;
    document.getElementById('aiBetaEnabled').checked = !!lesSettings.aiBetaEnabled;
    document.body.classList.toggle('beta-on', !!lesSettings.aiBetaEnabled);
    document.querySelectorAll('[data-enabled-country]').forEach(cb => {
        const code = cb.dataset.enabledCountry;
        cb.checked = lesSettings.enabledCountries[code] !== false;
    });
    document.getElementById('debugLogging').checked = !!lesSettings.debugLogging;
}

function lesWireGeneral() {
    const wireToggle = (id, key) => {
        const el = document.getElementById(id);
        el.addEventListener('change', () => {
            lesSettings[key] = el.checked;
            lesStorageSet({ [key]: el.checked });
        });
    };
    wireToggle('masterEnabled', 'extensionEnabled');
    wireToggle('infiniteScroll', 'infiniteScroll');
    wireToggle('copyButtons', 'copyButtons');
    wireToggle('hideEnvironmentalLogo', 'hideEnvironmentalLogo');
    wireToggle('debugLogging', 'debugLogging');

    document.getElementById('aiBetaEnabled').addEventListener('change', (e) => {
        lesSettings.aiBetaEnabled = e.target.checked;
        document.body.classList.toggle('beta-on', e.target.checked);
        lesStorageSet({ aiBetaEnabled: e.target.checked });
    });

    document.querySelectorAll('[data-enabled-country]').forEach(cb => {
        cb.addEventListener('change', () => {
            const code = cb.dataset.enabledCountry;
            lesSettings.enabledCountries[code] = cb.checked;
            lesStorageSet({ enabledCountries: lesSettings.enabledCountries });
        });
    });
}

// =====================================================================
// Copy-format builder
// =====================================================================
const FORMAT_SLOTS = ['default', 'primary', 'secondary'];

function lesPaintFormatHints() {
    const labels = { shiftKey: 'Shift', altKey: 'Alt', ctrlKey: 'Ctrl', none: '—' };
    document.getElementById('primarySlotHint').textContent =
        '(' + (labels[lesSettings.modifierKey] || lesSettings.modifierKey) + ' + click)';
    document.getElementById('secondarySlotHint').textContent =
        '(' + (labels[lesSettings.secondaryModifierKey] || lesSettings.secondaryModifierKey) + ' + click)';
}

function lesPaintAllFormats() {
    document.getElementById('modifierKey').value = lesSettings.modifierKey;
    document.getElementById('secondaryModifierKey').value = lesSettings.secondaryModifierKey;
    lesPaintFormatHints();
    FORMAT_SLOTS.forEach(slot => lesPaintFormat(slot));
}

function lesGetSlotCard(slot) {
    return document.querySelector(`.format-card[data-format-slot="${slot}"]`);
}

function lesPaintFormat(slot) {
    const card = lesGetSlotCard(slot);
    if (!card) return;
    const fmt = lesSettings.copyFormats[slot] || LES_DEFAULT_FORMATS[slot];
    card.querySelector('[data-format-label]').value = fmt.label || '';
    card.querySelector('[data-format-aslink]').checked = !!fmt.asLink;
    lesRenderTokens(card, fmt);
    lesRenderPreview(card, fmt);
}

function lesPersistFormat(slot) {
    return lesStorageSet({ copyFormats: lesSettings.copyFormats });
}

function lesRenderTokens(card, fmt) {
    const wrap = card.querySelector('[data-format-tokens]');
    wrap.innerHTML = '';
    wrap.classList.toggle('empty', !fmt.tokens.length);
    fmt.tokens.forEach((token, idx) => {
        const chip = document.createElement('span');
        chip.className = 'token-chip ' + (token.type === 'literal' ? 'literal' : token.type + '-token');
        chip.draggable = true;
        chip.dataset.idx = String(idx);

        if (token.type === 'literal') {
            const inp = document.createElement('input');
            inp.type = 'text';
            inp.className = 'token-edit';
            inp.value = token.value || '';
            inp.size = Math.max(token.value ? token.value.length : 1, 2);
            inp.addEventListener('input', (e) => {
                token.value = e.target.value;
                inp.size = Math.max(inp.value.length, 2);
                lesRenderPreview(card, fmt);
                lesPersistFormat(card.dataset.formatSlot);
            });
            inp.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') { e.preventDefault(); inp.blur(); }
            });
            chip.appendChild(inp);
        } else {
            const txt = document.createElement('span');
            txt.className = 'token-chip-text';
            txt.textContent = '{' + token.type + '}';
            chip.appendChild(txt);
        }

        const x = document.createElement('button');
        x.type = 'button';
        x.className = 'token-x';
        x.textContent = '×';
        x.title = 'Remove';
        x.addEventListener('click', (e) => {
            e.preventDefault();
            fmt.tokens.splice(idx, 1);
            lesRenderTokens(card, fmt);
            lesRenderPreview(card, fmt);
            lesPersistFormat(card.dataset.formatSlot);
        });
        chip.appendChild(x);

        // Drag-to-reorder
        chip.addEventListener('dragstart', (e) => {
            chip.classList.add('dragging');
            e.dataTransfer.effectAllowed = 'move';
            e.dataTransfer.setData('text/plain', String(idx));
        });
        chip.addEventListener('dragend', () => {
            chip.classList.remove('dragging');
            wrap.querySelectorAll('.token-chip').forEach(c => c.classList.remove('drop-before', 'drop-after'));
        });
        chip.addEventListener('dragover', (e) => {
            e.preventDefault();
            const rect = chip.getBoundingClientRect();
            const before = (e.clientX - rect.left) < rect.width / 2;
            wrap.querySelectorAll('.token-chip').forEach(c => c.classList.remove('drop-before', 'drop-after'));
            chip.classList.add(before ? 'drop-before' : 'drop-after');
        });
        chip.addEventListener('drop', (e) => {
            e.preventDefault();
            const fromIdx = parseInt(e.dataTransfer.getData('text/plain'), 10);
            if (Number.isNaN(fromIdx) || fromIdx === idx) return;
            const rect = chip.getBoundingClientRect();
            const before = (e.clientX - rect.left) < rect.width / 2;
            const moved = fmt.tokens.splice(fromIdx, 1)[0];
            let target = idx;
            if (fromIdx < idx) target -= 1;
            if (!before) target += 1;
            fmt.tokens.splice(target, 0, moved);
            lesRenderTokens(card, fmt);
            lesRenderPreview(card, fmt);
            lesPersistFormat(card.dataset.formatSlot);
        });

        wrap.appendChild(chip);
    });
}

function lesSampleContext(slot) {
    return { number: '12345', name: 'Pöytä Aktiivi 80x60', url: 'https://www.lekolar.fi/p/12345', value: '12345' };
}

function lesRenderPreview(card, fmt) {
    const slot = card.dataset.formatSlot;
    const ctx = lesSampleContext(slot);
    const txt = lesRenderCopyFormat(fmt, ctx);
    const out = card.querySelector('[data-format-preview]');
    if (fmt.asLink && ctx.url) {
        out.innerHTML = `<a href="${lesEscapeHtmlForCopy(ctx.url)}" target="_blank" rel="noopener">${lesEscapeHtmlForCopy(txt || '(empty)')}</a>`;
    } else {
        out.textContent = txt || '(empty)';
    }
}

function lesWireFormatBuilder() {
    document.getElementById('modifierKey').addEventListener('change', (e) => {
        lesSettings.modifierKey = e.target.value;
        lesPaintFormatHints();
        lesStorageSet({ modifierKey: e.target.value });
    });
    document.getElementById('secondaryModifierKey').addEventListener('change', (e) => {
        lesSettings.secondaryModifierKey = e.target.value;
        lesPaintFormatHints();
        lesStorageSet({ secondaryModifierKey: e.target.value });
    });

    FORMAT_SLOTS.forEach(slot => {
        const card = lesGetSlotCard(slot);
        if (!card) return;

        card.querySelector('[data-format-label]').addEventListener('input', (e) => {
            lesSettings.copyFormats[slot].label = e.target.value;
            lesPersistFormat(slot);
        });
        card.querySelector('[data-format-aslink]').addEventListener('change', (e) => {
            lesSettings.copyFormats[slot].asLink = e.target.checked;
            lesRenderPreview(card, lesSettings.copyFormats[slot]);
            lesPersistFormat(slot);
        });
        card.querySelectorAll('[data-add-token]').forEach(btn => {
            btn.addEventListener('click', () => {
                lesSettings.copyFormats[slot].tokens.push({ type: btn.dataset.addToken });
                lesRenderTokens(card, lesSettings.copyFormats[slot]);
                lesRenderPreview(card, lesSettings.copyFormats[slot]);
                lesPersistFormat(slot);
            });
        });
        card.querySelector('[data-add-literal]').addEventListener('click', () => {
            const val = window.prompt('Insert text (use \\n for newline, \\t for tab):', ' ');
            if (val == null) return;
            const decoded = val.replace(/\\n/g, '\n').replace(/\\t/g, '\t');
            lesSettings.copyFormats[slot].tokens.push({ type: 'literal', value: decoded });
            lesRenderTokens(card, lesSettings.copyFormats[slot]);
            lesRenderPreview(card, lesSettings.copyFormats[slot]);
            lesPersistFormat(slot);
        });
    });

    document.getElementById('resetFormatsBtn').addEventListener('click', () => {
        if (!confirm('Reset all three copy formats to defaults?')) return;
        lesSettings.copyFormats = JSON.parse(JSON.stringify(LES_DEFAULT_FORMATS));
        lesPaintAllFormats();
        lesStorageSet({ copyFormats: lesSettings.copyFormats });
    });
}

// =====================================================================
// Omnibox tab
// =====================================================================
function lesPaintOmnibox() {
    LES_COUNTRY_CODES.forEach(code => {
        const radio = document.getElementById(`country-${code}`);
        const url = document.getElementById(`url-${code}`);
        const c = lesSettings.countries[code] || LES_DEFAULT_SETTINGS.countries[code];
        if (radio) radio.checked = !!c.enabled;
        if (url) url.value = c.url || '';
    });
}

function lesPersistOmnibox() {
    const out = {};
    LES_COUNTRY_CODES.forEach(code => {
        const radio = document.getElementById(`country-${code}`);
        const url = document.getElementById(`url-${code}`);
        out[code] = {
            enabled: !!(radio && radio.checked),
            url: (url && url.value.trim()) || LES_DEFAULT_SETTINGS.countries[code].url
        };
    });
    lesSettings.countries = out;
    lesStorageSet({ countries: out });
}

function lesWireOmnibox() {
    LES_COUNTRY_CODES.forEach(code => {
        const radio = document.getElementById(`country-${code}`);
        const url = document.getElementById(`url-${code}`);
        if (radio) radio.addEventListener('change', lesPersistOmnibox);
        if (url) {
            let timer;
            url.addEventListener('input', () => {
                clearTimeout(timer);
                timer = setTimeout(lesPersistOmnibox, 400);
            });
        }
    });
}

// =====================================================================
// SharePoint entitlement (also surfaced on General tab)
// =====================================================================
function setEntitlementStatus(text, tone) {
    const el = document.getElementById('entitlementStatus');
    if (!el) return;
    el.textContent = text;
    el.classList.remove('ok', 'warn', 'error');
    if (tone) el.classList.add(tone);
}

function renderEntitlementStatus(result) {
    if (!result || !result.status) { setEntitlementStatus('Status: Unknown', 'warn'); return; }
    if (result.status === 'entitled') setEntitlementStatus('Status: Enabled (SharePoint access detected)', 'ok');
    else if (result.status === 'login_required') setEntitlementStatus('Status: Sign in to SharePoint and re-check', 'warn');
    else if (result.status === 'no_access') setEntitlementStatus('Status: SharePoint access missing', 'warn');
    else {
        const details = result.error ? ` (${result.error})` : '';
        setEntitlementStatus(`Status: Could not verify now${details}`, 'error');
    }
}

function loadCachedEntitlementStatus() {
    chrome.storage.local.get(ENTITLEMENT_CACHE_KEY, (data) => {
        if (chrome.runtime.lastError) { setEntitlementStatus('Status: Could not read cache', 'error'); return; }
        renderEntitlementStatus(data[ENTITLEMENT_CACHE_KEY]);
    });
}

function lesWireEntitlement() {
    const btn = document.getElementById('recheckEntitlementBtn');
    if (!btn) return;
    btn.addEventListener('click', async () => {
        btn.disabled = true;
        btn.textContent = 'Checking…';
        setEntitlementStatus('Status: Checking SharePoint access...', 'warn');
        const result = await new Promise(r => {
            chrome.runtime.sendMessage({ action: 'probeSharePointEntitlement', probeUrl: SHAREPOINT_PROBE_URL }, (resp) => {
                if (chrome.runtime.lastError) {
                    r({ status: 'error', entitled: false, error: chrome.runtime.lastError.message, checkedAt: Date.now() });
                } else {
                    r(resp || { status: 'error', entitled: false, error: 'empty_response', checkedAt: Date.now() });
                }
            });
        });
        if (result.status !== 'error') {
            chrome.storage.local.set({ [ENTITLEMENT_CACHE_KEY]: result });
        }
        renderEntitlementStatus(result);
        btn.disabled = false;
        btn.textContent = 'Re-check SharePoint Access';
    });
}

// =====================================================================
// AI tab — provider, models, advanced, key vault, history
// =====================================================================
function lesPaintAi() {
    document.getElementById('aiProvider').value = lesSettings.aiProvider || 'openai';
    document.getElementById('aiTemperature').value = lesSettings.aiAdvanced.temperature;
    document.getElementById('aiMaxTokens').value = lesSettings.aiAdvanced.maxTokens;
    AI_PROVIDERS.forEach(p => {
        const block = document.querySelector(`.provider-block[data-provider="${p}"]`);
        if (!block) return;
        const modelInp = block.querySelector('[data-model-input]');
        if (modelInp) modelInp.value = (lesSettings.aiModels && lesSettings.aiModels[p]) || '';
        lesRefreshKeyMeta(p);
    });
    lesPaintAiHistory();
}

async function lesRefreshKeyMeta(provider) {
    const block = document.querySelector(`.provider-block[data-provider="${provider}"]`);
    if (!block) return;
    const meta = block.querySelector('[data-key-meta]');
    try {
        const info = await lesVaultGetKeyMeta(provider);
        if (info && info.present) {
            meta.textContent = `Key saved (…${info.last4}).`;
            meta.classList.add('present');
        } else {
            meta.textContent = 'No key saved.';
            meta.classList.remove('present');
        }
    } catch (e) {
        meta.textContent = 'No key saved.';
    }
}

function lesSetTestResult(provider, text, tone) {
    const block = document.querySelector(`.provider-block[data-provider="${provider}"]`);
    if (!block) return;
    const el = block.querySelector('[data-test-result]');
    el.textContent = text || '';
    el.classList.remove('ok', 'error');
    if (tone) el.classList.add(tone);
}

function lesWireAi() {
    document.getElementById('aiProvider').addEventListener('change', (e) => {
        lesSettings.aiProvider = e.target.value;
        lesStorageSet({ aiProvider: e.target.value });
    });

    document.getElementById('aiTemperature').addEventListener('change', (e) => {
        const v = parseFloat(e.target.value);
        if (!Number.isFinite(v)) return;
        lesSettings.aiAdvanced.temperature = v;
        lesStorageSet({ aiAdvanced: lesSettings.aiAdvanced });
    });
    document.getElementById('aiMaxTokens').addEventListener('change', (e) => {
        const v = parseInt(e.target.value, 10);
        if (!Number.isFinite(v)) return;
        lesSettings.aiAdvanced.maxTokens = v;
        lesStorageSet({ aiAdvanced: lesSettings.aiAdvanced });
    });

    AI_PROVIDERS.forEach(provider => {
        const block = document.querySelector(`.provider-block[data-provider="${provider}"]`);
        if (!block) return;

        const modelInp = block.querySelector('[data-model-input]');
        if (modelInp) {
            let timer;
            modelInp.addEventListener('input', () => {
                clearTimeout(timer);
                timer = setTimeout(() => {
                    lesSettings.aiModels[provider] = modelInp.value.trim();
                    lesStorageSet({ aiModels: lesSettings.aiModels });
                }, 400);
            });
        }

        block.querySelector('[data-save-btn]').addEventListener('click', async () => {
            const input = block.querySelector('[data-key-input]');
            const value = (input.value || '').trim();
            if (!value) { lesSetTestResult(provider, 'Paste a key first.', 'error'); return; }
            for (let i = 0; i < value.length; i++) {
                const code = value.charCodeAt(i);
                if (code < 0x20 || code > 0x7e) {
                    lesSetTestResult(provider, `Key contains non-ASCII char at position ${i} (code ${code}). Re-copy the key.`, 'error');
                    return;
                }
            }
            await lesVaultSetKey(provider, value);
            input.value = '';
            lesSetTestResult(provider, '', '');
            await lesRefreshKeyMeta(provider);
            lesShowSaveIndicator();
        });

        block.querySelector('[data-clear-btn]').addEventListener('click', async () => {
            await lesVaultSetKey(provider, '');
            lesSetTestResult(provider, '', '');
            await lesRefreshKeyMeta(provider);
            lesShowSaveIndicator();
        });

        block.querySelector('[data-test-btn]').addEventListener('click', async () => {
            const btn = block.querySelector('[data-test-btn]');
            const meta = await lesVaultGetKeyMeta(provider);
            if (!meta.present) { lesSetTestResult(provider, 'Save a key first.', 'error'); return; }
            btn.disabled = true;
            const orig = btn.textContent;
            btn.textContent = 'Testing…';
            lesSetTestResult(provider, 'Contacting provider…', '');
            const result = await new Promise(r => {
                chrome.runtime.sendMessage({ action: 'lesAiTestKey', provider }, resp => {
                    if (chrome.runtime.lastError) r({ ok: false, error: chrome.runtime.lastError.message });
                    else r(resp || { ok: false, error: 'empty_response' });
                });
            });
            if (result.ok) lesSetTestResult(provider, '✓ Key works.', 'ok');
            else lesSetTestResult(provider, `✗ ${result.error || 'Unknown error'}`, 'error');
            btn.disabled = false;
            btn.textContent = orig;
        });

        block.querySelector('[data-key-input]').addEventListener('keydown', (e) => {
            if (e.key === 'Enter') { e.preventDefault(); block.querySelector('[data-save-btn]').click(); }
        });
    });

    // AI search input
    const aiInput = document.getElementById('aiInput');
    const aiSendBtn = document.getElementById('aiSendBtn');
    const aiStatus = document.getElementById('aiStatus');
    const aiPreview = document.getElementById('aiPreview');
    const aiPreviewQuery = document.getElementById('aiPreviewQuery');
    const aiPreviewChips = document.getElementById('aiPreviewChips');
    const aiOpenBtn = document.getElementById('aiOpenBtn');
    const aiCancelBtn = document.getElementById('aiCancelBtn');
    let pendingUrl = '';

    function setStatus(text, tone) {
        aiStatus.textContent = text || '';
        aiStatus.classList.remove('ok', 'warn', 'error');
        if (tone) aiStatus.classList.add(tone);
    }
    function hidePreview() { pendingUrl = ''; aiPreview.classList.add('hidden'); }
    function showPreview(extracted, url) {
        pendingUrl = url || '';
        const cat = extracted.category && extracted.category !== '_default' ? ` [${extracted.category}]` : '';
        aiPreviewQuery.textContent = (extracted.query || '(no query)') + cat;
        aiPreviewChips.innerHTML = '';
        const entries = Object.entries(extracted.filters || {});
        if (!entries.length) {
            const c = document.createElement('span'); c.className = 'ai-chip'; c.textContent = 'no filters';
            aiPreviewChips.appendChild(c);
        } else {
            entries.forEach(([k, v]) => {
                const c = document.createElement('span'); c.className = 'ai-chip'; c.textContent = `${k}: ${v}`;
                aiPreviewChips.appendChild(c);
            });
        }
        aiPreview.classList.remove('hidden');
    }

    function send() {
        const text = (aiInput.value || '').trim();
        if (!text) return;
        const provider = document.getElementById('aiProvider').value;
        hidePreview();
        setStatus('Thinking…', 'warn');
        aiSendBtn.disabled = true;
        chrome.runtime.sendMessage({ action: 'lesAiSearch', provider, userText: text }, (resp) => {
            aiSendBtn.disabled = false;
            if (chrome.runtime.lastError) { setStatus(`Error: ${chrome.runtime.lastError.message}`, 'error'); return; }
            if (!resp || !resp.ok) {
                const err = (resp && resp.error) || 'unknown_error';
                if (err === 'missing_api_key') setStatus('No API key for this provider. Save one above.', 'error');
                else if (err === 'beta_disabled') setStatus('Beta features are off. Enable on the General tab.', 'error');
                else setStatus(`Error: ${err}`, 'error');
                return;
            }
            setStatus('Review and open:', 'ok');
            showPreview(resp.extracted, resp.url);
            lesPushAiHistory(text);
        });
    }

    aiSendBtn.addEventListener('click', send);
    aiInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); send(); }
    });
    aiOpenBtn.addEventListener('click', () => { if (pendingUrl) chrome.tabs.create({ url: pendingUrl }); });
    aiCancelBtn.addEventListener('click', () => { hidePreview(); setStatus('', ''); });
}

function lesPushAiHistory(text) {
    chrome.storage.local.get(AI_HISTORY_KEY, (data) => {
        const list = Array.isArray(data[AI_HISTORY_KEY]) ? data[AI_HISTORY_KEY].slice() : [];
        list.unshift({ text, ts: Date.now() });
        const trimmed = list.slice(0, 10);
        chrome.storage.local.set({ [AI_HISTORY_KEY]: trimmed }, lesPaintAiHistory);
    });
}

function lesPaintAiHistory() {
    const wrap = document.getElementById('aiHistory');
    if (!wrap) return;
    chrome.storage.local.get(AI_HISTORY_KEY, (data) => {
        const list = Array.isArray(data[AI_HISTORY_KEY]) ? data[AI_HISTORY_KEY] : [];
        if (!list.length) { wrap.innerHTML = ''; return; }
        wrap.innerHTML = '<div class="ai-history-title">Recent queries</div>';
        list.forEach(item => {
            const row = document.createElement('div');
            row.className = 'ai-history-item';
            const t = document.createElement('span');
            t.textContent = item.text;
            const dt = document.createElement('span');
            dt.className = 'history-time';
            dt.textContent = new Date(item.ts).toLocaleString();
            row.appendChild(t); row.appendChild(dt);
            row.addEventListener('click', () => {
                document.getElementById('aiInput').value = item.text;
                document.getElementById('aiInput').focus();
            });
            wrap.appendChild(row);
        });
    });
}

// =====================================================================
// Advanced tab — debug, export/import, reset
// =====================================================================
function lesWireAdvanced() {
    document.getElementById('exportSettingsBtn').addEventListener('click', async () => {
        const all = await lesStorageGet(null);
        const blob = new Blob([JSON.stringify(all, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        a.href = url;
        a.download = `lekolar-enhancer-settings-${stamp}.json`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    });

    const fileInput = document.getElementById('importSettingsFile');
    document.getElementById('importSettingsBtn').addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', async () => {
        const file = fileInput.files && fileInput.files[0];
        if (!file) return;
        const status = document.getElementById('importStatus');
        try {
            const text = await file.text();
            const parsed = JSON.parse(text);
            if (!parsed || typeof parsed !== 'object') throw new Error('not an object');
            const merged = lesMergeSettings(parsed);
            await lesStorageSet(merged);
            lesSettings = merged;
            lesPaintGeneral();
            lesPaintAllFormats();
            lesPaintOmnibox();
            lesPaintAi();
            status.textContent = 'Imported successfully.';
            status.classList.remove('error'); status.classList.add('ok');
        } catch (e) {
            status.textContent = `Import failed: ${e.message || e}`;
            status.classList.add('error');
        }
        fileInput.value = '';
    });

    document.getElementById('resetAllBtn').addEventListener('click', async () => {
        if (!confirm('Reset every setting (including copy formats and active countries) to defaults? API keys are not affected.')) return;
        await new Promise(r => chrome.storage.sync.clear(r));
        const fresh = lesMergeSettings(null);
        await lesStorageSet(fresh);
        lesSettings = fresh;
        lesPaintGeneral();
        lesPaintAllFormats();
        lesPaintOmnibox();
        lesPaintAi();
    });
}

// =====================================================================
// What's new / About
// =====================================================================
async function lesLoadChangelog() {
    const target = document.getElementById('changelogContent');
    try {
        const url = chrome.runtime.getURL('CHANGELOG.md');
        const text = await fetch(url).then(r => r.text());
        target.innerHTML = lesRenderChangelog(text);
    } catch (e) {
        target.textContent = `Could not load CHANGELOG.md: ${e.message || e}`;
    }
}

// Tiny markdown subset for the changelog: ## Heading, ### Heading,
// "_(yyyy-mm-dd)_" date suffix, "- bullet" lists, `inline code`.
function lesRenderChangelog(md) {
    const lines = md.split(/\r?\n/);
    const out = [];
    let inList = false;
    const flush = () => { if (inList) { out.push('</ul>'); inList = false; } };
    for (const raw of lines) {
        const line = raw.trimEnd();
        if (!line.trim()) { flush(); continue; }
        const h2 = line.match(/^##\s+(.+)$/);
        if (h2) {
            flush();
            const dateMatch = h2[1].match(/^(.+?)\s*[—-]\s*(\d{4}-\d{2}-\d{2})\s*$/);
            if (dateMatch) {
                out.push(`<h2>${lesEscapeHtml(dateMatch[1])}<span class="release-date">${lesEscapeHtml(dateMatch[2])}</span></h2>`);
            } else {
                out.push(`<h2>${lesEscapeHtml(h2[1])}</h2>`);
            }
            continue;
        }
        if (line.startsWith('# ')) {
            flush();
            out.push(`<h2>${lesEscapeHtml(line.slice(2))}</h2>`);
            continue;
        }
        if (/^\s*-\s+/.test(line)) {
            if (!inList) { out.push('<ul>'); inList = true; }
            const item = line.replace(/^\s*-\s+/, '');
            out.push(`<li>${lesInline(item)}</li>`);
            continue;
        }
        flush();
        out.push(`<p>${lesInline(line)}</p>`);
    }
    flush();
    return out.join('\n');
}

function lesInline(s) {
    return lesEscapeHtml(s).replace(/`([^`]+)`/g, '<code>$1</code>');
}

function lesEscapeHtml(s) {
    return String(s == null ? '' : s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

async function lesLoadReadme() {
    const target = document.getElementById('readmeContent');
    try {
        const url = chrome.runtime.getURL('README.md');
        const text = await fetch(url).then(r => r.text());
        target.textContent = text;
    } catch (e) {
        target.textContent = `Could not load README.md: ${e.message || e}`;
    }
}

function lesPaintWhatsNewDot() {
    const dot = document.getElementById('navWhatsNewDot');
    const current = chrome.runtime.getManifest().version;
    chrome.storage.sync.get('lastSeenVersion', (data) => {
        const seen = data && data.lastSeenVersion;
        dot.classList.toggle('hidden', seen === current);
    });
}

// =====================================================================
// Boot
// =====================================================================
async function lesBoot() {
    const stored = await lesStorageGet(null);
    lesSettings = lesMergeSettings(stored);

    document.getElementById('sidebarVersion').textContent = 'v' + chrome.runtime.getManifest().version;
    document.getElementById('aboutVersion').textContent = chrome.runtime.getManifest().version;

    lesWireTabs();
    lesPaintGeneral();
    lesWireGeneral();
    lesPaintAllFormats();
    lesWireFormatBuilder();
    lesPaintOmnibox();
    lesWireOmnibox();
    lesPaintAi();
    lesWireAi();
    lesWireAdvanced();
    lesWireEntitlement();
    loadCachedEntitlementStatus();
    lesLoadChangelog();
    lesLoadReadme();
    lesPaintWhatsNewDot();
}

document.addEventListener('DOMContentLoaded', lesBoot);

// React to changes coming from the popup (master switch flipped there).
chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync') return;
    if (changes.extensionEnabled) {
        lesSettings.extensionEnabled = changes.extensionEnabled.newValue !== false;
        const cb = document.getElementById('masterEnabled');
        if (cb) cb.checked = lesSettings.extensionEnabled;
    }
});
