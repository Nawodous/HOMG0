@echo off
setlocal
cd /d "%~dp0"
start "HOMG0 LAN Server" cmd /k call "%~dp0server_start_inner.bat"
endlocal
