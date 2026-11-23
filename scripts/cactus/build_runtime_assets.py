#!/usr/bin/env python3
"""Emit scripts/cactus/narrow_tools.json (flat schema for the C++ engine) and
a launch script for the local reflex engine.

The runtime engine gets the FULL 22 narrow tools (with parameter schemas and
bounds): the decode grammar is a runtime concern. Training used the minimal
18-tool block; inference uses this file verbatim.
"""
import json
from pathlib import Path

HERE = Path(__file__).resolve().parent
schemas = json.loads((HERE / "schemas.json").read_text(encoding="utf-8"))

flat = schemas["narrow_tools"]  # already flat (no {"type":"function"} wrapper)
(HERE / "narrow_tools.json").write_text(
    json.dumps(flat, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
)
print(f"Wrote narrow_tools.json ({len(flat)} tools)")

# Windows launcher: serves kai-desktop-v1-12L on 127.0.0.1:8941 with the
# engine's built-in HTTP server (`cactus --serve` answers POST /complete).
launcher = r"""# Launch the KAI local reflex engine (Needle 3, kai-desktop-v1 12L).
# Prereq: pip install "cactus-compute>=4.0.0"
# The transport fast path probes http://127.0.0.1:8941/complete and falls
# back to the cloud LLM when this is not running.
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$model = Join-Path $here "models\kai-desktop-v1-12L.cact"
$tools = Join-Path $here "narrow_tools.json"
if (-not (Test-Path $model)) { Write-Error "model not found: $model"; exit 1 }
cactus --model $model --tools $tools --serve --port 8941
"""
(HERE / "serve-engine.ps1").write_text(launcher, encoding="utf-8", newline="\n")
print("Wrote serve-engine.ps1")
