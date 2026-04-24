#!/usr/bin/env pwsh
# scripts/build-edge-zip.ps1
# Packages LekolarEnhancer-Edge/ into edge-extension.zip at the repo root.
# Mirrors what the GitHub Actions workflow does, so you can sanity-check
# the zip locally (and the pre-push git hook invokes this automatically).
#
# Usage:
#   pwsh scripts/build-edge-zip.ps1
#   # or from Windows PowerShell: powershell -File scripts/build-edge-zip.ps1

$ErrorActionPreference = 'Stop'

$repoRoot = (git rev-parse --show-toplevel).Trim()
if (-not $repoRoot) { throw "Not inside a git repository." }

$sourceDir = Join-Path $repoRoot 'LekolarEnhancer-Edge'
$outputZip = Join-Path $repoRoot 'edge-extension.zip'

if (-not (Test-Path $sourceDir)) {
    throw "Edge source folder not found: $sourceDir"
}

if (Test-Path $outputZip) { Remove-Item $outputZip -Force }

# Pack the CONTENTS of LekolarEnhancer-Edge (not the folder itself) so the
# manifest.json ends up at the zip root — which is what the Edge Add-ons
# store expects.
Compress-Archive -Path (Join-Path $sourceDir '*') -DestinationPath $outputZip -Force

$size = (Get-Item $outputZip).Length
$sizeKb = [math]::Round($size / 1KB, 1)
Write-Host "Built edge-extension.zip ($sizeKb KB) at repo root."
