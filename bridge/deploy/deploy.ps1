<#
.SYNOPSIS
Builds both bridge DLLs (dcs_studio_gui.dll + dcs_studio_mission.dll) and
installs them + the DcsStudio.lua GameGUI hook into the DCS Saved Games write
dir. Idempotent: safe to re-run after every rebuild — but DCS must be CLOSED
(it file-locks the DLLs once loaded; the mission DLL from the first mission
until the process exits).

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

# deploy.ps1 lives at <repo>\bridge\deploy\ -> the cargo workspace is one up at
# <repo>\bridge (its .cargo/config.toml supplies LUA_LIB/LUA_LIB_NAME).
$workspace = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path

# 1. Build both DLLs.
Write-Host "Building the bridge workspace (release) in $workspace ..."
Push-Location $workspace
try {
    cargo build --release -p dcs-bridge-gui -p dcs-bridge-mission
    if ($LASTEXITCODE -ne 0) { throw "cargo build --release failed (exit $LASTEXITCODE)" }
}
finally {
    Pop-Location
}

$dlls = @("dcs_studio_gui.dll", "dcs_studio_mission.dll") | ForEach-Object {
    $p = Join-Path $workspace "target\release\$_"
    if (-not (Test-Path $p)) { throw "Build succeeded but '$p' was not found" }
    $p
}

# 2. Locate the DCS write dir.
if ($WriteDir) {
    if (-not (Test-Path $WriteDir)) { throw "Specified -WriteDir '$WriteDir' does not exist" }
}
else {
    $candidates = @(
        (Join-Path $env:USERPROFILE "Saved Games\DCS"),
        (Join-Path $env:USERPROFILE "Saved Games\DCS.openbeta")
    ) | Where-Object { Test-Path $_ }
    if (-not $candidates) {
        throw "No DCS write dir found under '$env:USERPROFILE\Saved Games'. Pass -WriteDir to override."
    }
    # Both stable and openbeta dirs can coexist; the LIVE one is the dir whose
    # dcs.log was written most recently — first-existing would guess wrong.
    $WriteDir = $candidates |
        Sort-Object { $log = Join-Path $_ "Logs\dcs.log"; if (Test-Path $log) { (Get-Item $log).LastWriteTime } else { [datetime]::MinValue } } -Descending |
        Select-Object -First 1
}
Write-Host "Using DCS write dir: $WriteDir"

# 3. Copy the DLLs and the hook (creating directories as needed). A locked DLL
#    means DCS is running — surface that instead of a raw IO error.
#
# LOCKSTEP: this install layout (DLL names above, Mods\tech\DcsStudio\bin,
# Scripts\Hooks\DcsStudio.lua, and the stale artifacts below) is also encoded in
# src/core/domain/bridgeDeploy.ts, which the extension's inject/eject use. The
# two runtimes (PowerShell dev-deploy vs. the TS extension) can't share a
# constant — change one, change the other.
$binDir = Join-Path $WriteDir "Mods\tech\DcsStudio\bin"
$hooksDir = Join-Path $WriteDir "Scripts\Hooks"
New-Item -ItemType Directory -Force -Path $binDir | Out-Null
New-Item -ItemType Directory -Force -Path $hooksDir | Out-Null

foreach ($dll in $dlls) {
    $target = Join-Path $binDir (Split-Path $dll -Leaf)
    try {
        Copy-Item -Path $dll -Destination $target -Force -ErrorAction Stop
    }
    catch {
        throw "Cannot overwrite $target - DCS appears to be running (it locks the loaded DLLs). Close DCS and re-run. ($_)"
    }
    Write-Host "Copied $dll -> $target"
}

# Drop stale single-DLL-era artifacts: the old DLL names (they'd bind port
# 25569 too) and the generated mission boot file the old hook wrote.
$stale = @(
    (Join-Path $binDir "dcs_studio.dll"),
    (Join-Path $binDir "dcs_bridge.dll"),
    (Join-Path $WriteDir "Scripts\DcsStudioMission.lua")
)
foreach ($p in $stale) {
    if (Test-Path $p) {
        Remove-Item -Path $p -Force
        Write-Host "Removed stale $p"
    }
}

# The canonical hook lives in bridge\hook (what the extension ships).
$hookSource = Join-Path $workspace "hook\DcsStudio.lua"
$hookTarget = Join-Path $hooksDir "DcsStudio.lua"
Copy-Item -Path $hookSource -Destination $hookTarget -Force
Write-Host "Copied $hookSource -> $hookTarget"

# 4. Note the MissionScripting.lua prerequisite for the mission bridge.
Write-Host ""
Write-Host "Done. Restart DCS to (re)load the bridges:"
Write-Host "  GUI bridge:     ws://127.0.0.1:25569/ws  (POST /rpc, GET /health) - up whenever DCS runs"
Write-Host "  Mission bridge: ws://127.0.0.1:25570/ws  (POST /rpc, GET /health) - boots at mission start"
Write-Host "The mission bridge needs a desanitized MissionScripting.lua (VS Code command:"
Write-Host "'DCS Studio: Desanitize MissionScripting.lua'); otherwise its boot logs an error to dcs.log."
