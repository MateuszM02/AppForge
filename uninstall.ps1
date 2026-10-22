# AppForge uninstaller for Windows: reverses install.ps1.
#
#   powershell -ExecutionPolicy Bypass -File AppForge\uninstall.ps1
#   (or: irm https://raw.githubusercontent.com/MateuszM02/AppForge/main/uninstall.ps1 | iex)
#
# Always removes: the VS Code / Claude Code registrations, the `appforge` command, the private Node.js, the downloaded
# copy of AppForge in %LOCALAPPDATA%\AppForge\app, caches, models, browser profiles and APPFORGE_* environment variables.
# Asks first (Enter = yes) before deleting your memory and settings, and before deleting the Camoufox browser
# (other programs may use it). A folder you cloned yourself is left alone; delete it when you like.
# APPFORGE_AUTO_UNINSTALL=1 answers yes to everything.

& {
$ErrorActionPreference = "Continue"
$base = Join-Path $env:LOCALAPPDATA "AppForge"
$nodeDir = Join-Path $base "node"
$toolBin = Join-Path $env:USERPROFILE ".local\bin"

function Confirm-Step([string]$question) {
    if ($env:APPFORGE_AUTO_UNINSTALL -eq "1") { return $true }
    if (-not [Environment]::UserInteractive -or [Console]::IsInputRedirected) { return $false }
    $answer = Read-Host "$question [Y/n]"
    return -not ($answer -match "^\s*n(o)?\s*$")
}

function Remove-IfThere([string]$path) {
    if (Test-Path $path) { Remove-Item -Recurse -Force $path -ErrorAction SilentlyContinue; Write-Host "Removed $path" }
}

# Where is the built CLI? The folder this script is in, else the downloaded copy.
$cli = $null
foreach ($d in @($PSScriptRoot, (Join-Path $base "app"))) {
    if ($d -and (Test-Path (Join-Path $d "dist\server\src\cli.js"))) { $cli = Join-Path $d "dist\server\src\cli.js"; break }
}
$node = Join-Path $nodeDir "node.exe"
if ($cli -and (Test-Path $node)) {
    & $node $cli unregister all
} else {
    Write-Host "AppForge's CLI is not there; remove 'appforge' from VS Code's mcp.json and 'claude mcp remove appforge' by hand if needed."
}

# Stop a running AppForge (its browser server too) so its files can be deleted.
Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($nodeDir) } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }

Remove-IfThere (Join-Path $toolBin "appforge.cmd")
if ((Test-Path $toolBin) -and -not (Get-ChildItem $toolBin -Force)) {
    Remove-Item $toolBin
    $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
    [Environment]::SetEnvironmentVariable("Path", (($userPath -split ";") | Where-Object { $_ -and $_ -ne $toolBin }) -join ";", "User")
    Write-Host "Removed $toolBin from your PATH (it was empty)."
}

foreach ($name in [Environment]::GetEnvironmentVariables("User").Keys) {
    if ($name -like "APPFORGE_*") { [Environment]::SetEnvironmentVariable($name, $null, "User"); Write-Host "Removed environment variable $name" }
}

foreach ($sub in "app", "node", "cache", "models", "browser", "logs", "node-new") { Remove-IfThere (Join-Path $base $sub) }

if ((Test-Path (Join-Path $base "memory")) -or (Test-Path (Join-Path $base "config.json"))) {
    if (Confirm-Step "Delete your AppForge memory and settings in $base?") {
        Remove-IfThere (Join-Path $base "memory")
        Remove-IfThere (Join-Path $base "config.json")
    } else {
        Write-Host "Kept $base\memory and config.json; a later install uses them again."
    }
}
if ((Test-Path $base) -and -not (Get-ChildItem $base -Force)) { Remove-Item $base }

$camoufox = Join-Path $env:LOCALAPPDATA "camoufox"
if ((Test-Path $camoufox) -and (Confirm-Step "Delete the Camoufox browser download ($camoufox, ~300 MB; other camofox tools use it too)?")) {
    Remove-IfThere $camoufox
}

Write-Host ""
if ($PSScriptRoot -and $PSScriptRoot -ne (Join-Path $base "app")) {
    Write-Host "AppForge is uninstalled. You can now delete the folder $PSScriptRoot."
} else {
    Write-Host "AppForge is uninstalled."
}
}
