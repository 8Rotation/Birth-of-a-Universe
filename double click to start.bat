@echo off
cd /d "%~dp0"
echo Starting Vite dev server...

REM Start Vite in background (no auto-open)
start /B npx vite

REM Wait until the server is actually responding
:wait
timeout /t 2 /nobreak >nul
curl -s -o nul http://localhost:5173/ 2>nul
if errorlevel 1 (
    echo   Waiting for server...
    goto wait
)

REM Server is ready — open browser
echo Server ready! Opening browser...
start "" http://localhost:5173/

REM Keep window open so Vite keeps running
echo Press Ctrl+C to stop the server.
pause >nul
