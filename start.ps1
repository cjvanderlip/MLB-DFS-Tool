# Pass -DebugMode to enable verbose server logging: .\start.ps1 -DebugMode
# (Named DebugMode rather than Debug to avoid PowerShell's common -Debug parameter.)
param([switch]$DebugMode)

Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "   MLB DFS Local Tool Startup" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

# Check if node_modules exists
if (-not (Test-Path "node_modules")) {
    Write-Host "Installing dependencies..." -ForegroundColor Yellow
    npm install
    Write-Host ""
}

# API keys loaded from .env file automatically by dotenv

if ($DebugMode) {
    $env:DEBUG = 'true'
    Write-Host "DEBUG mode ENABLED - server will log requests, fetches, and cache events." -ForegroundColor Magenta
    Write-Host ""
}

# Start the server
Write-Host "Starting server..." -ForegroundColor Green
Write-Host ""
Write-Host "Open your browser and navigate to:" -ForegroundColor Yellow
Write-Host "http://localhost:3000" -ForegroundColor Cyan
Write-Host ""
Write-Host "Press Ctrl+C to stop the server" -ForegroundColor Yellow
if (-not $DebugMode) {
    Write-Host "Tip: run '.\start.ps1 -DebugMode' for verbose logging." -ForegroundColor DarkGray
}
Write-Host ""

npm start
