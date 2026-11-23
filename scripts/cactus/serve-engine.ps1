# Launch the KAI local reflex engine (`kai-reflex-v1`, 12L).
#
# Uses the standalone C++ engine (no Python needed at runtime):
#   scripts/cactus/.cache/engine/windows-x86_64/cactus.exe
# If the engine is not downloaded yet, fetch it first:
#   cactus download windows-x86_64 --out scripts/cactus/.cache/engine
#
# The transport fast path probes http://127.0.0.1:8941/complete and falls
# back to the cloud LLM when this is not running.
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$engine = Join-Path $here ".cache\engine\windows-x86_64\cactus.exe"
if (-not (Test-Path $engine)) {
    Write-Host "Engine not found - downloading (one time, ~5 MB)..."
    cactus download windows-x86_64 --out (Join-Path $here ".cache\engine")
}
$model = Join-Path $here "models\kai-reflex-v1-12L.cact"
$tools = Join-Path $here "narrow_tools.json"
if (-not (Test-Path $model)) { Write-Error "model not found: $model"; exit 1 }
& $engine --model $model --tools $tools --serve --port 8941
