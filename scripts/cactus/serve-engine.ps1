# Launch the KAI local reflex engine (`kai-reflex-v1`, 12L).
# Prereq: pip install "cactus-compute>=4.0.0"
# The transport fast path probes http://127.0.0.1:8941/complete and falls
# back to the cloud LLM when this is not running.
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$model = Join-Path $here "models\kai-reflex-v1-12L.cact"
$tools = Join-Path $here "narrow_tools.json"
if (-not (Test-Path $model)) { Write-Error "model not found: $model"; exit 1 }
cactus --model $model --tools $tools --serve --port 8941
