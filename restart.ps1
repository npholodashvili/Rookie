# Restart Rookie backend and frontend
$root = $PSScriptRoot

Write-Host "Stopping existing processes..." -ForegroundColor Yellow

$ports = @(3001, 5173)
foreach ($port in $ports) {
    try {
        $conn = Get-NetTCPConnection -LocalPort $port -ErrorAction SilentlyContinue
        $conn | ForEach-Object { $_.OwningProcess } | Sort-Object -Unique | ForEach-Object {
            Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue
            Write-Host "  Stopped process $_ on port $port" -ForegroundColor Gray
        }
    } catch { }
}

Start-Sleep -Seconds 2
Write-Host "Starting Rookie backend and frontend..." -ForegroundColor Cyan

Start-Process powershell -ArgumentList "-NoExit", "-Command", "cd '$root\backend'; npm run dev"
Start-Sleep -Seconds 2
Start-Process powershell -ArgumentList "-NoExit", "-Command", "cd '$root\frontend'; npm run dev"

Write-Host "Backend: http://localhost:3001" -ForegroundColor Green
Write-Host "Frontend: http://localhost:5173" -ForegroundColor Green
