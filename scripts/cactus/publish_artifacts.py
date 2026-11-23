#!/usr/bin/env python3
"""Publish the reflex artifact manifest + files for a fine-tuned model.

After each Cactus fine-tune (Run #4, #5, ...), this script:
  1. Reads the LOCAL artifacts from scripts/cactus/models/ (downloaded via
     platform_run.py) and narrow_tools.json.
  2. Copies them into scripts/cactus/publish/ with clean names.
  3. Writes reflex-manifest.json (version, URLs, byte sizes).

The manifest + files are then attached to the KAI GitHub release; the app
fetches <latest>/reflex-manifest.json and compares `version` against its
on-disk manifest to decide whether to re-download. Bumping the version is
the ONLY step needed to ship a retrained model.

Usage:
  python scripts/cactus/publish_artifacts.py --version 2026.11.23-r2 \
      --engine windows-x86_64   # engine folder to package (repeatable)
"""
from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
MODELS_DIR = HERE / "models"
PUBLISH_DIR = HERE / "publish"

# GitHub release download base (matches reflex.rs MANIFEST_URL).
RELEASE_BASE = "https://github.com/Omodaka9375/kai/releases/latest/download"

# Platform folder -> engine archive name in the Cactus HF repo layout.
# These are produced by `cactus build --platform <folder> --out <dir>` locally
# and committed to the release as <folder>.zip.
PLATFORMS = ["windows-x86_64", "windows-arm64", "macos-arm64", "linux-x86_64", "linux-arm64"]


MODEL_NAME = "kai-reflex-v1"
CACTUS_ENGINE_BASE = (
    "https://huggingface.co/Cactus-Compute/cactus/resolve/"
    "4e822c9036be2eb0e47ef556df32a818bb1572ef/releases/4.1.0"
)
PINNED_ENGINES = {
    "windows-x86_64": {
        "url": f"{CACTUS_ENGINE_BASE}/windows-x86_64/cactus.exe",
        "sha256": "3b913456f1abd8de91aad6058ed1467eb418af7d2806f82c3d0bd8d26677ca6f",
        "bytes": 1622016,
    },
    "windows-arm64": {
        "url": f"{CACTUS_ENGINE_BASE}/windows-arm64/cactus.exe",
        "sha256": "06c001b2d0608cc79297db0d417f5eb83236f59105bf18e1befe7aef81ae8b84",
        "bytes": 1399296,
    },
    "macos-arm64": {
        "url": f"{CACTUS_ENGINE_BASE}/macos-arm64/cactus",
        "sha256": "86c7bad785977c79d935a47604e14df0ef9640297b1b1280d93757a15a87f3f5",
        "bytes": 1156280,
    },
    "linux-x86_64": {
        "url": f"{CACTUS_ENGINE_BASE}/linux-x86_64/cactus",
        "sha256": "d3fabf298fed9da8db319c90fbce62c898930699d87c0468b20262860b337098",
        "bytes": 1604704,
    },
    "linux-arm64": {
        "url": f"{CACTUS_ENGINE_BASE}/linux-arm64/cactus",
        "sha256": "088137b428c1be5cacb022a78a56f82815e5d60767002874afcc2ca7cf446074",
        "bytes": 1486560,
    },
}


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--version", default="1.0.0", help="e.g. 1.0.0")
    ap.add_argument("--depth", type=int, default=12, choices=[8, 12, 20],
                    help="model depth to publish (default 12 = the ship pick)")
    args = ap.parse_args()

    weights_src = MODELS_DIR / f"{MODEL_NAME}-{args.depth}L.cact"
    if not weights_src.exists():
        legacy = MODELS_DIR / f"kai-desktop-v1-{args.depth}L.cact"
        if legacy.exists():
            weights_src = legacy
    tools_src = HERE / "narrow_tools.json"
    if not weights_src.exists():
        raise SystemExit(f"weights not found: {weights_src}")
    if not tools_src.exists():
        raise SystemExit(f"tools not found: {tools_src} (run build_runtime_assets.py)")

    PUBLISH_DIR.mkdir(parents=True, exist_ok=True)
    weights_out = PUBLISH_DIR / f"{MODEL_NAME}-{args.depth}L.cact"
    tools_out = PUBLISH_DIR / "narrow_tools.json"
    shutil.copy2(weights_src, weights_out)
    shutil.copy2(tools_src, tools_out)

    manifest: dict = {
        "version": args.version,
        "model": MODEL_NAME,
        "depth": args.depth,
        "weights_url": f"{RELEASE_BASE}/{weights_out.name}",
        "weights_sha256": sha256(weights_out),
        "weights_bytes": weights_out.stat().st_size,
        "tools_url": f"{RELEASE_BASE}/narrow_tools.json",
        "tools_sha256": sha256(tools_out),
        "tools_bytes": tools_out.stat().st_size,
        "engines": PINNED_ENGINES,
    }

    out_path = PUBLISH_DIR / "reflex-manifest.json"
    out_path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print(f"Wrote {out_path}")
    print(json.dumps(manifest, indent=2)[:800])
    print("\nNext: attach publish/* to a GitHub release (gh release upload).")
    print("The app re-downloads automatically when its on-disk manifest version differs.")


if __name__ == "__main__":
    main()
