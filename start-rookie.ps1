#Requires -Version 5.1
<#
.SYNOPSIS
    Preflight checks, then start Rookie backend + frontend (Simmer trading stack).

.DESCRIPTION
    Verifies Node, npm, Python, dependencies, engine CLI, and TypeScript before opening dev servers.
    After launch, polls /health until the backend responds.

.PARAMETER SkipPreflight
    Skip checks; only free ports and start processes (same as legacy start.ps1).

.PARAMETER FullTest
    Run full frontend production build instead of tsc --noEmit only (slower).

.PARAMETER NoBrowser
    Do not open the dashboard URL when ready.

.EXAMPLE
    .\start-rookie.ps1
    .\start-rookie.ps1 -SkipPreflight
#>
param(
    [switch]$SkipPreflight,
    [switch]$FullTest,
    [switch]$NoBrowser
)

$ErrorActionPreference = "Stop"
$root = $PSScriptRoot
Set-Location $root

function Write-Step { param($msg) Write-Host $msg -ForegroundColor Cyan }
function Write-Ok { param($msg) Write-Host "  OK  $msg" -ForegroundColor Green }
function Write-Warn { param($msg) Write-Host "  WARN  $msg" -ForegroundColor Yellow }
function Write-Fail { param($msg) Write-Host "  FAIL  $msg" -ForegroundColor Red }

function Stop-ListenersOnPort {
    param([int]$Port)
    try {
        $pids = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
            Select-Object -ExpandProperty OwningProcess -Unique
        foreach ($procId in $pids) {
            if ($procId -and $procId -gt 0) {
                Write-Host "Stopping PID $procId (port $Port)..." -ForegroundColor Yellow
                Stop-Process -Id $procId -Force -ErrorAction SilentlyContinue
            }
        }
    } catch {
        Write-Host "Port ${Port}: could not query listeners (ok if none)." -ForegroundColor DarkGray
    }
}

function Test-RookiePreflight {
    Write-Step "=== Rookie preflight ==="

    # Toolchain
    foreach ($cmd in @("node", "npm")) {
        $c = Get-Command $cmd -ErrorAction SilentlyContinue
        if (-not $c) { Write-Fail "$cmd not on PATH"; return $false }
        Write-Ok "$cmd found ($(& $cmd -v 2>$null))"
    }
    $py = Get-Command python -ErrorAction SilentlyContinue
    if (-not $py) {
        $py = Get-Command py -ErrorAction SilentlyContinue
        if ($py) { $script:PythonExe = "py" } else { Write-Fail "python/py not on PATH"; return $false }
    } else {
        $script:PythonExe = "python"
    }
    Write-Ok "$($script:PythonExe) found ($(& $script:PythonExe --version 2>&1))"

    # data/ for runtime JSON
    $dataDir = Join-Path $root "data"
    if (-not (Test-Path $dataDir)) {
        New-Item -ItemType Directory -Path $dataDir -Force | Out-Null
        Write-Ok "Created data directory"
    }

    # npm dependencies
    $back = Join-Path $root "backend"
    $front = Join-Path $root "frontend"
    if (-not (Test-Path (Join-Path $back "node_modules"))) {
        Write-Warn "backend/node_modules missing - running npm install..."
        Push-Location $back
        npm install
        if ($LASTEXITCODE -ne 0) { Pop-Location; Write-Fail "backend npm install"; return $false }
        Pop-Location
        Write-Ok "backend dependencies installed"
    } else { Write-Ok "backend node_modules present" }

    if (-not (Test-Path (Join-Path $front "node_modules"))) {
        Write-Warn "frontend/node_modules missing - running npm install..."
        Push-Location $front
        npm install
        if ($LASTEXITCODE -ne 0) { Pop-Location; Write-Fail "frontend npm install"; return $false }
        Pop-Location
        Write-Ok "frontend dependencies installed"
    } else { Write-Ok "frontend node_modules present" }

    # Python engine smoke test (loads .env + data/.env.local via main)
    Write-Step "Engine: python -m engine.src.main state"
    Push-Location $root
    try {
        $engineOut = & $script:PythonExe -m engine.src.main state 2>&1
        if ($LASTEXITCODE -ne 0) {
            Write-Fail "Engine CLI failed (exit $LASTEXITCODE)"
            Write-Host $engineOut
            Write-Host "Fix: pip install -r engine/requirements.txt" -ForegroundColor Yellow
            return $false
        }
        Write-Ok "Engine state command succeeded"
    } finally { Pop-Location }

    # TypeScript / optional full build
    Push-Location $front
    try {
        if ($FullTest) {
            Write-Step "Frontend: npm run build"
            npm run build
            if ($LASTEXITCODE -ne 0) { Write-Fail "frontend build"; return $false }
            Write-Ok "frontend production build"
        } else {
            Write-Step "Frontend: tsc --noEmit"
            npx --yes tsc --noEmit
            if ($LASTEXITCODE -ne 0) { Write-Fail "frontend tsc"; return $false }
            Write-Ok "frontend types OK"
        }
    } finally { Pop-Location }

    # Simmer API key hint (optional)
    $envLocal = Join-Path $dataDir ".env.local"
    $hasKey = $false
    if (Test-Path $envLocal) {
        $hasKey = Select-String -Path $envLocal -Pattern "^\s*SIMMER_API_KEY\s*=" -Quiet
    }
    if (-not $hasKey -and $env:SIMMER_API_KEY) { $hasKey = $true }
    if ($hasKey) {
        Write-Ok "SIMMER_API_KEY appears configured"
    } else {
        Write-Warn "No SIMMER_API_KEY in data\.env.local or env - dashboard will load but live Simmer calls need a key (Settings in UI)."
    }

    Write-Step "=== Preflight passed ==="
    return $true
}

