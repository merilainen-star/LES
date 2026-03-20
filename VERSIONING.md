# Versioning

## Source of Truth

- `LekolarEnhancer/manifest.json` is the canonical version source.
- `LekolarEnhancer-Edge/manifest.json` is kept in sync during publishing.

## Current Scheme

- Versions follow a simple dotted numeric format such as `1.14`.
- The publish workflow auto-increments the last numeric segment as a patch bump.

## Release Flow

1. Changes pushed to `main` under `LekolarEnhancer/**`, `LekolarEnhancer-Edge/**`, or `sync-edge-variant.ps1` trigger the publish workflow.
2. The workflow reads the current version from `LekolarEnhancer/manifest.json`.
3. It increments the patch version and writes the new value to both manifests.
4. It runs `sync-edge-variant.ps1` to copy shared Firefox files into `LekolarEnhancer-Edge` and remove Firefox-only blocks from the Edge `content.js`.
5. It commits the bumped version back to `main`.
6. Firefox is signed and uploaded from `LekolarEnhancer/`.
7. Edge is zipped and submitted from `LekolarEnhancer-Edge/`.

## Notes

- The popup UI displays the installed version directly from `chrome.runtime.getManifest().version`.
- There is currently no separate changelog file; release history is primarily visible through Git history and store submissions.
