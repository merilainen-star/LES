# LekolarEnhancer — dev tools

Scripts that are NOT shipped with the extension. They live outside `LekolarEnhancer/` so they don't get bundled into the browser package.

## Legacy Discovery Workflow

`legacy-discovery.js` implements a 3-step AI-assisted process for surfacing product improvements hidden in the existing codebase:

1. **Ingest** — bundles key source files into an AI-readable context
2. **Interview** — an AI acts as a Forensic Product Manager, asking 10 focused questions per round to uncover friction points, hidden patterns, and market gaps
3. **Synthesise** — the AI cross-references your answers with the code to produce prioritised, architecture-aware improvement ideas

The output is printed to stdout and also saved to `tools/legacy-discovery-report.md`.

### Requirements

Node 18+ (for built-in `fetch`). No npm dependencies.

### Run

Set your API key for the chosen provider, then run from the repo root:

```
# OpenAI (default)
OPENAI_API_KEY=sk-... node tools/legacy-discovery.js

# Anthropic
ANTHROPIC_API_KEY=sk-ant-... node tools/legacy-discovery.js --provider anthropic

# Google Gemini
GEMINI_API_KEY=... node tools/legacy-discovery.js --provider gemini
```

If `node` isn't on your PATH, use the bundled binary:

```
OPENAI_API_KEY=sk-... .\tools\node.exe tools/legacy-discovery.js
```

### Options

| Flag | Default | Description |
|------|---------|-------------|
| `--provider <name>` | `openai` | AI provider: `openai`, `anthropic`, or `gemini` |
| `--rounds <n>` | `1` | Number of interview rounds before synthesis (1 = 10 Qs + synthesis, 2 = 20 Qs + synthesis) |

### How the interview works

After ingestion the AI asks 10 numbered questions. Type your answers freely — the AI reads the whole block. When you are done, type `---` on its own line and press Enter to move on. After all rounds the AI produces a ranked list of "unthought-of" improvement ideas referencing the actual files and functions it found in the code.

---

## Facet scraper

Crawls the Lekolar category landing pages and rewrites `LekolarEnhancer/facetVocabulary.js` with the real facet keys and values currently in Lekolar's indexer. This file is what the AI prompt uses to force the model to pick canonical values ("Laminaatti", "Metalli", "Koivu" …) instead of inventing close-but-wrong synonyms ("Korkeapainelaminaatti", "Teräs", "Mänty").

### Requirements

Node 18+ (for built-in `fetch`). No npm dependencies — the script is pure stdlib, so `npm install` is not needed.

### Run

```
cd tools
node scrape-facets.js
```

If `node` isn't on your PATH, call the unzipped binary directly, e.g.:

```
..\node-v20.x-win-x64\node.exe scrape-facets.js
```

The script fetches each URL in `CATEGORY_URLS` and writes `LekolarEnhancer/facetVocabulary.js`. Progress is logged to stderr. When it's done, reload the extension and try a search again.

Re-run any time Lekolar adds/removes facet values (roughly quarterly is probably fine).

### Adding a new category

1. Add an entry to `CATEGORY_URLS` at the top of `scrape-facets.js`.
2. Add matching keywords to `LES_CATEGORY_RULES` in `LekolarEnhancer/categoryClassifier.js` so free-text queries route to the new vocab.
3. Re-run the scraper.

### Extending the mapped facets

The scraper only keeps facet fields listed in `FIELD_TO_FRIENDLY`. If a category page exposes a useful facet that isn't in the map, the script prints it under "Unmapped facets" at the end of the run. Add it to both `FIELD_TO_FRIENDLY` in the scraper *and* `PIM_TO_FACET_MAP` in `LekolarEnhancer/searchUtils.js`.
