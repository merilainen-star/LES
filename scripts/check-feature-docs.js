#!/usr/bin/env node

const { execFileSync } = require('node:child_process');

const REQUIRED_DOCS = [
    'LekolarEnhancer/README.md',
    'LekolarEnhancer/CHANGELOG.md',
    'LekolarEnhancer-Edge/README.md',
    'LekolarEnhancer-Edge/CHANGELOG.md',
];

const ZERO_SHA = '0000000000000000000000000000000000000000';

function runGit(args) {
    return execFileSync('git', args, { encoding: 'utf8' })
        .split(/\r?\n/)
        .map(normalizePath)
        .filter(Boolean);
}

function normalizePath(file) {
    return String(file || '').trim().replace(/\\/g, '/').replace(/^\.\//, '');
}

function usage() {
    console.error('Usage: node scripts/check-feature-docs.js [--staged | --working | --range <git-range-or-commit>]');
}

function changedFilesFromArgs(args) {
    const mode = args[0] || '--working';

    if (mode === '--staged') {
        return runGit(['diff', '--name-only', '--cached', '--diff-filter=ACMR']);
    }

    if (mode === '--working') {
        return runGit(['diff', '--name-only', '--diff-filter=ACMR', 'HEAD', '--']);
    }

    if (mode === '--range') {
        const range = args[1];
        if (!range) {
            usage();
            process.exit(2);
        }

        if (range.includes('..')) {
            return runGit(['diff', '--name-only', '--diff-filter=ACMR', range]);
        }

        if (range === ZERO_SHA) return [];
        return runGit(['diff-tree', '--root', '--no-commit-id', '--name-only', '-r', '--diff-filter=ACMR', range]);
    }

    usage();
    process.exit(2);
}

function isFeatureSurface(file) {
    const normalized = normalizePath(file);

    if (!/^LekolarEnhancer(?:-Edge)?\//.test(normalized)) return false;
    if (REQUIRED_DOCS.includes(normalized)) return false;
    if (/\/(?:README|CHANGELOG)\.md$/i.test(normalized)) return false;
    if (/\.md$/i.test(normalized)) return false;
    if (/\/manifest\.json$/i.test(normalized)) return false;

    return /\.(?:js|html|css|png|svg|jpg|jpeg|webp)$/i.test(normalized);
}

function main() {
    const changed = changedFilesFromArgs(process.argv.slice(2));
    const changedSet = new Set(changed);
    const featureFiles = changed.filter(isFeatureSurface);

    if (featureFiles.length === 0) {
        console.log('Feature docs check passed: no feature-surface add-on changes detected.');
        return;
    }

    const missingDocs = REQUIRED_DOCS.filter(file => !changedSet.has(file));

    if (missingDocs.length === 0) {
        console.log('Feature docs check passed: README and What\'s new files were updated.');
        return;
    }

    console.error('Feature docs check failed.');
    console.error('');
    console.error('Feature-surface add-on files changed:');
    featureFiles.forEach(file => console.error(`  - ${file}`));
    console.error('');
    console.error('Update and include these documentation files in the same commit or push range:');
    missingDocs.forEach(file => console.error(`  - ${file}`));
    console.error('');
    console.error('The settings page loads README.md and CHANGELOG.md, so these files also update the README and What\'s new panels.');
    process.exit(1);
}

main();
