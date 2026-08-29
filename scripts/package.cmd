@echo off
setlocal
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0package.ps1" %*
set "SQL_VIEWER_EXIT=%ERRORLEVEL%"
endlocal & exit /b %SQL_VIEWER_EXIT%
