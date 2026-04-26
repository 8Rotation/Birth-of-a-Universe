@echo off
cd /d "%~dp0"
echo Starting Birth of a Universe...
echo.
echo   The browser will open automatically when the server is ready.
echo   Keep this window open -- closing it will stop the server.
echo   Press Ctrl+C to shut down.
echo.
npx vite --open
pause
