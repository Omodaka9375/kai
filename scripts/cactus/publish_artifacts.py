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


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--version", required=True, help="e.g. 2026.11.23-r2")
    ap.add_argument("--depth", type=int, default=12, choices=[8, 12, 20],
                    help="model depth to publish (default 12 = the ship pick)")
    ap.add_argument("--platforms", default="windows-x86_64",
                    help="comma-separated platform folders with built engines")
    args = ap.parse_args()

    weights_src = MODELS_DIR / f"kai-desktop-v1-{args.depth}L.cact"
    tools_src = HERE / "narrow_tools.json"
    if not weights_src.exists():
        raise SystemExit(f"weights not found: {weights_src} (run platform_run.py download first)")
    if not tools_src.exists():
        raise SystemExit(f"tools not found: {tools_src} (run build_runtime_assets.py)")

    PUBLISH_DIR.mkdir(parents=True, exist_ok=True)
    weights_out = PUBLISH_DIR / f"kai-desktop-v1-{args.depth}L.cact"
    tools_out = PUBLISH_DIR / "narrow_tools.json"
    shutil.copy2(weights_src, weights_out)
    shutil.copy2(tools_src, tools_out)

    manifest: dict = {
        "version": args.version,
        "depth": args.depth,
        "weights_url": f"{RELEASE_BASE}/{weights_out.name}",
        "weights_sha256": sha256(weights_out),
        "weights_bytes": weights_out.stat().st_size,
        "tools_url": f"{RELEASE_BASE}/narrow_tools.json",
        "tools_sha256": sha256(tools_out),
        "tools_bytes": tools_out.stat().st_size,
        "engines": {},
    }
    for plat in [p.strip() for p in args.platforms.split(",") if p.strip()]:
        if plat not in PLATFORMS:
            raise SystemExit(f"unknown platform {plat}; choose from {PLATFORMS}")
        archive = MODELS_DIR / f"cactus-engine-{plat}.zip"
        if not archive.exists():
            print(f"  (no engine archive for {plat} - skipped; build with cactus build --platform {plat})")
            continue
        out = PUBLISH_DIR / f"cactus-engine-{plat}.zip"
        shutil.copy2(archive, out)
        manifest["engines"][plat] = {
            "url": f"{RELEASE_BASE}/{out.name}",
            "sha256": sha256(out),
            "bytes": out.stat().st_size,
        }

    out_path = PUBLISH_DIR / "reflex-manifest.json"
    out_path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print(f"Wrote {out_path}")
    print(json.dumps(manifest, indent=2)[:800])
    print("\nNext: attach publish/* to a GitHub release (gh release upload).")
    print("The app re-downloads automatically when its on-disk manifest version differs.")


if __name__ == "__main__":
    main()
