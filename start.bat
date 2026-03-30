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

REM Start the server
echo Starting server...
echo.
echo Open your browser and navigate to: http://localhost:3000
echo.
echo Press Ctrl+C to stop the server
echo.

call npm start

pause
