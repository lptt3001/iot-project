param([switch]$KeepInfrastructure)
$ErrorActionPreference='Stop'
. "$PSScriptRoot\windows_environment.ps1"
$env:PYTHONUTF8='1'
$taskRoot=Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $taskRoot
$taskPidPath=Join-Path $taskRoot '.runtime\app.pid'
if (Test-Path -LiteralPath $taskPidPath) {
    $taskAppId=[int](Get-Content -LiteralPath $taskPidPath)
    $taskProcess=Get-CimInstance Win32_Process -Filter "ProcessId=$taskAppId"
    if ($taskProcess) {
        $taskVenvPython=Join-Path $taskRoot '.venv\Scripts\python.exe'
        # Windows venv launchers may forward to the base Python executable.
        $taskBasePython=(& $taskVenvPython -c 'import sys; print(sys._base_executable)').Trim()
        if ($taskProcess.ExecutablePath -notin @($taskVenvPython,$taskBasePython) -or $taskProcess.CommandLine -notlike '*app_server.py*') { throw 'PID belongs to another process. Nothing stopped.' }
        Set-Content -LiteralPath '.runtime\app.stop' -Value $taskAppId
        $taskProcessObject=Get-Process -Id $taskAppId
        if (-not $taskProcessObject.WaitForExit(45000)) { throw 'Application is still draining work. Try again shortly.' }
    }
}
if (-not $KeepInfrastructure) {
    & "$PSScriptRoot\run_broker.ps1" -Stop
    & '.\.venv\Scripts\python.exe' scripts/setup_database_windows.py --stop
    if ($LASTEXITCODE -ne 0) { throw 'Database stop failed.' }
}
Write-Output 'PTIT Garden stopped. All saved data is retained.'
