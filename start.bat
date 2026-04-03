@echo off
echo.
echo ========================================
echo   MLB DFS Local Tool Startup
echo ========================================
echo.

REM Check if node_modules exists
if not exist "node_modules" (
    echo Installing dependencies...
    call npm install
    echo.
)

REM Set API keys
set ODDS_API_KEY=a31ed2d99da8a1068c99c2aefb09a2ea

REM Start the server
echo Starting server...
echo.
echo Open your browser and navigate to: http://localhost:3000
echo.
echo Press Ctrl+C to stop the server
echo.

call npm start

pause
