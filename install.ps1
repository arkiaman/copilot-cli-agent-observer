param(
    [string]$Repo = "Rogn/copilot-cli-agent-observer",
    [string]$Ref = "master",
    [string]$SourcePath = "",
    [string]$InstallRoot = ""
)

$ErrorActionPreference = "Stop"

$tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("agent-observer-install-" + [System.Guid]::NewGuid())
$zipPath = Join-Path $tempRoot "repo.zip"
$extractRoot = Join-Path $tempRoot "extract"
$installRoot = if ($InstallRoot) { $InstallRoot } else { Join-Path $HOME ".copilot\extensions" }
$targetDir = Join-Path $installRoot "agent-observer"
$archiveUrl = "https://github.com/$Repo/archive/refs/heads/$Ref.zip"

try {
    New-Item -ItemType Directory -Force $tempRoot, $extractRoot, $installRoot | Out-Null

    if ($SourcePath) {
        $sourceDir = Join-Path (Resolve-Path $SourcePath).Path ".github\extensions\agent-observer"
    }
    else {
        Write-Host "Downloading $archiveUrl"
        Invoke-WebRequest -Uri $archiveUrl -OutFile $zipPath

        Expand-Archive -Path $zipPath -DestinationPath $extractRoot -Force

        $repoRoot = Get-ChildItem -Path $extractRoot -Directory | Select-Object -First 1
        if (-not $repoRoot) {
            throw "Could not find extracted repository root."
        }

        $sourceDir = Join-Path $repoRoot.FullName ".github\extensions\agent-observer"
    }

    if (-not (Test-Path $sourceDir)) {
        throw "Extension folder missing: $sourceDir"
    }

    if (Test-Path $targetDir) {
        try {
            Remove-Item -Path $targetDir -Recurse -Force -ErrorAction Stop
        }
        catch {
            Write-Host ""
            Write-Host "ERROR: Cannot remove existing install — files are locked." -ForegroundColor Red
            Write-Host "The native webview binary is likely held open by a running Copilot CLI session." -ForegroundColor Yellow
            Write-Host ""
            Write-Host "Fix: close the Agent Observer window (or exit Copilot CLI), then re-run this script." -ForegroundColor Yellow
            Write-Host ""
            throw "Install aborted: $($_.Exception.Message)"
        }
    }

    Copy-Item -Path $sourceDir -Destination $targetDir -Recurse -Force

    Write-Host "Installed Agent Observer to $targetDir"
    Write-Host ""
    Write-Host "Next steps:"
    Write-Host "  1. Already in Copilot CLI with experimental/extensions enabled?"
    Write-Host "     Ask Copilot to reload extensions (extensions_reload), then run /agent-observer."
    Write-Host "  2. Starting fresh?"
    Write-Host "     Run: copilot --experimental"
    Write-Host "     Then: /env to confirm, /agent-observer to launch."
}
finally {
    if (Test-Path $tempRoot) {
        Remove-Item -Path $tempRoot -Recurse -Force
    }
}
