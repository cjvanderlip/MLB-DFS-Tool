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

# Set API keys
$env:ODDS_API_KEY = "a31ed2d99da8a1068c99c2aefb09a2ea"

# Start the server
Write-Host "Starting server..." -ForegroundColor Green
Write-Host ""
Write-Host "Open your browser and navigate to:" -ForegroundColor Yellow
Write-Host "http://localhost:3000" -ForegroundColor Cyan
Write-Host ""
Write-Host "Press Ctrl+C to stop the server" -ForegroundColor Yellow
Write-Host ""

npm start
