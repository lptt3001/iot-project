param([string]$Port='COM5',[int]$Baud=115200)
$ErrorActionPreference='Stop'
. "$PSScriptRoot\windows_environment.ps1"
$env:PYTHONUTF8='1'
$taskRoot=Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $taskRoot
$taskPython=Join-Path $taskRoot '.venv\Scripts\python.exe'
$taskBuild=Join-Path $taskRoot 'firmware\prebuilt'
foreach ($taskFile in @('ptit_usb_camera.ino.bin','ptit_usb_camera.ino.bootloader.bin','ptit_usb_camera.ino.partitions.bin')) {
    if (-not (Test-Path -LiteralPath (Join-Path $taskBuild $taskFile))) { throw 'Compile the firmware with scripts/build_firmware.ps1 first.' }
}
& $taskPython scripts/serial_gateway.py --port $Port --stop
Start-Sleep -Seconds 2
$taskBackupFolder=Join-Path $taskRoot '.runtime\firmware-backups'
New-Item -ItemType Directory -Path $taskBackupFolder -Force | Out-Null
$taskBackup=Join-Path $taskBackupFolder ((Get-Date -Format 'yyyyMMdd-HHmmss')+'-before-camera.bin')
Write-Output 'Put ESP32-CAM in download mode (IO0 + RST); IO2 must not be driven high.'
& $taskPython -m esptool --chip esp32 --port $Port --baud $Baud --before no_reset --after no_reset read_flash 0 ALL $taskBackup
if ($LASTEXITCODE -ne 0) { throw 'Could not back up the old firmware. Nothing flashed.' }
if ((Get-Item -LiteralPath $taskBackup).Length -lt 1048576) { throw 'Backup is incomplete. Nothing flashed.' }
$taskHash=(Get-FileHash -LiteralPath $taskBackup -Algorithm SHA256).Hash
Set-Content -LiteralPath ($taskBackup+'.sha256') -Value $taskHash
& $taskPython -m esptool --chip esp32 --port $Port --baud $Baud --before no_reset --after no_reset verify_flash 0 $taskBackup
if ($LASTEXITCODE -ne 0) { throw 'Old firmware backup did not match device flash. Nothing flashed.' }
& $taskPython -m esptool --chip esp32 --port $Port --baud $Baud --before no_reset --after hard_reset write_flash --flash_mode dio --flash_freq 80m --flash_size detect 0x1000 "$taskBuild\ptit_usb_camera.ino.bootloader.bin" 0x8000 "$taskBuild\ptit_usb_camera.ino.partitions.bin" 0xe000 "$taskBuild\boot_app0.bin" 0x10000 "$taskBuild\ptit_usb_camera.ino.bin"
if ($LASTEXITCODE -ne 0) { throw "Upload failed. Old firmware backup is at $taskBackup" }
Write-Output 'Firmware uploaded. Release IO0, press RST, reconnect the soil signal wire, then run scripts/launchers/SERIAL_START.cmd.'
