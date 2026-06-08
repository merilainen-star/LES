# Versioning

## Source of Truth

- `LekolarEnhancer/manifest.json` is the canonical version source.
- `LekolarEnhancer-Edge/manifest.json` is kept in sync during publishing.

## Current Scheme

- Versions follow a simple dotted numeric format such as `1.14`.
- The version committed in `LekolarEnhancer/manifest.json` is the exact version that gets published.

## Release Flow

1. Changes pushed to `main` under extension source, release packaging scripts, `sync-edge-variant.ps1`, versioning docs, or the publish workflow trigger the publish workflow.
2. The workflow reads the release version from `LekolarEnhancer/manifest.json`.
3. Edge release jobs run `sync-edge-variant.ps1` to copy shared source files into `LekolarEnhancer-Edge`.
4. `node scripts/build-extension-packages.js` creates clean `dist/firefox` and `dist/edge` packages from an explicit allowlist.
5. `node scripts/check-extension-packages.js` verifies package contents, manifest references, `importScripts()` dependencies, external host declarations, and JavaScript syntax.
6. Firefox is linted, signed, and uploaded from `dist/firefox/`.
7. Edge is zipped from `dist/edge/`, smoke-checked for a root `manifest.json` and forbidden dev artifacts, uploaded as a workflow artifact named `edge-extension-<version>`, then submitted to Edge Add-ons.

## Commit and Push Checks

- Enable the versioned hooks once per clone with `git config core.hooksPath .githooks`.
- `pre-commit` runs `node scripts/check-feature-docs.js --staged`.
- `pre-push` checks outgoing commits with `node scripts/check-feature-docs.js --range`.
- The publish workflow also runs the same check before release jobs.
- Any feature-surface add-on change under `LekolarEnhancer/` or `LekolarEnhancer-Edge/` must include both add-on README files and both What's new changelog files in the same commit or push range.

## Notes

- The popup UI displays the installed version directly from `chrome.runtime.getManifest().version`.
- Keep the popup menu minimal: master power button, SharePoint status/re-check, and Open settings only. Put feature controls, import/export tools, changelogs, and other workflows on the settings page.
- Keep all extension-owned user-facing text in English for the Nordic internal userbase. Market-language strings may be used internally for page parsing/search matching, but not as add-on UI labels.
- Every feature change must be documented in both add-on README files and both What's new changelog files before release.
- To keep Git and the stores in sync, bump the manifest version in your commit before pushing to `main`.
- `scripts/build-edge-zip.ps1` uses the same clean package builder and checker before creating both `edge-extension.zip` and `edge-extension-<version>.zip` from `dist/edge`.
- `sync-edge-variant.ps1` only syncs shared source files; it does not create release ZIPs.
- Release history is documented in the add-on What's new changelog files, Git history, and store submissions.
