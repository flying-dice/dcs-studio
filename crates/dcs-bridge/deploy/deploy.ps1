<#
.SYNOPSIS
Builds dcs_bridge.dll and installs it + the DcsStudio.lua GameGUI hook into the
DCS Saved Games write dir. Idempotent: safe to re-run after every rebuild.

.PARAMETER WriteDir
Override the DCS write dir (e.g. a custom -w folder). When omitted, the script
checks "%USERPROFILE%\Saved Games\DCS" then "...\DCS.openbeta".

.EXAMPLE
.\deploy.ps1
.\deploy.ps1 -WriteDir "D:\SavedGames\DCS.custom"
#>
param(
    [string]$WriteDir
)

$ErrorActionPreference = "Stop"

# deploy.ps1 lives at <repo>\crates\dcs-bridge\deploy\ -> repo root is three up.
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..\..")).Path

# 1. Build the DLL (root .cargo/config.toml supplies LUA_LIB/LUA_LIB_NAME).
Write-Host "Building dcs-bridge (release) in $repoRoot ..."
Push-Location $repoRoot
try {
    cargo build -p dcs-bridge --release
    if ($LASTEXITCODE -ne 0) { throw "cargo build -p dcs-bridge --release failed (exit $LASTEXITCODE)" }
}
finally {
    Pop-Location
}

$dll = Join-Path $repoRoot "target\release\dcs_bridge.dll"
if (-not (Test-Path $dll)) { throw "Build succeeded but '$dll' was not found" }

# 2. Locate the DCS write dir.
if ($WriteDir) {
    if (-not (Test-Path $WriteDir)) { throw "Specified -WriteDir '$WriteDir' does not exist" }
}
else {
    $candidates = @(
        (Join-Path $env:USERPROFILE "Saved Games\DCS"),
        (Join-Path $env:USERPROFILE "Saved Games\DCS.openbeta")
    )
    $WriteDir = $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1
    if (-not $WriteDir) {
        throw "No DCS write dir found (checked: $($candidates -join '; ')). Pass -WriteDir to override."
    }
}
Write-Host "Using DCS write dir: $WriteDir"

# 3. Copy the DLL and the hook (creating directories as needed).
$binDir = Join-Path $WriteDir "Mods\tech\DcsStudio\bin"
$hooksDir = Join-Path $WriteDir "Scripts\Hooks"
New-Item -ItemType Directory -Force -Path $binDir | Out-Null
New-Item -ItemType Directory -Force -Path $hooksDir | Out-Null

$dllTarget = Join-Path $binDir "dcs_bridge.dll"
$hookSource = Join-Path $PSScriptRoot "Scripts\Hooks\DcsStudio.lua"
$hookTarget = Join-Path $hooksDir "DcsStudio.lua"

Copy-Item -Path $dll -Destination $dllTarget -Force
Write-Host "Copied $dll -> $dllTarget"

Copy-Item -Path $hookSource -Destination $hookTarget -Force
Write-Host "Copied $hookSource -> $hookTarget"

Write-Host "Done. Restart DCS to (re)load the bridge; it listens on ws://127.0.0.1:25569/ws."
