// aiProviders.js — One function per provider. Each returns { query, filters }
// validated against PIM_TO_FACET_MAP. Runs only in the background worker so
// API keys never touch content scripts or page context.

const LES_AI_DEFAULT_MODELS = {
    openai: 'gpt-4o-mini',
    anthropic: 'claude-haiku-4-5-20251001',
    gemini: 'gemini-2.0-flash'
};

const LES_AI_ENDPOINTS = {
    openai: 'https://api.openai.com/v1/chat/completions',
    anthropic: 'https://api.anthropic.com/v1/messages',
    gemini: 'https://generativelanguage.googleapis.com/v1beta/models'
};

const LES_AI_REQUEST_TIMEOUT_MS = 15000;

function lesAiFetchWithTimeout(url, init, timeoutMs) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs || LES_AI_REQUEST_TIMEOUT_MS);
    return fetch(url, { ...init, signal: controller.signal })
        .finally(() => clearTimeout(timer));
}

function lesAiParseJsonStrict(text) {
    if (!text) throw new Error('empty_response');
    const trimmed = text.trim();
    try {
        return JSON.parse(trimmed);
    } catch (_) {
        // Some providers still wrap JSON in ```json fences; strip and retry.
        const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
        if (fenced) {
            return JSON.parse(fenced[1].trim());
        }
        const firstBrace = trimmed.indexOf('{');
        const lastBrace = trimmed.lastIndexOf('}');
        if (firstBrace >= 0 && lastBrace > firstBrace) {
            return JSON.parse(trimmed.slice(firstBrace, lastBrace + 1));
        }
        throw new Error('not_json');
    }
}

async function lesAiCallOpenAI({ userText, systemPrompt, apiKey, model }) {
    const response = await lesAiFetchWithTimeout(LES_AI_ENDPOINTS.openai, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`
        },
        body: JSON.stringify({
            model: model || LES_AI_DEFAULT_MODELS.openai,
            temperature: 0,
            response_format: { type: 'json_object' },
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: userText }
            ]
        })
    });

    if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw new Error(`openai_http_${response.status}:${body.slice(0, 200)}`);
    }
    const payload = await response.json();
    const content = payload && payload.choices && payload.choices[0]
        && payload.choices[0].message && payload.choices[0].message.content;
    return lesAiParseJsonStrict(content || '');
}

async function lesAiCallAnthropic({ userText, systemPrompt, apiKey, model }) {
    const response = await lesAiFetchWithTimeout(LES_AI_ENDPOINTS.anthropic, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01',
            'anthropic-dangerous-direct-browser-access': 'true'
        },
        body: JSON.stringify({
            model: model || LES_AI_DEFAULT_MODELS.anthropic,
            max_tokens: 512,
            temperature: 0,
            system: systemPrompt,
            messages: [{ role: 'user', content: userText }]
        })
    });

    if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw new Error(`anthropic_http_${response.status}:${body.slice(0, 200)}`);
    }
    const payload = await response.json();
    const block = payload && Array.isArray(payload.content)
        ? payload.content.find(b => b && b.type === 'text')
        : null;
    return lesAiParseJsonStrict(block ? block.text : '');
}

async function lesAiCallGemini({ userText, systemPrompt, apiKey, model }) {
    const chosen = model || LES_AI_DEFAULT_MODELS.gemini;
    const url = `${LES_AI_ENDPOINTS.gemini}/${encodeURIComponent(chosen)}:generateContent?key=${encodeURIComponent(apiKey)}`;
    const response = await lesAiFetchWithTimeout(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            systemInstruction: { parts: [{ text: systemPrompt }] },
            contents: [{ role: 'user', parts: [{ text: userText }] }],
            generationConfig: {
                temperature: 0,
                responseMimeType: 'application/json'
            }
        })
    });

    if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw new Error(`gemini_http_${response.status}:${body.slice(0, 200)}`);
    }
    const payload = await response.json();
    const text = payload && payload.candidates && payload.candidates[0]
        && payload.candidates[0].content && Array.isArray(payload.candidates[0].content.parts)
        ? payload.candidates[0].content.parts.map(p => p.text || '').join('')
        : '';
    return lesAiParseJsonStrict(text);
}

const LES_AI_PROVIDER_DISPATCH = {
    openai: lesAiCallOpenAI,
    anthropic: lesAiCallAnthropic,
    gemini: lesAiCallGemini
};

function lesAiAssertAsciiApiKey(apiKey) {
    for (let i = 0; i < apiKey.length; i++) {
        const code = apiKey.charCodeAt(i);
        if (code < 0x20 || code > 0x7e) {
            throw new Error(`invalid_api_key_char_at_${i}_code_${code}`);
        }
    }
}

async function lesAiExtractFacets({ provider, userText, systemPrompt, apiKey, model }) {
    const fn = LES_AI_PROVIDER_DISPATCH[provider];
    if (!fn) throw new Error(`unknown_provider:${provider}`);
    if (!apiKey) throw new Error('missing_api_key');
    if (!userText || !userText.trim()) throw new Error('empty_user_text');
    lesAiAssertAsciiApiKey(apiKey);
    return fn({ userText, systemPrompt, apiKey, model });
}

// A tiny ping used by the "Test key" button on the options page. Sends 1 token's
// worth of prompt and only checks that auth succeeded — we don't care about the
// response content.
async function lesAiTestKey({ provider, apiKey, model }) {
    try {
        const userText = 'Return JSON {"ok":true}';
        const systemPrompt = 'Reply with valid JSON only.';
        if (provider === 'openai') {
            await lesAiCallOpenAI({ userText, systemPrompt, apiKey, model });
        } else if (provider === 'anthropic') {
            await lesAiCallAnthropic({ userText, systemPrompt, apiKey, model });
        } else if (provider === 'gemini') {
            await lesAiCallGemini({ userText, systemPrompt, apiKey, model });
        } else {
            return { ok: false, error: `unknown_provider:${provider}` };
        }
        return { ok: true };
    } catch (e) {
        // JSON-parse errors are fine here — auth succeeded, the model just
        // didn't return JSON for a trivial prompt. Only HTTP errors count.
        const msg = (e && e.message) ? e.message : String(e);
        if (/_http_/.test(msg)) return { ok: false, error: msg };
        return { ok: true };
    }
}

const LES_AI_PROVIDERS_API = {
    lesAiExtractFacets,
    lesAiTestKey,
    LES_AI_DEFAULT_MODELS
};

const LES_AI_PROVIDERS_GLOBAL =
    typeof globalThis !== 'undefined'
        ? globalThis
        : (typeof self !== 'undefined' ? self : (typeof window !== 'undefined' ? window : null));

if (typeof module !== 'undefined' && module.exports) {
    module.exports = LES_AI_PROVIDERS_API;
} else if (LES_AI_PROVIDERS_GLOBAL) {
    Object.assign(LES_AI_PROVIDERS_GLOBAL, LES_AI_PROVIDERS_API);
}
