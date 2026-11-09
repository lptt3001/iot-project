param(
    [ValidateSet('Train', 'Resume', 'Export')]
    [string]$Action = 'Train',
    [ValidateRange(1, 64)]
    [int]$Batch = 16
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$aiDirectory = Join-Path $env:LOCALAPPDATA 'PTIT-Garden-AI'
$trainingPython = Join-Path $aiDirectory 'venv/Scripts/python.exe'
$upstream = Join-Path $aiDirectory 'yolox-src'
$experiment = Join-Path $projectRoot 'scripts/pestnu_yolox.py'
$env:PTIT_AI_COCO_DIR = Join-Path $aiDirectory 'pestnu/coco-ready'
$env:PTIT_AI_RUNS_DIR = Join-Path $aiDirectory 'runs'
$env:PYTHONUTF8 = '1'
$runDirectory = Join-Path $env:PTIT_AI_RUNS_DIR 'ptit_pestnu_nano'
$latestCheckpoint = Join-Path $runDirectory 'latest_ckpt.pth'

foreach ($required in $trainingPython, $upstream, (Join-Path $env:PTIT_AI_COCO_DIR 'annotations/train.json')) {
    if (-not (Test-Path -LiteralPath $required)) { throw "Missing training dependency: $required" }
}

Push-Location -LiteralPath $upstream
try {
    if ($Action -eq 'Export') {
        $bestCheckpoint = Join-Path $runDirectory 'best_ckpt.pth'
        if (-not (Test-Path -LiteralPath $bestCheckpoint)) { throw "Missing validated checkpoint: $bestCheckpoint" }
        $modelOutput = Join-Path $runDirectory 'model.onnx'
        $sample = Join-Path $env:PTIT_AI_COCO_DIR 'demo/hai-loai.jpg'
        & $trainingPython (Join-Path $projectRoot 'scripts/export_pestnu.py') $upstream $bestCheckpoint $sample $modelOutput
    } else {
        $arguments = @('-m', 'tools.train', '-f', $experiment, '-d', '1', '-b', "$Batch", '--fp16')
        if ($Action -eq 'Resume') {
            if (-not (Test-Path -LiteralPath $latestCheckpoint)) { throw "Missing resume checkpoint: $latestCheckpoint" }
            $arguments += @('--resume', '-c', $latestCheckpoint)
        } elseif (Test-Path -LiteralPath $latestCheckpoint) {
            throw 'A checkpoint already exists. Use -Action Resume to continue.'
        } else {
            $arguments += @('-c', (Join-Path $aiDirectory 'yolox-nano-coco.pth'))
        }
        & $trainingPython @arguments
    }
    if ($LASTEXITCODE) { exit $LASTEXITCODE }
} finally {
    Pop-Location
}
