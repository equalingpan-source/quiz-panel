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

if not exist "package.json" (
  echo package.json not found.
  echo Please run this file inside the quiz-panel folder.
  pause
  exit /b 1
)

if not exist "node_modules\express" (
  echo Installing dependencies...
  call npm install
  if errorlevel 1 (
    echo npm install failed.
    pause
    exit /b 1
  )
)

echo Starting server...
start "" http://localhost:3000/host.html
call npm start

echo Server stopped.
pause
