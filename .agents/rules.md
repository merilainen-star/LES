# Project Rules

## Extension Synchronization
The user maintains two separate directories for the exact same browser extension code:
1. `LekolarEnhancer` (Firefox - Manifest V3 with background scripts)
2. `LekolarEnhancer-Edge` (Edge/Chrome - Manifest V3 with service worker)

**CRITICAL RULE**: Whenever you are asked to make an edit, add a feature, or fix a bug in ONE of the directories, you MUST make the exact same change in the OTHER directory. 
The code in `content.js` and `style.css` (and any other utility scripts) should always be 100% identical between `LekolarEnhancer` and `LekolarEnhancer-Edge`.

The only file that should differ between these two folders is `manifest.json`.
- Firefox requires `background.scripts`.
- Edge/Chrome requires `background.service_worker`.
Everything else (permissions, content scripts, versions) should be identical.
