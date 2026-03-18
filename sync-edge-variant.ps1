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

$firefoxContentPath = Join-Path $firefoxPath "content.js"
$edgeContentPath = Join-Path $edgePath "content.js"

if (-not (Test-Path -LiteralPath $firefoxContentPath)) {
    throw "Missing source content script: $firefoxContentPath"
}

$firefoxContent = [System.IO.File]::ReadAllText($firefoxContentPath)
$startCount = ([regex]::Matches($firefoxContent, "@FIREFOX_ONLY_START")).Count
$endCount = ([regex]::Matches($firefoxContent, "@FIREFOX_ONLY_END")).Count

if ($startCount -ne $endCount) {
    throw "Unbalanced Firefox-only markers in content.js (start=$startCount, end=$endCount)."
}

$pattern = '(?ms)^[ \t]*//\s*@FIREFOX_ONLY_START[^\r\n]*\r?\n.*?^[ \t]*//\s*@FIREFOX_ONLY_END[^\r\n]*\r?\n?'
$edgeContent = [regex]::Replace($firefoxContent, $pattern, "")
[System.IO.File]::WriteAllText($edgeContentPath, $edgeContent, [System.Text.UTF8Encoding]::new($false))

Write-Host "Generated content.js for Edge without Firefox-only blocks."
Write-Host "Edge variant sync complete."
