# Versioning

## Source of Truth

- `LekolarEnhancer/manifest.json` is the canonical version source.
- `LekolarEnhancer-Edge/manifest.json` is kept in sync during publishing.

## Current Scheme

- Versions follow a simple dotted numeric format such as `1.14`.
- The version committed in `LekolarEnhancer/manifest.json` is the exact version that gets published.

## Release Flow

1. Changes pushed to `main` under `LekolarEnhancer/**`, `LekolarEnhancer-Edge/**`, or `sync-edge-variant.ps1` trigger the publish workflow.
2. The workflow reads the release version from `LekolarEnhancer/manifest.json`.
3. It runs `sync-edge-variant.ps1` to copy shared Firefox files into `LekolarEnhancer-Edge` and remove Firefox-only blocks from the Edge `content.js`.
4. Firefox is signed and uploaded from `LekolarEnhancer/`.
5. Edge is zipped and submitted from `LekolarEnhancer-Edge/`.

## Notes

- The popup UI displays the installed version directly from `chrome.runtime.getManifest().version`.
- To keep Git and the stores in sync, bump the manifest version in your commit before pushing to `main`.
- There is currently no separate changelog file; release history is primarily visible through Git history and store submissions.
