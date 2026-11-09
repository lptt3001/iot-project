@echo off
cd /d "%~dp0..\.." || exit /b 1
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "scripts\flash_camera.ps1" -Port COM5
if errorlevel 1 pause
