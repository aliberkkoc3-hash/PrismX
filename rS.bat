@echo off
setlocal
cd /d "%~dp0"
title Prism X - Server (AliDB)

where node >nul 2>nul
if errorlevel 1 (
    echo Node.js is not installed or is not available in PATH.
    echo Install Node.js 22.13 or newer, then try again.
    pause
    exit /b 1
)

if not exist "node_modules\express\package.json" (
    echo Project dependencies are missing.
    echo Run npm.cmd install in this folder, then start rS.bat again.
    pause
    exit /b 1
)

echo Starting Prism X server and AliDB...
echo Open rC.bat in another window to launch the client.
if not exist ".env" (
    echo.
    echo AI providers are not configured yet. Copy .env.example to .env
    echo and set GEMINI_API_KEY and GROQ_API_KEY before sending AI messages.
)
echo.
echo Gemini is the primary provider; Groq is the fallback.
echo Configure GEMINI_API_KEY and GROQ_API_KEY in .env.
call npm.cmd start

if errorlevel 1 (
    echo.
    echo The server stopped with an error.
    pause
)
