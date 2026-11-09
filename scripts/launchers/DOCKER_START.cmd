@echo off
cd /d "%~dp0..\.." || exit /b 1
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "scripts\docker_app.ps1"
if errorlevel 1 pause
