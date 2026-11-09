@echo off
cd /d "%~dp0..\.." || exit /b 1
set PYTHONUTF8=1
".venv\Scripts\python.exe" -m pip install --quiet --progress-bar off -r requirements-serial.txt
if errorlevel 1 goto fail
".venv\Scripts\python.exe" scripts\serial_gateway.py --port COM5
:fail
if errorlevel 1 pause
