@echo off
chcp 65001 >nul
cd /d "%~dp0"
title Dashboard surcharges carburant

where python >nul 2>nul
if errorlevel 1 (
  echo Python est introuvable. Installez-le depuis https://www.python.org/downloads/ ^(cocher "Add to PATH"^).
  pause
  exit /b 1
)

if not exist ".venv\Scripts\python.exe" (
  echo [1/3] Creation de l'environnement Python...
  python -m venv .venv || goto :err
  echo [2/3] Installation de Playwright...
  ".venv\Scripts\python.exe" -m pip install --upgrade pip >nul
  ".venv\Scripts\python.exe" -m pip install -r requirements.txt || goto :err
  echo [3/3] Telechargement de Chromium ^(secours si Edge/Chrome indisponible^)...
  ".venv\Scripts\python.exe" -m playwright install chromium
)

echo.
echo Demarrage du dashboard sur http://localhost:8050  (fermez cette fenetre pour arreter)
".venv\Scripts\python.exe" server.py
pause
exit /b 0

:err
echo Une erreur est survenue pendant l'installation.
pause
exit /b 1
