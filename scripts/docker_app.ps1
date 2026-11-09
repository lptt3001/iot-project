param([switch]$Stop, [switch]$NoBrowser)
$ErrorActionPreference='Stop'
. "$PSScriptRoot\windows_environment.ps1"
$env:PYTHONUTF8='1'
Set-Location -LiteralPath (Split-Path -Parent $PSScriptRoot)
if (-not (Get-Command docker -ErrorAction SilentlyContinue)) { throw 'Install Docker Desktop, then reopen the terminal.' }
if ($Stop) {
    docker compose down
    if ($LASTEXITCODE -ne 0) { throw 'Docker stop failed.' }
    Write-Output 'Docker stopped. Named volumes and saved data are retained.'
    exit 0
}
docker info --format '{{.ServerVersion}}'
if ($LASTEXITCODE -ne 0) { throw 'Open Docker Desktop and wait for the Linux engine to be ready.' }
$taskPython='.\.venv\Scripts\python.exe'
if (-not (Test-Path -LiteralPath $taskPython)) {
    python -m venv .venv
    if ($LASTEXITCODE -ne 0) { throw 'Python 3.12+ is required to prepare local credentials.' }
}
& $taskPython -m pip install --quiet --progress-bar off -r requirements.txt
if ($LASTEXITCODE -ne 0) { throw 'Dependency installation failed.' }
& $taskPython scripts/bootstrap.py
if ($LASTEXITCODE -ne 0) { throw 'Credential preparation failed.' }
& "$PSScriptRoot\stop_app.ps1"
docker compose config --quiet
if ($LASTEXITCODE -ne 0) { throw 'Invalid Docker Compose configuration.' }
docker compose up -d --build --wait --wait-timeout 180
if ($LASTEXITCODE -ne 0) { throw 'Container startup failed. Run: docker compose logs --tail=100' }
docker compose ps
Write-Output 'PTIT Garden Docker: http://127.0.0.1:8000 (separate database from Windows mode).'
if (-not $NoBrowser) { Start-Process 'http://127.0.0.1:8000' }
