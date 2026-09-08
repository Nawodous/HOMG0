@echo off
cd /d "%~dp0"
title HOMG0 LAN - Environment Check

echo ==============================================
echo          HOMG0 LAN ENVIRONMENT CHECK
echo ==============================================
echo.

echo Node.js:
where node
if errorlevel 1 echo [FAIL] node not found
if not errorlevel 1 node --version

echo.
echo npm:
where npm
if errorlevel 1 echo [FAIL] npm not found
if not errorlevel 1 npm --version

echo.
echo ws dependency:
if exist "node_modules\ws\package.json" (
  echo [OK] node_modules\ws found
) else (
  echo [MISSING] node_modules\ws not found
  echo Run start.bat to install it.
)

echo.
echo Project directory:
echo %CD%
echo.
pause
