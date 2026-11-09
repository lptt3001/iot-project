param([switch]$Stop)
$ErrorActionPreference = 'Stop'
. "$PSScriptRoot\windows_environment.ps1"
$taskRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $taskRoot
$taskPidFile = Join-Path $taskRoot '.runtime\broker.pid'
if ($Stop) {
    if (Test-Path -LiteralPath $taskPidFile) {
        $taskBrokerId = [int](Get-Content -LiteralPath $taskPidFile)
        $taskProcess = Get-CimInstance Win32_Process -Filter "ProcessId=$taskBrokerId"
        $taskExpectedExe = Join-Path $taskRoot '.runtime\mosquitto\mosquitto.exe'
        if ($taskProcess -and $taskProcess.ExecutablePath -eq $taskExpectedExe -and $taskProcess.CommandLine -like '*mosquitto.local.conf*') {
            Stop-Process -Id $taskBrokerId
            Remove-Item -LiteralPath $taskPidFile
            Write-Output 'Local project broker stopped.'
        } elseif (-not $taskProcess) {
            Remove-Item -LiteralPath $taskPidFile
            Write-Output 'Broker process has already stopped.'
        } else {
            throw 'PID belongs to another process; no process stopped.'
        }
    }
    exit
}
$taskExe = Join-Path $taskRoot '.runtime\mosquitto\mosquitto.exe'
if (-not (Test-Path -LiteralPath $taskExe)) { throw 'Portable Mosquitto binary missing. Use Docker or scripts/setup_windows.ps1.' }
if (Test-Path -LiteralPath $taskPidFile) {
    $taskExistingId = [int](Get-Content -LiteralPath $taskPidFile)
    $taskExisting = Get-CimInstance Win32_Process -Filter "ProcessId=$taskExistingId"
    if ($taskExisting -and $taskExisting.ExecutablePath -eq $taskExe) { Write-Output 'Project broker is already running.'; exit }
}
$taskBroker = Start-Process -FilePath $taskExe -ArgumentList @('-c','infra/mosquitto/mosquitto.local.conf','-v') -WorkingDirectory $taskRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput '.runtime\broker.stdout.log' -RedirectStandardError '.runtime\broker.stderr.log'
$taskBroker.Id | Set-Content -LiteralPath $taskPidFile
Start-Sleep -Milliseconds 800
if ($taskBroker.HasExited) { Get-Content '.runtime\broker.stderr.log'; throw 'Broker failed to start.' }
Write-Output "MQTT TLS broker is running at localhost:8883 (PID $($taskBroker.Id))."
