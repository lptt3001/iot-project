param([string]$Python = 'python')
$ErrorActionPreference = 'Stop'
. "$PSScriptRoot\windows_environment.ps1"
Set-Location -LiteralPath (Split-Path -Parent $PSScriptRoot)
New-Item -ItemType Directory -Force -Path '.runtime' | Out-Null
# Extract official installers. Do not run installers, install services or change registry.
if (-not (Test-Path '.runtime\mosquitto\mosquitto.exe')) {
    Invoke-WebRequest 'https://github.com/ip7z/7zip/releases/download/26.05/7zr.exe' -OutFile '.runtime\7zr.exe'
    Invoke-WebRequest 'https://github.com/ip7z/7zip/releases/download/26.05/7z2605-x64.exe' -OutFile '.runtime\7z-setup.exe'
    & '.\.runtime\7zr.exe' x '.runtime\7z-setup.exe' '-o.runtime\7zip' -y
    if ($LASTEXITCODE -ne 0) { throw '7-Zip extraction failed' }
    Invoke-WebRequest 'https://mosquitto.org/files/binary/win64/mosquitto-2.1.2-install-windows-x64.exe' -OutFile '.runtime\mosquitto-setup.exe'
    & '.\.runtime\7zip\7z.exe' x '.runtime\mosquitto-setup.exe' '-o.runtime\mosquitto' -y
    if ($LASTEXITCODE -ne 0) { throw 'Mosquitto extraction failed' }
}
if (-not (Test-Path '.venv\Scripts\python.exe')) {
    & $Python -m venv .venv
    if ($LASTEXITCODE -ne 0) { throw 'Python virtual environment creation failed' }
}
& '.\.venv\Scripts\python.exe' -m pip install -r requirements.txt
if ($LASTEXITCODE -ne 0) { throw 'Python dependency install failed' }
& '.\.venv\Scripts\python.exe' scripts/bootstrap.py
if ($LASTEXITCODE -ne 0) { throw 'Bootstrap failed' }
& "$PSScriptRoot\run_broker.ps1"
