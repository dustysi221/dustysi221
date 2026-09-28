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

echo.
echo  LMU Telemetry Dashboard
echo  Dashboard: http://localhost:3000
echo  Keep this window open while you race. Close it to stop the dashboard.
echo.
start "" http://localhost:3000
node server.js
echo.
echo The server stopped. Read the messages above if this was unexpected.
pause
