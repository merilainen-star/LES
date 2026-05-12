#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '..');
const distRoot = path.join(repoRoot, 'dist');
const packages = [
  { name: 'firefox', dir: path.join(distRoot, 'firefox') },
  { name: 'edge', dir: path.join(distRoot, 'edge') }
];

const forbiddenNames = new Set([
  'test.html',
  'test_facets.js',
  'manifest-chrome.json',
  '_push_image_copy',
  'edge-extension.zip'
]);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function walkFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkFiles(full));
    else out.push(full);
  }
  return out;
}

function assertPackageFile(pkg, relativePath) {
  assert(fs.existsSync(path.join(pkg.dir, relativePath)), `${pkg.name}: missing package file ${relativePath}`);
}

function collectManifestRefs(manifest, pkg) {
  const refs = new Set();

  if (manifest.action) {
    if (manifest.action.default_popup) refs.add(manifest.action.default_popup);
    for (const icon of Object.values(manifest.action.default_icon || {})) refs.add(icon);
  }

  for (const icon of Object.values(manifest.icons || {})) refs.add(icon);
  if (manifest.options_ui && manifest.options_ui.page) refs.add(manifest.options_ui.page);

  if (manifest.background) {
    if (manifest.background.service_worker) refs.add(manifest.background.service_worker);
    for (const script of manifest.background.scripts || []) refs.add(script);
  }

  for (const contentScript of manifest.content_scripts || []) {
    for (const js of contentScript.js || []) refs.add(js);
    for (const css of contentScript.css || []) refs.add(css);
  }

  const jsFiles = walkFiles(pkg.dir).filter(file => file.endsWith('.js') && !file.includes(`${path.sep}vendor${path.sep}`));
  for (const file of jsFiles) {
    const source = fs.readFileSync(file, 'utf8');
    const importCalls = source.matchAll(/importScripts\s*\(([\s\S]*?)\)/g);
    for (const call of importCalls) {
      const stringArgs = call[1].matchAll(/['"]([^'"]+)['"]/g);
      for (const arg of stringArgs) refs.add(arg[1]);
    }
  }

  return refs;
}

function permissionCoversUrl(permission, url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch (_) {
    return true;
  }

  if (permission === '<all_urls>') return true;

  if (permission.startsWith('*://*.')) {
    const hostPart = permission.slice('*://*.'.length).split('/')[0].toLowerCase();
    return parsed.hostname === hostPart || parsed.hostname.endsWith(`.${hostPart}`);
  }

  try {
    const perm = new URL(permission.replace(/\*$/, ''));
    return parsed.protocol === perm.protocol && parsed.hostname === perm.hostname;
  } catch (_) {
    return false;
  }
}

function assertFetchHostsCovered(pkg, manifest) {
  const hostPermissions = [
    ...(manifest.host_permissions || []),
    ...(manifest.optional_host_permissions || [])
  ];
  const jsFiles = walkFiles(pkg.dir).filter(file => file.endsWith('.js') && !file.includes(`${path.sep}vendor${path.sep}`));
  const urls = new Set();

  for (const file of jsFiles) {
    const source = fs.readFileSync(file, 'utf8');
    if (!/\bfetch\s*\(/.test(source)) continue;
    for (const match of source.matchAll(/https:\/\/[^\s'"`<>)]+/g)) {
      urls.add(match[0].replace(/[.,;:]+$/, ''));
    }
  }

  for (const url of urls) {
    assert(
      hostPermissions.some(permission => permissionCoversUrl(permission, url)),
      `${pkg.name}: ${url} is referenced in JS but not covered by host_permissions`
    );
  }
}

function assertNoForbiddenFiles(pkg) {
  for (const file of walkFiles(pkg.dir)) {
    const rel = path.relative(pkg.dir, file).replace(/\\/g, '/');
    const parts = rel.split('/');
    assert(!parts.some(part => forbiddenNames.has(part)), `${pkg.name}: forbidden release file ${rel}`);
  }
}

function runNodeChecks(pkg) {
  const jsFiles = walkFiles(pkg.dir).filter(file => file.endsWith('.js') && !file.includes(`${path.sep}vendor${path.sep}`));
  for (const file of jsFiles) {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
  }
}

function checkPackage(pkg) {
  assert(fs.existsSync(pkg.dir), `${pkg.name}: package directory does not exist`);
  assertPackageFile(pkg, 'manifest.json');

  const manifest = readJson(path.join(pkg.dir, 'manifest.json'));
  for (const relativePath of collectManifestRefs(manifest, pkg)) assertPackageFile(pkg, relativePath);

  assertNoForbiddenFiles(pkg);
  assertFetchHostsCovered(pkg, manifest);
  runNodeChecks(pkg);

  console.log(`Checked dist/${pkg.name}`);
  return manifest;
}

const checkedManifests = new Map();
for (const pkg of packages) checkedManifests.set(pkg.name, checkPackage(pkg));

assert(
  checkedManifests.get('firefox').version === checkedManifests.get('edge').version,
  'firefox and edge manifest versions differ'
);
