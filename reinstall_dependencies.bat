@echo off
setlocal

cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed or not in PATH.
  echo Install Node.js, then run this file again.
  pause
  exit /b 1
)

if exist "node_modules" (
  rmdir /s /q "node_modules"
)

if exist "package-lock.json" (
  del /q "package-lock.json"
)

echo Reinstalling dependencies...
call npm install
if errorlevel 1 (
  echo npm install failed.
  pause
  exit /b 1
)

echo Done.
pause
