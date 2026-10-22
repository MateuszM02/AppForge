# AppForge installer for Windows 10/11.
#
#   irm https://raw.githubusercontent.com/MateuszM02/AppForge/main/install.ps1 | iex
#
# or, from a downloaded copy (git clone or ZIP):
#
#   powershell -ExecutionPolicy Bypass -File AppForge\install.ps1
#
# What it does (nothing needs administrator rights):
#   1. Gets AppForge: uses the folder this script is in, else clones / downloads it to %LOCALAPPDATA%\AppForge\app.
#   2. Puts a private Node.js 24 LTS in %LOCALAPPDATA%\AppForge\node (checked against nodejs.org's SHA-256 list);
#      your own Node, if any, is not touched.
#   3. Installs the dependencies and builds AppForge (only when the version changed).
#   4. Downloads the Camoufox browser (~300 MB) and two ranking models (~180 MB).
#   5. Adds the `appforge` command (%USERPROFILE%\.local\bin) and registers AppForge in VS Code and Claude Code.
#   6. Offers to install the GitHub CLI and log in (needed for repo_search).
# Safe to re-run to update. uninstall.ps1 removes it all again.
#
# Environment variables:
#   APPFORGE_MINIMAL=1       skip step 4 (downloads happen on first use or with `appforge setup`)
#   APPFORGE_AUTO_INSTALL=1  install the GitHub CLI without asking
#   APPFORGE_NO_EXTRAS=1     never offer the GitHub CLI
#   APPFORGE_NO_REGISTER=1   do not change VS Code / Claude Code settings
#   APPFORGE_DIR             where to put AppForge when this script is not inside a copy of it
#   APPFORGE_REF             branch or tag to download (default main)

