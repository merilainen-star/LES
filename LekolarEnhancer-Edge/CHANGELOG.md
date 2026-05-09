# What's new

## v1.26 — 2026-05-09

- **Master power button** in the popup, uBlock-style. One click disables the extension on every Lekolar site without uninstalling it.
- **Full settings page** with sidebar tabs: General, Copy format, Omnibox, AI Search (beta), Advanced, What's new, About. The popup is now just the power switch and a button to open this page.
- **Fully customizable copy formats**. Each modifier slot (no-mod / primary / secondary) is now a drag-and-drop token list — combine `{number}`, `{name}`, `{url}`, `{value}`, and any literal text (including newlines via `\n`). Each slot has its own "Copy as link" toggle and label.
- **Per-country activation**. Turn the extension off on individual Lekolar domains (FI / SE / NO / DK) without disabling everything.
- **AI Search is now BETA** and hidden by default. Enable it on the General tab to bring back the AI input plus an inline model picker, query history, and an advanced panel for temperature / max tokens.
- **Backup & restore**. Export every setting to JSON and re-import on another machine. API keys are never written to the export.
- **Reset to defaults** button on the Advanced tab.
- **Debug logging** toggle for verbose `[LES]` console output when reporting issues.
- **What's new + About** tabs in settings, with a small dot in the popup that goes away after you've read the latest entry.

## v1.25 — 2026-04

- Keep published extension version in sync between Chrome and Edge manifests.

## v1.24

- Working product image copy flow.

## v1.23

- Local edge-extension.zip build script.

## v1.22

- Move `scrape-facets.js` from `tools/` into `scripts/`.
