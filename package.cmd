@echo off
setlocal
call "%~dp0scripts\package.cmd" %*
set "SQL_VIEWER_EXIT=%ERRORLEVEL%"
endlocal & exit /b %SQL_VIEWER_EXIT%
