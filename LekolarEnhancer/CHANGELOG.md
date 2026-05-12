# What's new

## v1.28 - 2026-05-12

- **AMO warning cleanup** removes raw HTML rendering from extension-owned UI and disables legacy eval-like fallbacks in the vendored PowerPoint runtime.
- **Safer price simulation restore** now keeps original price DOM nodes in memory instead of storing and replaying raw HTML strings.

## v1.27 - 2026-05-12

- **External services consent** is now required before AI Search, AI provider key tests, or Swedish source translation can send text to third-party services.
- **Firefox data transmission disclosure** now declares optional `searchTerms` and `websiteContent` data permissions for the built-in Firefox consent flow.
- **Edge AI parity** now includes the AI runtime files and OpenAI, Anthropic, and Gemini host permissions used by the shipped AI Search feature.
- **Clean release packages** are generated into `dist/firefox` and `dist/edge` from an explicit allowlist, excluding tests, scratch files, captured pages, duplicate manifest variants, and unrelated repository artifacts.
- **Static package checks** verify manifest assets, `importScripts()` dependencies, external fetch host declarations, JavaScript syntax, and Edge ZIP hygiene before release.

## v1.26 — 2026-05-09

- **Master power button** in the popup, uBlock-style. One click disables the extension on every Lekolar site without uninstalling it.
- **Clean popup menu** with only the power switch, SharePoint status/re-check, and a button to open settings.
- **Full settings page** with sidebar tabs: General, Copy format, Omnibox, AI Search (beta), Advanced, What's new, About.
- **Personal product notes** on product pages as timestamped one-line rows with User and Note columns, saved locally in this browser profile. Own notes can be selected and deleted; export/import lives on the Advanced settings tab.
- **Icon-only product action bar** keeps compare, notes, selected-dimension search, Swedish source text, and SharePoint search in one compact row with English tooltips.
- **Fully customizable copy formats**. Each modifier slot (no-mod / primary / secondary) is now a drag-and-drop token list — combine `{number}`, `{name}`, `{url}`, `{value}`, and any literal text (including newlines via `\n`). Each slot has its own "Copy as link" toggle and label.
- **Per-country activation**. Turn the extension off on individual Lekolar domains (FI / SE / NO / DK) without disabling everything.
- **AI Search is now BETA** and hidden by default. Enable it on the General tab to bring back the AI input plus an inline model picker, query history, and an advanced panel for temperature / max tokens.
- **Backup & restore**. Export every setting to JSON and re-import on another machine. API keys are never written to the export.
- **Reset to defaults** button on the Advanced tab.
- **Debug logging** toggle for verbose `[LES]` console output when reporting issues.
- **What's new + About** tabs in settings, with an unread dot in the settings sidebar.
- **Firefox Add-ons link** in the Firefox settings About tab, pointing to the Mozilla Add-ons page.
- **Feature documentation check** blocks commits, pushes, and releases when add-on feature changes are missing README or What's new updates.

## v1.25 — 2026-04

- Keep published extension version in sync between Chrome and Edge manifests.

## v1.24

- Working product image copy flow.

## v1.23

- Local edge-extension.zip build script.

## v1.22

- Move `scrape-facets.js` from `tools/` into `scripts/`.