function Wait-BackendReady {
    param([int]$MaxSeconds = 45)
    $url = "http://127.0.0.1:3001/health"
    $deadline = (Get-Date).AddSeconds($MaxSeconds)
    while ((Get-Date) -lt $deadline) {
        try {
            $r = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 3
            if ($r.StatusCode -eq 200) {
                Write-Ok "Backend responding at $url"
                return $true
            }
        } catch { Start-Sleep -Seconds 1 }
    }
    Write-Warn "Backend did not respond within ${MaxSeconds}s - check the backend PowerShell window for errors."
    return $false
}

# --- main ---
if (-not $SkipPreflight) {
    if (-not (Test-RookiePreflight)) {
        Write-Host "`nPreflight failed. Fix errors above, or use -SkipPreflight to start anyway.`n" -ForegroundColor Red
        exit 1
    }
} else {
    Write-Warn "Skipping preflight (-SkipPreflight)"
}

Write-Step "Freeing ports 3001 and 5173..."
Stop-ListenersOnPort 3001
Stop-ListenersOnPort 5173
Start-Sleep -Seconds 1

Write-Step "Starting backend (new window)..."
Start-Process powershell -ArgumentList "-NoExit", "-Command", "Set-Location '$root\backend'; npm run dev"
Start-Sleep -Seconds 2

Write-Step "Starting frontend (new window)..."
Start-Process powershell -ArgumentList "-NoExit", "-Command", "Set-Location '$root\frontend'; npm run dev"

Write-Step "Waiting for backend..."
$ready = Wait-BackendReady -MaxSeconds 45

Write-Host ""
Write-Host "Backend:  http://localhost:3001" -ForegroundColor Green
Write-Host "Frontend: http://localhost:5173" -ForegroundColor Green
Write-Host "Health:   http://localhost:3001/health" -ForegroundColor DarkGray
Write-Host ""

if ($ready -and -not $NoBrowser) {
    Start-Process "http://localhost:5173"
}

exit 0
