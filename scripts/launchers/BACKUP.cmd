@echo off
cd /d "%~dp0..\.." || exit /b 1
set PYTHONUTF8=1
".venv\Scripts\python.exe" scripts\backup.py
if errorlevel 1 pause
