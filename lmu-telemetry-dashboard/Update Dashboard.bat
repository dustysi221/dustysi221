@echo off
title Update LMU Telemetry Dashboard
cd /d "%~dp0"

echo Downloading the latest version...
git pull
if errorlevel 1 (
  echo.
  echo Update failed. See NOTES\09 Updating to the latest version.txt
  pause
  exit /b 1
)

echo.
echo Installing any new dependencies...
call npm.cmd install
if errorlevel 1 (
  echo npm install failed. See NOTES\08 Troubleshooting.txt
  pause
  exit /b 1
)

echo.
echo Up to date. Start the dashboard again with "Start Dashboard.bat".
pause
