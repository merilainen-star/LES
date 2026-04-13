param(
    [string]$FirefoxDir = "LekolarEnhancer",
    [string]$EdgeDir = "LekolarEnhancer-Edge"
)

$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$firefoxPath = Join-Path $repoRoot $FirefoxDir
$edgePath = Join-Path $repoRoot $EdgeDir

if (-not (Test-Path -LiteralPath $firefoxPath)) {
    throw "Firefox source folder not found: $firefoxPath"
}

if (-not (Test-Path -LiteralPath $edgePath)) {
    throw "Edge target folder not found: $edgePath"
}

$filesToCopy = @(
    "background.js",
    "content.js",
    "popup.html",
    "popup.js",
    "popup.css",
    "searchUtils.js",
    "style.css",
    "logo.png"
)

foreach ($relativeFile in $filesToCopy) {
    $sourceFile = Join-Path $firefoxPath $relativeFile
    $targetFile = Join-Path $edgePath $relativeFile

    if (-not (Test-Path -LiteralPath $sourceFile)) {
        throw "Missing source file: $sourceFile"
    }

    Copy-Item -LiteralPath $sourceFile -Destination $targetFile -Force
    Write-Host "Synced $relativeFile"
}

Write-Host "Creating zip package for Edge..."
$zipPath = Join-Path $repoRoot "edge-extension.zip"
Compress-Archive -Path "$edgePath\*" -DestinationPath $zipPath -Force
Write-Host "Created $zipPath"

Write-Host "Edge variant sync complete."
