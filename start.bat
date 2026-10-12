@echo off
rem Pads Igreja - inicia o servidor e abre o player com o audio ja ligado (Windows + Chrome)
cd /d "%~dp0"
if not exist node_modules (
  echo Instalando dependencias, aguarde...
  call npm install --omit=dev
)
start "Pads Igreja - Servidor" /min cmd /c node server.js
timeout /t 2 /nobreak >nul
rem Perfil proprio do Chrome: permite audio sem clique e lembra a placa de som escolhida
start "" chrome --user-data-dir="%~dp0chrome-profile" --autoplay-policy=no-user-gesture-required --app=http://localhost:3000/player?auto=1
