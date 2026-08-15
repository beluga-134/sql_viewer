@echo off
setlocal
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0check.ps1" %*
set "SQL_VIEWER_EXIT=%ERRORLEVEL%"
endlocal & exit /b %SQL_VIEWER_EXIT%
