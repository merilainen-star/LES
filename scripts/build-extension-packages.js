#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..');
const distRoot = path.join(repoRoot, 'dist');

const sharedFiles = [
  'manifest.json',
  'defaults.js',
  'background.js',
  'content.js',
  'popup.html',
  'popup.js',
  'popup.css',
  'options.html',
  'options.js',
  'options.css',
  'cryptoVault.js',
  'searchUtils.js',
  'facetVocabulary.js',
  'categoryClassifier.js',
  'aiPrompt.js',
  'aiProviders.js',
  'style.css',
  'logo.png',
  'README.md',
  'CHANGELOG.md',
  'icons',
  'vendor/pptxgen-prelude.js',
  'vendor/pptxgen.bundle.js',
  'vendor/pptxgen-global.js',
  'vendor/pptxgenjs-LICENSE.txt'
];

const packages = [
  { name: 'firefox', source: 'LekolarEnhancer', out: 'firefox' },
  { name: 'edge', source: 'LekolarEnhancer-Edge', out: 'edge' }
];

function copyPackageFile(pkg, relativePath) {
  const sourcePath = path.join(repoRoot, pkg.source, relativePath);
  const outPath = path.join(distRoot, pkg.out, relativePath);

  if (!fs.existsSync(sourcePath)) {
    throw new Error(`${pkg.name}: missing allowlisted source file ${relativePath}`);
  }

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.cpSync(sourcePath, outPath, { recursive: true });
}

function buildPackage(pkg) {
  const outDir = path.join(distRoot, pkg.out);
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });

  for (const relativePath of sharedFiles) {
    copyPackageFile(pkg, relativePath);
  }

  console.log(`Built dist/${pkg.out} from ${pkg.source}`);
}

fs.rmSync(distRoot, { recursive: true, force: true });
for (const pkg of packages) buildPackage(pkg);
