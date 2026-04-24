# LekolarEnhancer — dev tools

Scripts that are NOT shipped with the extension. They live outside `LekolarEnhancer/` so they don't get bundled into the browser package.

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
