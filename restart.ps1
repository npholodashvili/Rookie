# Stop listeners on dev ports, then full start with preflight
$root = $PSScriptRoot

Write-Host "Stopping processes on ports 3001, 5173..." -ForegroundColor Yellow
foreach ($port in @(3001, 5173)) {
    try {
        Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue |
            ForEach-Object { $_.OwningProcess } | Sort-Object -Unique |
            ForEach-Object {
                if ($_ -gt 0) {
                    Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue
                    Write-Host "  Stopped PID $_ (port $port)" -ForegroundColor Gray
                }
            }
    } catch { }
}

Start-Sleep -Seconds 2
& "$root\start-rookie.ps1" @args
