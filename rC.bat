@echo off
setlocal
cd /d "%~dp0"
set "CLIENT_URL=http://127.0.0.1:3000/"

where curl.exe >nul 2>nul
if errorlevel 1 (
    echo curl.exe is not available. Start the server with rS.bat and open:
    echo %CLIENT_URL%
    pause
    exit /b 1
)

curl.exe --silent --fail --output nul --max-time 3 "%CLIENT_URL%" >nul 2>nul
if errorlevel 1 (
    echo Prism X server is not responding.
    echo Start rS.bat first, wait for the ready message, then run rC.bat.
    pause
    exit /b 1
)

echo Opening Prism X client...
start "" "%CLIENT_URL%"
