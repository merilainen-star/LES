#!/usr/bin/env node
// tools/legacy-discovery.js
// Implements the 3-step "Legacy Discovery" workflow:
//   Step 1 — Ingest: bundle key source files into an AI-readable context
//   Step 2 — Interview: run a "Forensic PM" interview (10 questions/round)
//   Step 3 — Synthesise: generate "unthought-of" improvement ideas from the interview
//
// Usage:
//   OPENAI_API_KEY=sk-...      node tools/legacy-discovery.js
//   ANTHROPIC_API_KEY=sk-ant-... node tools/legacy-discovery.js --provider anthropic
//   GEMINI_API_KEY=...          node tools/legacy-discovery.js --provider gemini
//
//   --rounds N   Number of interview rounds before synthesis (default: 1)
//
// Requires Node 18+ (built-in fetch). No npm dependencies.

'use strict';

const fs       = require('fs');
const path     = require('path');
const readline = require('readline');

// ── Provider config ────────────────────────────────────────────────────────────

const PROVIDERS = {
    openai:    {
        envKey:   'OPENAI_API_KEY',
        model:    'gpt-4o-mini',
        endpoint: 'https://api.openai.com/v1/chat/completions',
    },
    anthropic: {
        envKey:   'ANTHROPIC_API_KEY',
        model:    'claude-haiku-4-5-20251001',
        endpoint: 'https://api.anthropic.com/v1/messages',
    },
    gemini:    {
        envKey:   'GEMINI_API_KEY',
        model:    'gemini-2.0-flash',
        endpoint: 'https://generativelanguage.googleapis.com/v1beta/models',
    },
};

const ROOT        = path.resolve(__dirname, '..');
const REPORT_PATH = path.join(__dirname, 'legacy-discovery-report.md');
const AI_TIMEOUT  = 90_000;

// ── CLI ────────────────────────────────────────────────────────────────────────

function parseArgs() {
    const argv = process.argv.slice(2);
    let provider = 'openai';
    let rounds   = 1;
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === '--provider' && argv[i + 1]) provider = argv[++i];
        if (argv[i] === '--rounds'   && argv[i + 1]) rounds   = Math.max(1, parseInt(argv[++i], 10) || 1);
    }
    return { provider, rounds };
}

// ── File helpers ───────────────────────────────────────────────────────────────

function readExcerpt(relPath, maxLines) {
    try {
        const lines = fs.readFileSync(path.join(ROOT, relPath), 'utf8').split('\n');
        return { text: lines.slice(0, maxLines).join('\n'), total: lines.length, truncated: lines.length > maxLines };
    } catch { return null; }
}

function lineCount(relPath) {
    try { return fs.readFileSync(path.join(ROOT, relPath), 'utf8').split('\n').length; }
    catch { return 0; }
}

// ── Context bundle (Step 1) ────────────────────────────────────────────────────

function buildContext() {
    const parts = [];

    // Manifest — always small, include fully
    const manifest = readExcerpt('LekolarEnhancer/manifest.json', 9999);
    if (manifest) parts.push(`## manifest.json\n\`\`\`json\n${manifest.text}\n\`\`\``);

    // README
    const readme = readExcerpt('LekolarEnhancer/README.md', 120);
    if (readme) {
        const tag = readme.truncated ? ' (first 120 lines)' : '';
        parts.push(`## README.md${tag}\n${readme.text}`);
    }

    // File inventory — gives the AI a sense of scope without large dumps
    const INVENTORY_FILES = [
        'LekolarEnhancer/content.js',
        'LekolarEnhancer/background.js',
        'LekolarEnhancer/popup.js',
        'LekolarEnhancer/options.js',
        'LekolarEnhancer/aiProviders.js',
        'LekolarEnhancer/aiPrompt.js',
        'LekolarEnhancer/facetVocabulary.js',
        'LekolarEnhancer/categoryClassifier.js',
        'LekolarEnhancer/cryptoVault.js',
        'LekolarEnhancer/searchUtils.js',
        'tools/scrape-facets.js',
    ];
    const inv = INVENTORY_FILES.map(f => `  ${f} (${lineCount(f)} lines)`).join('\n');
    parts.push(`## Source File Inventory\n${inv}`);

    // Key source excerpts — enough for the AI to reason about architecture
    const EXCERPTS = [
        ['LekolarEnhancer/content.js',          120],
        ['LekolarEnhancer/background.js',        120],
        ['LekolarEnhancer/popup.js',              80],
        ['LekolarEnhancer/aiProviders.js',       999],  // 196 lines, include fully
        ['LekolarEnhancer/categoryClassifier.js',999],  // 86 lines, include fully
        ['LekolarEnhancer/searchUtils.js',       999],  // 107 lines, include fully
        ['LekolarEnhancer/cryptoVault.js',       999],  // 146 lines, include fully
    ];
    for (const [relPath, max] of EXCERPTS) {
        const e = readExcerpt(relPath, max);
        if (!e) continue;
        const hdr = e.truncated
            ? `## ${relPath} (first ${max} of ${e.total} lines)`
            : `## ${relPath}`;
        parts.push(`${hdr}\n\`\`\`javascript\n${e.text}\n\`\`\``);
    }

    return parts.join('\n\n');
}

