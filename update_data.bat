@echo off
chcp 65001 >nul
title Miwon Mapo dashboard - data update
echo.
echo  ==========================================
echo   Miwon Realty - Mapo dashboard data update
echo   (takes 1~10 minutes, please wait)
echo  ==========================================
echo.
"C:\Program Files (x86)\HncTools\McpServers\Node\node.exe" "%~dp0tools\build_data.js"
echo.
if errorlevel 1 (
  echo  [ERROR] Update failed. Check internet connection and try again.
  pause
  exit /b 1
)
echo  Done. Opening the dashboard...
start "" "%~dp0index.html"
timeout /t 5 >nul
