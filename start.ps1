# Start Rookie backend and frontend
$root = $PSScriptRoot

function Stop-ListenersOnPort {
    param([int]$Port)
    try {
        $pids = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
            Select-Object -ExpandProperty OwningProcess -Unique
        foreach ($procId in $pids) {
            if ($procId -and $procId -gt 0) {
                Write-Host "Stopping PID $procId (was listening on port $Port)..." -ForegroundColor Yellow
                Stop-Process -Id $procId -Force -ErrorAction SilentlyContinue
            }
        }
    } catch {
        Write-Host "Could not query/stop listeners on port $Port (ok if none)." -ForegroundColor DarkGray
    }
}

Write-Host "Starting Rookie backend and frontend..." -ForegroundColor Cyan
Write-Host "Freeing ports 3001 and 5173 so only one backend/frontend runs..." -ForegroundColor DarkGray
Stop-ListenersOnPort 3001
Stop-ListenersOnPort 5173
Start-Sleep -Seconds 1

Start-Process powershell -ArgumentList "-NoExit", "-Command", "cd '$root\backend'; npm run dev"
Start-Sleep -Seconds 2
Start-Process powershell -ArgumentList "-NoExit", "-Command", "cd '$root\frontend'; npm run dev"

Write-Host "Backend: http://localhost:3001" -ForegroundColor Green
Write-Host "Frontend: http://localhost:5173" -ForegroundColor Green
