@echo off
setlocal
pushd "%~dp0" || exit /b 1
node scripts\stop.mjs
set "exitCode=%ERRORLEVEL%"
popd
if not "%exitCode%"=="0" pause
exit /b %exitCode%
