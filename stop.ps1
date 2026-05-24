$proc = Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue |
        Select-Object -ExpandProperty OwningProcess |
        Select-Object -First 1

if ($proc) {
    $name = (Get-Process -Id $proc -ErrorAction SilentlyContinue).ProcessName
    Stop-Process -Id $proc -Force
    Write-Host "Stopped process $proc ($name) on port 3000." -ForegroundColor Green
} else {
    Write-Host "No process found listening on port 3000." -ForegroundColor Yellow
}
