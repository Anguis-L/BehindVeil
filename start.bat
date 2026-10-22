@echo off
REM ============================================================
REM  BehindVeil one-click launcher
REM  Double-click to: install deps (if needed), build (if needed),
REM  start the server, and open it in your browser.
REM ============================================================
chcp 65001 >nul
setlocal

cd /d "%~dp0"

echo =======================================
echo   BehindVeil server launcher
echo =======================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js not found. Please install Node.js 22 or newer first.
  pause
  exit /b 1
)

where pnpm >nul 2>nul
if errorlevel 1 (
  echo [ERROR] pnpm not found. Install it with:  npm install -g pnpm
  pause
  exit /b 1
)

echo [1/3] Installing dependencies (skips if already done)...
call pnpm install --prefer-offline
if errorlevel 1 (
  echo [ERROR] Dependency install failed.
  pause
  exit /b 1
)

if exist packages\server\dist\index.js (
  echo [2/3] Build found, skipping rebuild.
  echo        To rebuild after pulling new code, delete packages\server\dist
  echo        and packages\web\dist, then run this launcher again.
) else (
  echo [2/3] Building server + web (first run takes a while)...
  call pnpm build
  if errorlevel 1 (
    echo [ERROR] Build failed.
    pause
    exit /b 1
  )
)

echo [3/3] Starting server... a browser tab opens shortly.
start "" /min powershell -NoProfile -Command "Start-Sleep -Seconds 4; Start-Process http://127.0.0.1:8787"

node packages/server/dist/index.js

echo.
echo Server stopped.
pause
