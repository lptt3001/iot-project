param([switch]$Cloud, [string]$CloudConfig)

$ErrorActionPreference='Stop'
. "$PSScriptRoot\windows_environment.ps1"
if ($CloudConfig) {
    if (-not $Cloud) { throw 'Use -Cloud with -CloudConfig.' }
    $CloudConfig = (Resolve-Path -LiteralPath $CloudConfig).Path
}
$taskRoot=Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $taskRoot
$taskBuild=Join-Path $env:LOCALAPPDATA 'PTIT-Garden-Camera'
$taskSketchName='ptit_usb_camera'
$taskBuildPath=Join-Path $taskBuild 'build'
if ($Cloud) {
    $taskSketchName='ptit_cloud_camera'
    $taskCloudMode=if ($CloudConfig) { 'cloud-device' } else { 'cloud-check' }
    $taskBuildPath=Join-Path $taskBuild "$taskCloudMode\build"
    $taskSketch=Join-Path $taskBuild "$taskCloudMode\$taskSketchName"
} else {
    $taskSketch=Join-Path $taskBuild "src\$taskSketchName"
}
$taskCli=Join-Path $taskRoot '.runtime\arduino-cli\arduino-cli.exe'
if (-not (Test-Path -LiteralPath $taskCli)) { throw 'Arduino CLI is required in .runtime/arduino-cli or compile the sketch in Arduino IDE with AI Thinker ESP32-CAM.' }
if (-not (Test-Path -LiteralPath "$taskBuild\gcc\bin\xtensa-esp32-elf-g++.exe")) { throw 'Install the ESP32 compiler in the short ASCII build directory first.' }
New-Item -ItemType Directory -Path $taskSketch -Force | Out-Null
Copy-Item -LiteralPath "firmware\$taskSketchName\$taskSketchName.ino" -Destination $taskSketch -Force
$taskStagedConfig=Join-Path $taskSketch 'cloud_config.h'
if ($Cloud) {
    Copy-Item -LiteralPath @('firmware\ptit_cloud_camera\cloud_transport.h','firmware\ptit_cloud_camera\cloud_config.example.h') -Destination $taskSketch -Force
    if ($CloudConfig) { Copy-Item -LiteralPath $CloudConfig -Destination $taskStagedConfig -Force }
}
try {
    & $taskCli compile --fqbn esp32:esp32:esp32cam --build-property "compiler.path=$taskBuild\gcc\bin\" --build-property "runtime.tools.esptool_py.path=$taskRoot\.venv\Scripts" --build-path $taskBuildPath $taskSketch
    if ($LASTEXITCODE -ne 0) { throw 'Firmware compilation failed.' }
} finally {
    if ($Cloud -and (Test-Path -LiteralPath $taskStagedConfig)) {
        Remove-Item -LiteralPath $taskStagedConfig
    }
}
if ($Cloud) {
    Write-Output "Compiled cloud firmware: $taskBuildPath"
    exit 0
}
$taskExport=Join-Path $taskRoot 'firmware\prebuilt'
New-Item -ItemType Directory -Path $taskExport -Force | Out-Null
foreach ($taskFile in @('ptit_usb_camera.ino.bin','ptit_usb_camera.ino.bootloader.bin','ptit_usb_camera.ino.partitions.bin')) {
    Copy-Item -LiteralPath (Join-Path $taskBuildPath $taskFile) -Destination $taskExport -Force
}
Copy-Item -LiteralPath (Join-Path $env:LOCALAPPDATA 'Arduino15\packages\esp32\hardware\esp32\2.0.17\tools\partitions\boot_app0.bin') -Destination $taskExport -Force
Write-Output "Compiled firmware: $taskBuildPath"
