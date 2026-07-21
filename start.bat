@echo off
REM Double-click this file in Explorer to start the monday.com ticker.
cd /d "%~dp0"

where node >nul 2>nul
if %errorlevel% neq 0 (
  echo Node.js isn't installed on this PC.
  echo Install it from https://nodejs.org (LTS version), then double-click this file again.
  pause
  exit /b 1
)

echo Starting monday.com Live Ticker...
start "" http://localhost:4173
node server.js
pause
