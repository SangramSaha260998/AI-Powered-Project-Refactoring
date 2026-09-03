@echo off
echo ============================================
echo   AI Migration Studio - Server Launcher
echo ============================================
echo.

cd /d "%~dp0server"

echo [1/2] Installing dependencies (if needed)...
call npm install --silent 2>nul

echo.
echo [2/2] Starting Express server on port 5000...
echo.
echo   Press Ctrl+C to stop the server
echo ============================================
echo.

node src/server.js

pause
