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
    "defaults.js",
    "background.js",
    "content.js",
    "popup.html",
    "popup.js",
    "popup.css",
    "options.html",
    "options.js",
    "options.css",
    "cryptoVault.js",
    "facetVocabulary.js",
    "categoryClassifier.js",
    "aiPrompt.js",
    "aiProviders.js",
    "searchUtils.js",
    "style.css",
    "logo.png",
    "CHANGELOG.md",
    "README.md"
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

$edgeOptionsPath = Join-Path $edgePath "options.html"
$edgeOptions = Get-Content -LiteralPath $edgeOptionsPath -Raw
$edgeOptions = $edgeOptions `
    -replace "<h3>Firefox Add-ons</h3>", "<h3>Edge Add-ons</h3>" `
    -replace "Open the Firefox add-on page on Mozilla Add-ons\.", "Open the Edge add-on page on Microsoft Edge Add-ons." `
    -replace "https://addons.mozilla.org/en-US/developers/addon/778ccbb63fa64c838515/edit", "https://microsoftedge.microsoft.com/addons/detail/poiadopjpbekbageflcbghabcidpbjhj" `
    -replace "Open Firefox Add-ons page", "Open Edge Add-ons page"
Set-Content -LiteralPath $edgeOptionsPath -Value $edgeOptions -NoNewline
Write-Host "Applied Edge About-page store link"

Write-Host "Edge variant sync complete."
