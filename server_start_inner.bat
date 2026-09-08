@echo off
setlocal
cd /d "%~dp0"

echo ==============================================
echo          HOMG0 LAN SERVER - STARTUP
echo ==============================================
echo.

echo [1/4] Checking Node.js...
where node >nul 2>nul
if errorlevel 1 goto NO_NODE
node --version
if errorlevel 1 goto NODE_BAD

echo.
echo [2/4] Checking npm...
where npm >nul 2>nul
if errorlevel 1 goto NO_NPM
call npm.cmd --version
if errorlevel 1 goto NPM_BAD

echo.
echo [3/4] Checking ws dependency...
if exist "node_modules\ws\package.json" goto DEP_OK

echo ws dependency is missing.
echo Installing dependencies with npm...
echo.
call npm.cmd install --no-audit --no-fund
if errorlevel 1 goto NPM_INSTALL_FAIL
if not exist "node_modules\ws\package.json" goto DEP_FAIL

:DEP_OK
echo Dependency OK.

echo.
echo [4/4] Starting HOMG0 server...
echo.
echo Server URL on this PC:
echo   http://localhost:37788
echo.
echo For another PC on the same LAN, use:
echo   http://YOUR-LAN-IP:37788
echo.
echo Keep this window open while playing.
echo Press Ctrl+C to stop the server.
echo.
node server.js
set "EXITCODE=%errorlevel%"
echo.
echo ==============================================
echo Server process exited with code %EXITCODE%.
echo ==============================================
echo.
pause
exit /b %EXITCODE%

:NO_NODE
echo.
echo ERROR: Node.js was not found in PATH.
echo Please install Node.js 18 or newer, then reopen this script.
echo Download: https://nodejs.org/
pause
exit /b 1

:NODE_BAD
echo.
echo ERROR: Node.js exists but could not be started.
pause
exit /b 1

:NO_NPM
echo.
echo ERROR: npm was not found in PATH.
echo Please reinstall Node.js with npm enabled.
pause
exit /b 1

:NPM_BAD
echo.
echo ERROR: npm exists but could not be started.
pause
exit /b 1

:NPM_INSTALL_FAIL
echo.
echo ERROR: npm install failed.
echo If this is a network problem, run this command manually:
echo   npm install
echo.
echo The full npm error is shown above.
pause
exit /b 1

:DEP_FAIL
echo.
echo ERROR: ws dependency is still missing after npm install.
pause
exit /b 1
