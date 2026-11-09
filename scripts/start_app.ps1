param([switch]$NoBrowser)
$ErrorActionPreference = 'Stop'
. "$PSScriptRoot\windows_environment.ps1"
$env:PYTHONUTF8 = '1'
$env:PYTHONIOENCODING = 'utf-8'
$taskRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $taskRoot
$taskPython = Join-Path $taskRoot '.venv\Scripts\python.exe'
if (-not (Test-Path -LiteralPath $taskPython) -or -not (Test-Path '.runtime\mosquitto\mosquitto.exe')) {
    & "$PSScriptRoot\setup_windows.ps1"
}
if (-not (Test-Path -LiteralPath $taskPython)) { throw 'Python environment is missing.' }
$taskRequirementsHash = (Get-FileHash -LiteralPath 'requirements.txt' -Algorithm SHA256).Hash
$taskHashFile = '.runtime\app-dependencies.sha256'
if (-not (Test-Path -LiteralPath $taskHashFile) -or (Get-Content -LiteralPath $taskHashFile -Raw).Trim() -ne $taskRequirementsHash) {
    & $taskPython -m pip install --quiet --progress-bar off -r requirements.txt
    if ($LASTEXITCODE -ne 0) { throw 'Dependency installation failed.' }
    Set-Content -LiteralPath $taskHashFile -Value $taskRequirementsHash
}
& $taskPython scripts/bootstrap.py
if ($LASTEXITCODE -ne 0) { throw 'Local configuration failed.' }
& "$PSScriptRoot\run_broker.ps1"
& $taskPython scripts/setup_database_windows.py
if ($LASTEXITCODE -ne 0) { throw 'Database startup failed.' }
$taskExisting = $null
try { $taskExisting = Invoke-RestMethod 'http://127.0.0.1:8000/api/health' -TimeoutSec 3 } catch { }
if ($taskExisting -and $taskExisting.application -ne 'ptit-garden') { throw 'Port 8000 belongs to another application.' }
if (-not $taskExisting) {
    $taskPort = Get-NetTCPConnection -LocalPort 8000 -State Listen -ErrorAction SilentlyContinue
    if ($taskPort) { throw 'Port 8000 is already occupied. Check .runtime/app.stderr.log if this is the garden application.' }
    $taskServerArgument='"{0}"' -f (Join-Path $taskRoot 'scripts\app_server.py')
    Start-Process -FilePath $taskPython -ArgumentList @($taskServerArgument) -WorkingDirectory $taskRoot -WindowStyle Hidden -RedirectStandardOutput '.runtime\app.stdout.log' -RedirectStandardError '.runtime\app.stderr.log' | Out-Null
}
$taskReady = $false
for ($taskAttempt=0; $taskAttempt -lt 45; $taskAttempt++) {
    try {
        $taskHealth = Invoke-RestMethod 'http://127.0.0.1:8000/api/health' -TimeoutSec 2
        if ($taskHealth.application -eq 'ptit-garden' -and $taskHealth.ok) { $taskReady=$true; break }
    } catch { }
    Start-Sleep -Seconds 1
}
if (-not $taskReady) { throw 'Application did not become ready. See .runtime/app.stderr.log.' }
Write-Output 'PTIT Garden is running: http://127.0.0.1:8000'
Write-Output 'Sensors, MQTT TLS, TimescaleDB, cameras, alerts and dashboard are ready.'
if (-not $NoBrowser) { Start-Process 'http://127.0.0.1:8000' }
