#!/usr/bin/env pwsh
# scripts/build-edge-zip.ps1
# Builds the clean release packages, then zips dist/edge into edge-extension.zip
# at the repo root. Mirrors the GitHub Actions Edge packaging path.
#
# Usage:
#   pwsh scripts/build-edge-zip.ps1
#   # or from Windows PowerShell: powershell -File scripts/build-edge-zip.ps1

$ErrorActionPreference = 'Stop'

$repoRoot = (git rev-parse --show-toplevel).Trim()
if (-not $repoRoot) { throw "Not inside a git repository." }

$sourceDir = Join-Path $repoRoot 'dist/edge'
$outputZip = Join-Path $repoRoot 'edge-extension.zip'
$releaseVersion = (node -e "console.log(require('./LekolarEnhancer/manifest.json').version)").Trim()
$versionedOutputZip = Join-Path $repoRoot "edge-extension-$releaseVersion.zip"

node (Join-Path $repoRoot 'scripts/build-extension-packages.js')
node (Join-Path $repoRoot 'scripts/check-extension-packages.js')

if (Test-Path $outputZip) { Remove-Item $outputZip -Force }
if (Test-Path $versionedOutputZip) { Remove-Item $versionedOutputZip -Force }

# Pack the CONTENTS of dist/edge (not the folder itself) so the
# manifest.json ends up at the zip root — which is what the Edge Add-ons
# store expects.
Compress-Archive -Path (Join-Path $sourceDir '*') -DestinationPath $outputZip -Force
Copy-Item -LiteralPath $outputZip -Destination $versionedOutputZip -Force

$size = (Get-Item $outputZip).Length
$sizeKb = [math]::Round($size / 1KB, 1)
Write-Host "Built edge-extension.zip ($sizeKb KB) at repo root."
Write-Host "Built edge-extension-$releaseVersion.zip ($sizeKb KB) at repo root."
