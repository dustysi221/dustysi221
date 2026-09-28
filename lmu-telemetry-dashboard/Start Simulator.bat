@echo off
title LMU Telemetry Dashboard - SIMULATOR
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

echo.
echo  SIMULATOR MODE - a fake car, no game needed
echo  Dashboard: http://localhost:3000
echo  Keep this window open. Close it to stop.
echo.
start "" http://localhost:3000
node server.js --mock
echo.
echo The server stopped. Read the messages above if this was unexpected.
pause
