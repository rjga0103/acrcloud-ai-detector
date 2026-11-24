@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js no esta instalado. Instala Node 20 o superior: https://nodejs.org
  pause
  exit /b 1
)
start "" cmd /c "timeout /t 2 >nul & start "" http://127.0.0.1:8787"
node server.js
pause
