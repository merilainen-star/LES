# Lekolar Enhancer - Browser Extension

## Project Overview

Lekolar Enhancer is a Manifest V3 browser extension for Firefox and Microsoft Edge. It improves internal productivity on the Lekolar e-commerce sites (lekolar.fi, lekolar.se, lekolar.dk, lekolar.no) with copy tools, browsing helpers, SharePoint search, optional AI Search, and optional source-text translation.

## Popup Menu Rule

Keep the extension popup intentionally clean. It should only contain the header share shortcut, the master power button, SharePoint status/re-check, and the button that opens the full settings page. Feature controls, import/export tools, changelogs, and other workflows belong in the settings page.

## User-Facing Text Rule

All extension-owned user-facing text must be English because the internal userbase works across the Nordic markets. Buttons, tooltips, settings, dialogs, toasts, note labels, and injected helper UI should not use a single local market language.

## Feature Documentation Rule

Every feature change must be documented in this add-on README and in the What's new changelog (`CHANGELOG.md`) before release. Keep the feature list and What's new entry in sync with the implemented behavior.

Commit and push checks enforce this rule with `scripts/check-feature-docs.js`: feature-surface add-on changes must include both add-on README files and both What's new changelog files in the same commit or push range.

## Core Functionality

The extension injects utility buttons directly into the product page DOM to facilitate quick copying of product information.

**1. Copy Product Number**

- **Location**: Injected next to the product number (e.g., "Tuotenro: 12345").
- **Action**: Copies the product number to the clipboard.
- **Icon**: Standard copy icon.

**2. Copy Product Name**

- **Location**: Injected inside the main `<h1>` product title.
- **Action**: Copies the product name to the clipboard.
- **Icon**: Standard copy icon.

**3. Advanced Copy (Shift + Click)**

- **Trigger**: Hold `Shift` while clicking **either** the Number or Name copy button.
- **Action**: Copies a combined string in the format: `[Product Number] [Product Name]` as the visible text, and attaches a loopback hyperlink to the current product page URL.
- **Result**:
  - **Plain Text Paste**: "12345 Product Name - <https://lekolar.fi/>..."
  - **Rich Text Paste (Word/Email)**: <a href="https://lekolar.fi/...">12345 Product Name</a>
- **Tooltip**: The button tooltip dynamically updates to "Copy number + name (Link)" when the Shift key is held.

**4. Reveal Product Information**

- **Function**: Automatically expands product descriptions on category and search result pages.
- **Benefit**: Removes the default 2-line truncation, allowing users to see full product details without clicking into the product page.

**5. Infinite Scroll**

- **Function**: Automatically loads the next page of products when scrolling to the bottom of a category or search result page.
- **Benefit**: Provides a seamless browsing experience without needing to click pagination buttons.

**6. Personal Product Notes**

- **Location**: Product page action bar.
- **Action**: Opens a local notes log for the current product.
- **Format**: One row per note with `Time/date`, `User`, and `Note`.
- **Delete**: Check one or more notes written by the current local user and click `Delete selected`.
- **Storage**: Saved in local browser storage. Export/import is available from the Advanced settings tab.

**7. Product Card PowerPoint**

- **Location**: Product page action bar.
- **Action**: Creates a product-card PowerPoint file from the current product details and image.
- **Runtime assets**: Uses the vendored `pptxgenjs` bundle shipped inside the extension package.

**8. Omnibox and SharePoint Search**

- **Omnibox keyword**: Type `l` in the browser address bar to search Lekolar products.
- **SharePoint**: Optional SharePoint search helpers use the declared `lekolarab.sharepoint.com` host permission.

**9. AI Search and Swedish Source Translation**

- **AI Search**: Optional beta feature that sends the typed query only to the selected AI provider after the user enables external services consent.
- **Translation**: Optional helper that sends selected/source text to MyMemory only after the user enables external services consent.
- **API keys**: Stored encrypted in local extension storage and omitted from settings backup/export files.

## External Services and Consent

External services are off by default. The General settings tab includes an `External services` consent toggle explaining that AI Search sends the typed query to the selected AI provider, and Swedish source translation sends source text to MyMemory.

Firefox declares optional built-in data collection permissions for `searchTerms` and `websiteContent` in `browser_specific_settings.gecko.data_collection_permissions`, and requests those permissions before enabling the local `externalServicesConsent` setting. Edge does not have the Firefox data-consent manifest key, so Edge uses the same in-extension disclosure and stored consent setting.

The background worker blocks `lesAiSearch`, `lesAiTestKey`, and `lesTranslateText` unless external-services consent is present.

## Technical Implementation

- **Manifest V3**: Uses the latest browser extension standard with `activeTab` and `clipboardWrite` permissions.
- **Browser parity**: Firefox and Edge ship the same runtime feature set, with browser-specific manifest differences kept to the minimum needed by each store.
- **Host permissions**: Lekolar country domains, SharePoint, MyMemory, OpenAI, Anthropic, and Gemini hosts are declared only because the shipped features call those services.
- **Content Script (`content.js`)**:
  - Uses a `MutationObserver` to handle dynamic content loading (e.g., when switching variants).
  - Uses `XPath` and `querySelector` to robustly locate product numbers and titles, even if the DOM structure varies slightly.
  - Implements the `Clipboard API` (`navigator.clipboard.write`) for writing both `text/plain` and `text/html` mime types.
- **Styling (`style.css`)**:
  - Scoped CSS classes (`.lekolar-copy-btn`) to avoid conflicts.
  - Matches the site's aesthetic (hover effects, cursor pointers).
  - Includes a custom tooltip implementation.

## File Structure

- `manifest.json`: Extension configuration.
- `content.js`: Core logic for DOM manipulation and event handling.
- `style.css`: Visual styling for buttons and tooltips.
- `icons/`: (Optional) Icon assets.
- `vendor/`: Vendored runtime dependencies and their license files.
- `dist/firefox` and `dist/edge`: Clean generated release packages created by `node scripts/build-extension-packages.js`.

## Installation

- For Firefox releases, use Mozilla Add-ons: <https://addons.mozilla.org/en-US/developers/addon/778ccbb63fa64c838515/edit>.
- For Edge releases, use Microsoft Edge Add-ons: <https://microsoftedge.microsoft.com/addons/detail/poiadopjpbekbageflcbghabcidpbjhj>.
- Load as a temporary add-on in `about:debugging` (Firefox) or as an unpacked extension in Edge.
- Core copy, browsing, notes, PPT, omnibox, and SharePoint features work on matching domains after install. AI Search and translation require the user to enable external services consent in Settings.

## Release Packaging

- Build clean packages with `node scripts/build-extension-packages.js`.
- Verify packages with `node scripts/check-extension-packages.js`.
- Firefox signing uses `dist/firefox`; Edge zipping uses `dist/edge`.
- Release packages are built from an explicit allowlist and exclude test pages, scratch files, raw captured pages, `_push_image_copy`, duplicate manifest variants, and unrelated repository artifacts.
- `sync-edge-variant.ps1` only syncs shared source files into the Edge source folder. Packaging is owned by the Node build script.

## Versioning

- The Firefox manifest is the version source of truth: `LekolarEnhancer/manifest.json`.
- The publish workflow reads the committed manifest version and publishes that exact version.
- `sync-edge-variant.ps1` copies shared files to the Edge variant.
- See `../VERSIONING.md` for the release flow.