// ── AI call layer ──────────────────────────────────────────────────────────────

async function timedFetch(url, init) {
    const ctrl  = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), AI_TIMEOUT);
    try {
        return await fetch(url, { ...init, signal: ctrl.signal });
    } finally {
        clearTimeout(timer);
    }
}

async function callOpenAI(messages, apiKey, model, endpoint) {
    const res = await timedFetch(endpoint, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
        body:    JSON.stringify({ model, temperature: 0.7, messages }),
    });
    if (!res.ok) throw new Error(`openai_http_${res.status}: ${(await res.text()).slice(0, 300)}`);
    return (await res.json()).choices[0].message.content;
}

async function callAnthropic(messages, apiKey, model, endpoint) {
    const system = messages.find(m => m.role === 'system');
    const chat   = messages.filter(m => m.role !== 'system');
    const res = await timedFetch(endpoint, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
        body:    JSON.stringify({ model, max_tokens: 2048, temperature: 0.7, system: system?.content, messages: chat }),
    });
    if (!res.ok) throw new Error(`anthropic_http_${res.status}: ${(await res.text()).slice(0, 300)}`);
    const data = await res.json();
    return data.content?.find(b => b.type === 'text')?.text ?? '';
}

async function callGemini(messages, apiKey, model, endpoint) {
    const url    = `${endpoint}/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
    const system = messages.find(m => m.role === 'system');
    const chat   = messages
        .filter(m => m.role !== 'system')
        .map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] }));
    const res = await timedFetch(url, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
            systemInstruction: system ? { parts: [{ text: system.content }] } : undefined,
            contents:          chat,
            generationConfig:  { temperature: 0.7, maxOutputTokens: 2048 },
        }),
    });
    if (!res.ok) throw new Error(`gemini_http_${res.status}: ${(await res.text()).slice(0, 300)}`);
    const data = await res.json();
    return data.candidates?.[0]?.content?.parts?.map(p => p.text ?? '').join('') ?? '';
}

async function callAI(messages, provider, apiKey) {
    const { model, endpoint } = PROVIDERS[provider];
    if (provider === 'openai')    return callOpenAI(messages,    apiKey, model, endpoint);
    if (provider === 'anthropic') return callAnthropic(messages, apiKey, model, endpoint);
    if (provider === 'gemini')    return callGemini(messages,    apiKey, model, endpoint);
    throw new Error(`Unknown provider: ${provider}`);
}

// ── Readline helpers ───────────────────────────────────────────────────────────

function question(rl, q) {
    return new Promise(resolve => rl.question(q, resolve));
}

// Collect multi-line input until the user types "---" alone on a line.
function readBlock(rl, label) {
    console.log(`\n${label}`);
    console.log('(When finished, type --- on its own line and press Enter)\n');
    const lines = [];
    return new Promise(resolve => {
        function onLine(line) {
            if (line.trim() === '---') {
                rl.removeListener('line', onLine);
                resolve(lines.join('\n').trim());
            } else {
                lines.push(line);
            }
        }
        rl.on('line', onLine);
    });
}

// ── Main ───────────────────────────────────────────────────────────────────────

async function main() {
    const { provider, rounds } = parseArgs();
    const cfg = PROVIDERS[provider];
    if (!cfg) {
        process.stderr.write(`Unknown provider "${provider}". Choose: openai, anthropic, gemini\n`);
        process.exit(1);
    }
    const apiKey = process.env[cfg.envKey];
    if (!apiKey) {
        process.stderr.write(`Set ${cfg.envKey} before running.\n`);
        process.exit(1);
    }

    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

    console.log('\n═══════════════════════════════════════════════════════');
    console.log(' LES Legacy Discovery Workflow');
    console.log(` Provider: ${provider}   Model: ${cfg.model}`);
    console.log('═══════════════════════════════════════════════════════\n');

    // ── Step 1: Ingest ─────────────────────────────────────────────────────────

    process.stderr.write('[1/3] Reading codebase…\n');
    const context = buildContext();
    console.log('Codebase ingested. Starting Forensic PM interview.\n');

    // ── Step 2: Interview ──────────────────────────────────────────────────────

    const SYSTEM = [
        'You are a Forensic Product Manager performing a structured discovery interview.',
        'You have read the LES (Lekolar Enhancer Suite) browser-extension codebase.',
        'Goal: uncover friction points, hidden patterns, and market gaps through targeted questions.',
        'Ask questions that probe what the code CAN do vs. what it ACTUALLY does for users.',
        'Be specific — reference actual files, function names, and patterns you see in the code.',
        'Do NOT suggest features yet. Interview first, synthesise later.',
    ].join('\n');

    const messages = [
        { role: 'system', content: SYSTEM },
        {
            role:    'user',
            content: [
                'Here is the LES codebase context:',
                '',
                context,
                '',
                '---',
                '',
                'You are a Forensic Product Manager. Ask me exactly 10 focused, numbered questions to uncover:',
                '1. Friction Points — where users or developers are currently struggling',
                '2. Hidden Patterns — what new utilities the existing data model could power',
                '3. Market Gaps — what standard modern features are absent from this architecture',
                '',
                'Do not suggest features yet. Interview me to find the pain first.',
            ].join('\n'),
        },
    ];

    const interviewLog = [];

    for (let round = 1; round <= rounds; round++) {
        process.stderr.write(`[2/3] Calling ${provider} — interview round ${round}…\n`);
        const questions = await callAI(messages, provider, apiKey);
        messages.push({ role: 'assistant', content: questions });
        interviewLog.push({ round, role: 'questions', text: questions });

        console.log(`\n─── Round ${round} — Questions ${'─'.repeat(40 - String(round).length)}\n`);
        console.log(questions);

        const answers = await readBlock(rl, `Your answers to Round ${round}:`);
        if (!answers) break;
        messages.push({ role: 'user', content: answers });
        interviewLog.push({ round, role: 'answers', text: answers });

        if (round < rounds) {
            const cont = await question(rl, '\nContinue to follow-up questions? (y/n) ');
            if (cont.trim().toLowerCase() !== 'y') break;
        }
    }

    // ── Step 3: Synthesise ─────────────────────────────────────────────────────

    console.log('\n─── Step 3: Synthesising "Unthought-of" Ideas ' + '─'.repeat(13) + '\n');

    messages.push({
        role:    'user',
        content: [
            'Based on the codebase analysis and the interview above, synthesise your findings into concrete product-improvement ideas.',
            '',
            'For each idea use this format:',
            '**Idea N: [Title]**',
            '- Insight: what pattern in the code or interview revealed this',
            '- Opportunity: what specifically could be built or improved',
            '- Effort: Low / Medium / High (based on the existing architecture)',
            '- Unused leverage: does existing code or data already partially support this?',
            '',
            'Prioritise ideas where the EXISTING ARCHITECTURE already supports part of the implementation',
            '— these are "unthought-of" wins hiding in plain sight.',
            '',
            'Also call out:',
            '- Dead or underutilised code paths that represent abandoned ideas worth reviving',
            '- Data already collected that could power new features with little extra work',
            '- Standard modern browser-extension features absent from this codebase',
            '- Developer pain points raised in the interview with clear architectural solutions',
            '',
            'Be specific. Reference file names and function names where relevant.',
        ].join('\n'),
    });

    process.stderr.write(`[3/3] Calling ${provider} for synthesis…\n`);
    const synthesis = await callAI(messages, provider, apiKey);
    console.log(synthesis);

    // ── Save report ────────────────────────────────────────────────────────────

    const date        = new Date().toISOString().slice(0, 10);
    const reportLines = [
        `# LES Legacy Discovery Report — ${date}`,
        '',
        `**Provider:** ${provider}  **Model:** ${cfg.model}`,
        '',
        '---',
        '',
        '## Interview Log',
        '',
    ];

    for (const entry of interviewLog) {
        reportLines.push(`### Round ${entry.round} — ${entry.role === 'questions' ? 'Questions' : 'Answers'}`);
        reportLines.push('');
        reportLines.push(entry.text);
        reportLines.push('');
    }

    reportLines.push('---', '', '## Synthesis: "Unthought-of" Ideas', '', synthesis, '');

    fs.writeFileSync(REPORT_PATH, reportLines.join('\n'), 'utf8');
    console.log(`\nReport saved → ${REPORT_PATH}`);

    rl.close();
}

main().catch(err => {
    process.stderr.write(`\nFatal: ${err.message}\n`);
    process.exit(1);
});
