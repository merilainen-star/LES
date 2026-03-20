# Lekolar Enhancer - Edge Extension

## Project Overview

This project is the Microsoft Edge (Manifest V3) variant of Lekolar Enhancer, designed to improve productivity on the Lekolar e-commerce sites (lekolar.fi, lekolar.se, lekolar.dk, lekolar.no).

## Core Functionality

The extension injects utility buttons directly into the product page DOM to facilitate quick copying of product information.

### 1. Copy Product Number

- **Location**: Injected next to the product number (e.g., "Tuotenro: 12345").
- **Action**: Copies the product number to the clipboard.
- **Icon**: Standard copy icon.

### 2. Copy Product Name

- **Location**: Injected inside the main `<h1>` product title.
- **Action**: Copies the product name to the clipboard.
- **Icon**: Standard copy icon.

### 3. Advanced Copy (Shift + Click)

- **Trigger**: Hold `Shift` while clicking **either** the Number or Name copy button.
- **Action**: Copies a combined string in the format: `[Product Number] [Product Name]` as the visible text, and attaches a loopback hyperlink to the current product page URL.
- **Result**:
  - **Plain Text Paste**: "12345 Product Name - <https://lekolar.fi/>..."
  - **Rich Text Paste (Word/Email)**: <a href="https://lekolar.fi/...">12345 Product Name</a>
- **Tooltip**: The button tooltip dynamically updates to "Copy number + name (Link)" when the Shift key is held.

### 4. Reveal Product Information

- **Function**: Automatically expands product descriptions on category and search result pages.
- **Benefit**: Removes the default 2-line truncation, allowing users to see full product details without clicking into the product page.

### 5. Infinite Scroll

- **Function**: Automatically loads the next page of products when scrolling to the bottom of a category or search result page.
- **Benefit**: Provides a seamless browsing experience without needing to click pagination buttons.

## Technical Implementation

- **Manifest V3**: Uses the latest browser extension standard with `activeTab` and `clipboardWrite` permissions.
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

## Installation

- Load as a temporary addon in `about:debugging` (Firefox) or Unpacked Extension in Chrome/Edge.
- Requires no configuration; works automatically on matching domains.

## Versioning

- Version numbers are kept aligned with the Firefox source manifest during publish.
- The Edge package is generated from the synced `LekolarEnhancer-Edge` folder.
- `sync-edge-variant.ps1` updates shared files from the Firefox source before publishing.
- See `../VERSIONING.md` for the release flow.
