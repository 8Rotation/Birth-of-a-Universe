@echo off
title Birth of a Universe - 3D Illustration
echo.
echo  Starting local server for Birth of a Universe 3D Illustration...
echo  Opening in your default browser shortly...
echo.
echo  Press Ctrl+C or close this window to stop the server.
echo.

:: Try Python 3 first, then Python 2, then npx
where python >nul 2>&1
if %errorlevel%==0 (
    start "" "http://localhost:8080"
    python -m http.server 8080
    goto :eof
)

where python3 >nul 2>&1
if %errorlevel%==0 (
    start "" "http://localhost:8080"
    python3 -m http.server 8080
    goto :eof
)

where npx >nul 2>&1
if %errorlevel%==0 (
    start "" "http://localhost:8080"
    npx serve -l 8080
    goto :eof
)

echo ERROR: Could not find Python or Node.js to start a local server.
echo Please install Python (https://python.org) or Node.js (https://nodejs.org)
pause