& {
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"   # Invoke-WebRequest is many times faster without the progress bar

$repo = "MateuszM02/AppForge"
$ref = if ($env:APPFORGE_REF) { $env:APPFORGE_REF } else { "main" }
$base = Join-Path $env:LOCALAPPDATA "AppForge"
$nodeDir = Join-Path $base "node"
$toolBin = Join-Path $env:USERPROFILE ".local\bin"

function Test-Command($name) { [bool](Get-Command $name -ErrorAction SilentlyContinue) }

# Yes/no question (default yes). Never blocks when nobody can answer.
function Confirm-Step([string]$question) {
    if ($env:APPFORGE_AUTO_INSTALL -eq "1") { return $true }
    if (-not [Environment]::UserInteractive -or [Console]::IsInputRedirected) { return $false }
    $answer = Read-Host "$question [Y/n]"
    return -not ($answer -match "^\s*n(o)?\s*$")
}

# Make tools installed during this run visible without opening a new terminal.
function Update-SessionPath {
    $sep = [IO.Path]::PathSeparator
    $parts = @($toolBin)
    foreach ($scope in "Machine", "User") {
        $value = [Environment]::GetEnvironmentVariable("Path", $scope)
        if ($value) { $parts += $value -split [regex]::Escape($sep) }
    }
    $parts += $env:PATH -split [regex]::Escape($sep)
    $env:PATH = (($parts | Where-Object { $_ } | Select-Object -Unique) -join $sep)
}

function Get-AppDir {
    $here = $PSScriptRoot
    if ($here -and (Test-Path (Join-Path $here "package.json")) -and ((Get-Content (Join-Path $here "package.json") -Raw) -match '"name":\s*"appforge"')) {
        Write-Host "Using AppForge in $here"
        return $here
    }
    $dir = if ($env:APPFORGE_DIR) { $env:APPFORGE_DIR } else { Join-Path $base "app" }
    if (Test-Path (Join-Path $dir ".git")) {
        Write-Host "Updating AppForge in $dir (git pull)..."
        git -C $dir pull --ff-only
        if ($LASTEXITCODE -ne 0) { throw "git pull failed in $dir" }
    } elseif (Test-Command git) {
        if (Test-Path $dir) { Remove-Item -Recurse -Force $dir }
        Write-Host "Downloading AppForge to $dir (git clone)..."
        git clone --depth 1 --branch $ref "https://github.com/$repo.git" $dir
        if ($LASTEXITCODE -ne 0) { throw "git clone failed" }
    } else {
        Write-Host "Downloading AppForge to $dir..."
        $zip = Join-Path ([IO.Path]::GetTempPath()) "appforge-$ref.zip"
        $tmp = Join-Path ([IO.Path]::GetTempPath()) "appforge-$ref-unzip"
        Invoke-WebRequest "https://codeload.github.com/$repo/zip/refs/heads/$ref" -OutFile $zip -UseBasicParsing
        if (Test-Path $tmp) { Remove-Item -Recurse -Force $tmp }
        Expand-Archive $zip -DestinationPath $tmp -Force
        $inner = Get-ChildItem $tmp -Directory | Select-Object -First 1
        # Keep the old build (node_modules, dist) out of the way of the new files, then drop it.
        if (Test-Path $dir) { Remove-Item -Recurse -Force $dir }
        New-Item -ItemType Directory -Force (Split-Path $dir) | Out-Null
        Move-Item $inner.FullName $dir
        Remove-Item -Recurse -Force $tmp, $zip -ErrorAction SilentlyContinue
    }
    return $dir
}

# Private Node.js 24 LTS. Re-used when it is already there and still a 24.x.
function Install-Node {
    $exe = Join-Path $nodeDir "node.exe"
    if (Test-Path $exe) {
        $v = (& $exe --version) 2>$null
        if ($v -match '^v24\.') { Write-Host "Node.js $v (private copy) is ready."; return $exe }
    }
    $arch = if ($env:PROCESSOR_ARCHITECTURE -eq "ARM64") { "arm64" } else { "x64" }
    Write-Host "Downloading Node.js 24 LTS ($arch)..."
    $index = Invoke-RestMethod "https://nodejs.org/dist/index.json"
    $version = ($index | Where-Object { $_.version -like "v24.*" -and $_.lts } | Select-Object -First 1).version
    if (-not $version) { throw "Could not find a Node.js 24 LTS release on nodejs.org" }
    $name = "node-$version-win-$arch"
    $zip = Join-Path ([IO.Path]::GetTempPath()) "$name.zip"
    Invoke-WebRequest "https://nodejs.org/dist/$version/$name.zip" -OutFile $zip -UseBasicParsing
    $sums = (Invoke-WebRequest "https://nodejs.org/dist/$version/SHASUMS256.txt" -UseBasicParsing).Content
    $expected = (($sums -split "`n") | Where-Object { $_ -match " $name\.zip$" } | Select-Object -First 1) -split '\s+' | Select-Object -First 1
    $actual = (Get-FileHash $zip -Algorithm SHA256).Hash.ToLower()
    if (-not $expected -or $expected -ne $actual) { Remove-Item $zip; throw "Node.js download is corrupt (SHA-256 mismatch)" }
    $tmp = Join-Path $base "node-new"
    if (Test-Path $tmp) { Remove-Item -Recurse -Force $tmp }
    Expand-Archive $zip -DestinationPath $tmp -Force
    Remove-Item $zip
    if (Test-Path $nodeDir) { Remove-Item -Recurse -Force $nodeDir }
    Move-Item (Join-Path $tmp $name) $nodeDir
    Remove-Item -Recurse -Force $tmp
    Write-Host "Node.js $version installed in $nodeDir"
    return $exe
}

function Get-Json([string]$file) {
    if (Test-Path $file) { return Get-Content $file -Raw | ConvertFrom-Json }
    return $null
}

# npm install + build, only when the version in the folder differs from the last build (or nothing is built).
function Build-AppForge([string]$dir, [string]$node) {
    $pkg = Get-Json (Join-Path $dir "package.json")
    $built = Get-Json (Join-Path $dir "dist\build.json")
    $npm = Join-Path $nodeDir "node_modules\npm\bin\npm-cli.js"
    $env:CAMOFOX_SKIP_DOWNLOAD = "1"   # `appforge setup browser` downloads it below, with progress
    $env:PATH = "$nodeDir;$env:PATH"   # npm runs scripts with this node
    if ($built -and $built.version -eq $pkg.version -and (Test-Path (Join-Path $dir "node_modules"))) {
        Write-Host "AppForge $($pkg.version) is already built."
        return
    }
    $was = if ($built) { $built.version } else { "none" }
    Write-Host "Installing AppForge $($pkg.version) (built before: $was)..."
    Push-Location $dir
    try {
        & $node $npm ci --no-audit --no-fund --loglevel=error
        if ($LASTEXITCODE -ne 0) { throw "npm ci failed" }
        & $node $npm run build --silent
        if ($LASTEXITCODE -ne 0) { throw "build failed" }
    } finally { Pop-Location }
}

function Install-Shim([string]$dir, [string]$node) {
    New-Item -ItemType Directory -Force $toolBin | Out-Null
    $cli = Join-Path $dir "dist\server\src\cli.js"
    Set-Content -Path (Join-Path $toolBin "appforge.cmd") -Encoding ascii -Value "@`"$node`" `"$cli`" %*"
    $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
    if (-not (($userPath -split ";") -contains $toolBin)) {
        [Environment]::SetEnvironmentVariable("Path", (($userPath, $toolBin) | Where-Object { $_ }) -join ";", "User")
        Write-Host "Added $toolBin to your PATH (new terminals will find 'appforge')."
    }
    Update-SessionPath
}

function Invoke-Extras {
    if ($env:APPFORGE_NO_EXTRAS -eq "1") { return }
    if (-not (Test-Command gh)) {
        Write-Host ""
        Write-Host "The GitHub CLI (gh) is not installed. repo_search needs a GitHub login (5,000 requests an hour instead of 60);"
        Write-Host "the rest of AppForge works without it. You can also set a GITHUB_TOKEN environment variable instead."
        if ((Test-Command winget) -and (Confirm-Step "Install the GitHub CLI now?")) {
            winget install --id GitHub.cli -e --source winget --silent --accept-package-agreements --accept-source-agreements
            Update-SessionPath
            $ghDir = Join-Path $env:ProgramFiles "GitHub CLI"
            if (Test-Path $ghDir) { $env:PATH = "$ghDir;$env:PATH" }
        } elseif (-not (Test-Command winget)) {
            Write-Host "Install it from https://cli.github.com, then run: gh auth login"
        }
    }
    if ((Test-Command gh) -and -not $env:GITHUB_TOKEN) {
        gh auth status *> $null
        if ($LASTEXITCODE -ne 0) {
            Write-Host ""
            if ($env:APPFORGE_AUTO_INSTALL -eq "1") {
                Write-Host "Run 'gh auth login' to let repo_search use your GitHub account."
            } elseif (Confirm-Step "Log in to GitHub now? (opens your browser; read-only use)") {
                gh auth login --web --git-protocol https
                if ($LASTEXITCODE -ne 0) { Write-Warning "Login did not finish. Run 'gh auth login' later." }
            } else {
                Write-Host "Skipped. Run 'gh auth login' later to use repo_search."
            }
        }
    }
}

$dir = Get-AppDir
$node = Install-Node
Build-AppForge $dir $node
Install-Shim $dir $node

if ($env:APPFORGE_MINIMAL -ne "1") {
    & $node (Join-Path $dir "dist\server\src\cli.js") setup all
    if ($LASTEXITCODE -ne 0) { Write-Warning "Some downloads failed; retry later with: appforge setup" }
}

Invoke-Extras

if ($env:APPFORGE_NO_REGISTER -ne "1") {
    Write-Host ""
    & $node (Join-Path $dir "dist\server\src\cli.js") register all
}

Write-Host ""
& $node (Join-Path $dir "dist\server\src\cli.js") doctor
Write-Host ""
Write-Host "Done. Open VS Code (or Claude Code), start a chat in agent mode and ask, e.g.:"
Write-Host "  'Use AppForge to find an open-source habit tracker I can extend.'"
Write-Host "In VS Code you may need to confirm the AppForge server once (Extensions view > MCP SERVERS, or the chat tools menu)."
}
