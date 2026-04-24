// options.js — Encrypts API keys via cryptoVault, routes "Test key" through
// the background worker so keys never touch page context.

const LES_OPTIONS_PROVIDERS = ['openai', 'anthropic', 'gemini'];

function lesOptionsShowSaveIndicator() {
    const el = document.getElementById('saveIndicator');
    if (!el) return;
    el.classList.add('visible');
    clearTimeout(lesOptionsShowSaveIndicator._t);
    lesOptionsShowSaveIndicator._t = setTimeout(() => el.classList.remove('visible'), 1500);
}

function lesOptionsBlock(provider) {
    return document.querySelector(`.provider-block[data-provider="${provider}"]`);
}

async function lesOptionsRefreshMeta(provider) {
    const block = lesOptionsBlock(provider);
    if (!block) return;
    const metaEl = block.querySelector('[data-key-meta]');
    const meta = await lesVaultGetKeyMeta(provider);
    if (meta.present) {
        metaEl.textContent = `Key saved (…${meta.last4}).`;
        metaEl.classList.add('present');
    } else {
        metaEl.textContent = 'No key saved.';
        metaEl.classList.remove('present');
    }
}

function lesOptionsSetTestResult(provider, text, tone) {
    const block = lesOptionsBlock(provider);
    if (!block) return;
    const el = block.querySelector('[data-test-result]');
    el.textContent = text || '';
    el.classList.remove('ok', 'error');
    if (tone) el.classList.add(tone);
}

async function lesOptionsHandleSave(provider) {
    const block = lesOptionsBlock(provider);
    const input = block.querySelector('[data-key-input]');
    const value = (input.value || '').trim();
    if (!value) {
        lesOptionsSetTestResult(provider, 'Paste a key first.', 'error');
        return;
    }
    // API keys must be printable ASCII — any stray Unicode from paste will
    // crash the fetch later with an opaque error, so reject up front.
    for (let i = 0; i < value.length; i++) {
        const code = value.charCodeAt(i);
        if (code < 0x20 || code > 0x7e) {
            lesOptionsSetTestResult(
                provider,
                `Key contains non-ASCII character at position ${i} (code ${code}). Re-copy the key — your paste may have included a hidden character.`,
                'error'
            );
            return;
        }
    }
    await lesVaultSetKey(provider, value);
    input.value = '';
    lesOptionsSetTestResult(provider, '', '');
    await lesOptionsRefreshMeta(provider);
    lesOptionsShowSaveIndicator();
}

async function lesOptionsHandleClear(provider) {
    await lesVaultSetKey(provider, '');
    lesOptionsSetTestResult(provider, '', '');
    await lesOptionsRefreshMeta(provider);
    lesOptionsShowSaveIndicator();
}

function lesOptionsTestKeyViaBackground(provider) {
    return new Promise((resolve) => {
        chrome.runtime.sendMessage({ action: 'lesAiTestKey', provider }, (response) => {
            if (chrome.runtime.lastError) {
                resolve({ ok: false, error: chrome.runtime.lastError.message });
                return;
            }
            resolve(response || { ok: false, error: 'empty_response' });
        });
    });
}

async function lesOptionsHandleTest(provider) {
    const block = lesOptionsBlock(provider);
    const btn = block.querySelector('[data-test-btn]');
    const meta = await lesVaultGetKeyMeta(provider);
    if (!meta.present) {
        lesOptionsSetTestResult(provider, 'Save a key first.', 'error');
        return;
    }
    btn.disabled = true;
    const originalText = btn.textContent;
    btn.textContent = 'Testing…';
    lesOptionsSetTestResult(provider, 'Contacting provider…', '');

    const result = await lesOptionsTestKeyViaBackground(provider);
    if (result.ok) {
        lesOptionsSetTestResult(provider, '✓ Key works.', 'ok');
    } else {
        lesOptionsSetTestResult(provider, `✗ ${result.error || 'Unknown error'}`, 'error');
    }

    btn.disabled = false;
    btn.textContent = originalText;
}

function lesOptionsWire() {
    LES_OPTIONS_PROVIDERS.forEach(provider => {
        const block = lesOptionsBlock(provider);
        if (!block) return;
        block.querySelector('[data-save-btn]').addEventListener('click', () => lesOptionsHandleSave(provider));
        block.querySelector('[data-clear-btn]').addEventListener('click', () => lesOptionsHandleClear(provider));
        block.querySelector('[data-test-btn]').addEventListener('click', () => lesOptionsHandleTest(provider));
        const input = block.querySelector('[data-key-input]');
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                lesOptionsHandleSave(provider);
            }
        });
        lesOptionsRefreshMeta(provider);
    });
}

document.addEventListener('DOMContentLoaded', lesOptionsWire);
