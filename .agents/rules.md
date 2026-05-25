# Agent Rules — Lekolar Enhancer

## 1. Extension Synchronization

Two directories ship the same extension code:

| Directory | Browser | Difference |
|---|---|---|
| `LekolarEnhancer` | Firefox | `background.scripts` in manifest |
| `LekolarEnhancer-Edge` | Edge / Chrome | `background.service_worker` in manifest |

**Always run `sync-edge-variant.ps1` after editing any shared source file.**

```powershell
powershell -ExecutionPolicy Bypass -File "sync-edge-variant.ps1"
```

This copies `content.js`, `style.css`, `background.js`, `defaults.js`, `popup.*`, `options.*`, and other shared files from `LekolarEnhancer` into `LekolarEnhancer-Edge`. The only file that intentionally differs is `manifest.json`.

---

## 2. Pre-Commit Checklist

Follow this checklist **every time** you commit a feature or fix to the extension code.

### Step 1 — Bump the version

- Version source of truth: `LekolarEnhancer/manifest.json` → `"version"` field.
- Increment the minor number: `1.29` → `1.30` → `1.31`, etc.
- The sync script copies `manifest.json` is NOT synced — the Edge manifest is managed separately. Bump `LekolarEnhancer-Edge/manifest.json` to the same version manually if it is not already.

### Step 2 — Update CHANGELOG.md

File: `LekolarEnhancer/CHANGELOG.md`

Add a new entry at the **top** of the file, above all previous entries:

```markdown
## v1.XX — YYYY-MM-DD

- **Feature name** — One sentence describing what changed and why it matters to the user.
```

- Write from the user's perspective (what they can now do), not the implementation.
- Use bold for the feature name.
- Keep it to 1–3 bullet points per version.

### Step 3 — Update README.md

File: `LekolarEnhancer/README.md`

- If a **new user-facing feature** was added: add a numbered section to the **Core Functionality** list.
- If an existing feature changed: update its description in place.
- README describes what each feature does, where it appears, and how to use it.

### Step 4 — Sync to Edge

Run the sync script (copies CHANGELOG, README, and all source files):

```powershell
powershell -ExecutionPolicy Bypass -File "sync-edge-variant.ps1"
```

### Step 5 — Stage only relevant files

```powershell
git add LekolarEnhancer/ LekolarEnhancer-Edge/ .github/
```

Do **not** stage: `.claude/`, `_push_image_copy/`, `scratch/`, `codex_*.pptx`, or other dev artifacts.

### Step 6 — Commit

Use `--no-verify` because the pre-commit hook requires Node.js which may not be available in the agent environment:

```powershell
git commit --no-verify -m "feat: short description

- Bullet summarising change 1
- Bullet summarising change 2"
```

Commit message conventions:
- `feat:` — new user-facing feature
- `fix:` — bug fix
- `chore:` — docs, version bumps, CI, tooling (no feature change)
- `refactor:` — internal code restructure, no behaviour change

### Step 7 — Push

```powershell
git push --no-verify
```

`--no-verify` is needed for the same reason as commit.

---

## 3. CI / GitHub Actions

The publish workflow (`.github/workflows/publish-edge-extension.yml`) runs on every push to `main` that touches extension source files. It:

1. Runs `check-feature-docs.js` — **fails if CHANGELOG.md or README.md were not updated alongside feature-surface code changes.** This is why Steps 2–3 above are mandatory.
2. Builds clean `dist/firefox` and `dist/edge` packages.
3. Publishes to Firefox AMO and Edge Add-ons automatically.

The workflow uses `FORCE_JAVASCRIPT_ACTIONS_TO_NODE24: true` — do not remove this.

---

## 4. UI and Text Rules

- All extension-owned **user-facing text must be in English** (buttons, tooltips, toasts, labels, settings). The user base spans all Nordic markets.
- The **popup must stay minimal**: master power button, SharePoint status, and Open settings only. Everything else goes on the settings page.
- Do not add `alert()` calls in production code — use `showCompareToast()` instead.

---

## 5. Key Files

| File | Purpose |
|---|---|
| `LekolarEnhancer/manifest.json` | Version source of truth |
| `LekolarEnhancer/content.js` | All page injection logic |
| `LekolarEnhancer/style.css` | All extension-owned CSS |
| `LekolarEnhancer/CHANGELOG.md` | What's new (shown in settings) |
| `LekolarEnhancer/README.md` | Feature documentation |
| `sync-edge-variant.ps1` | Syncs shared files to Edge variant |
| `scripts/check-feature-docs.js` | CI gate: enforces docs updates |
| `scripts/build-extension-packages.js` | Builds clean dist/ packages |
| `.github/workflows/publish-edge-extension.yml` | CI/CD publish pipeline |
