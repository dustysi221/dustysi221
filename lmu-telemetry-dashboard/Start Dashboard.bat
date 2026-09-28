@echo off
title LMU Telemetry Dashboard
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. See NOTES\01 One-time setup.txt
  pause
  exit /b 1
)

if not exist node_modules (
  echo First run: installing dependencies...
  call npm.cmd install
  if errorlevel 1 (
    echo npm install failed. See NOTES\08 Troubleshooting.txt
    pause
    exit /b 1
  )
)

rem Already running? Then just open the page instead of starting a second copy.
curl -s -o nul http://localhost:3000/api/health >nul 2>nul
if not errorlevel 1 (
  echo The dashboard is already running. Opening it...
  start "" http://localhost:3000
  timeout /t 3 >nul
  exit /b 0
)

echo.
echo  LMU Telemetry Dashboard - game mode
echo  Dashboard:     http://localhost:3000
echo  Control Panel: http://localhost:3000/control
echo  Keep this window open. Close it (or use Stop server in the Control Panel) to stop.
echo.
node server.js --open
echo.
echo The server stopped. Read the messages above if this was unexpected.
pause
