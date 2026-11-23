#!/usr/bin/env python3
"""Cactus Platform pipeline for KAI V1 Desktop-Controls (upload -> finetune -> download).

Spends exactly 1 fine-tune run of the plan allowance (never generations).
Uses the RAW REST API so the script is auditable and re-runnable:

  1. GET  /v1/billing                       -> refuse to submit if jobs remaining < 1
  2. POST /v1/files                         -> reserve train/val/test uploads
  3. PUT  (presigned url)                   -> exact byte upload
  4. POST /v1/files/{id}/complete           -> finalize each file
  5. POST /v1/fine_tuning/jobs              -> submit kai-desktop-v1 (max_depth 20)
  6. GET  /v1/fine_tuning/jobs/{id}         -> poll every 60 s until terminal state
  7. GET  /v1/models/{fine_tuned_model}     -> list depth variants
  8. GET  /v1/models/{variant}/content      -> download .cact for chosen depths

Sub-commands:
  upload     Reserve + upload + complete the three data files. Prints file ids.
  submit     POST the fine-tune job (requires --train/--val/--test file ids).
  status     Poll a job once and print its state.
  wait       Poll a job until terminal state (CTRL-C safe; resume with `wait`).
  download   Download .cact files for a model id (--depths 20,12,8).
  full       upload + submit + wait + download in one go.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
DATA_DIR = HERE / "data"
DOWNLOAD_DIR = HERE / "models"
API = "https://cactuscompute.com/v1"

SUFFIX = "kai-reflex-v1"
DEFAULT_DEPTHS = [20, 12, 8]


def api_key() -> str:
    key = os.environ.get("CACTUS_API_KEY", "").strip()
    if not key:
        raise SystemExit("CACTUS_API_KEY not set (use env: {'CACTUS_API_KEY': 'vault:CACTUS_API_KEY'})")
    return key


def call(method: str, url: str, *, headers: dict | None = None, body: bytes | None = None,
         expect_json: bool = True, timeout: int = 120):
    h = {"Authorization": f"Bearer {api_key()}", "User-Agent": "kai-cactus-platform/1.0"}
    if headers:
        h.update(headers)
    req = urllib.request.Request(url, data=body, headers=h, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read()
            if expect_json:
                return json.loads(raw)
            return raw
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", errors="replace")
        try:
            j = json.loads(detail)
            code = j.get("error", {}).get("code", "?")
            msg = j.get("error", {}).get("message", detail)
            purl = j.get("error", {}).get("url", "")
            print(f"HTTP {e.code} ({code}): {msg} {purl}", file=sys.stderr)
        except json.JSONDecodeError:
            print(f"HTTP {e.code}: {detail[:400]}", file=sys.stderr)
        raise


def check_billing() -> dict:
    b = call("GET", f"{API}/billing")
    jobs_left = b["limits"]["jobs"] - b["usage"]["jobs"]
    print(f"Plan: {b['plan']} | jobs used {b['usage']['jobs']}/{b['limits']['jobs']} "
          f"({jobs_left} left) | examples {b['usage']['examples']}/{b['limits']['examples']}")
    if jobs_left < 1:
        raise SystemExit("No fine-tune runs left this period - submit refused.")
    return b


def cmd_upload(args: argparse.Namespace) -> dict[str, str]:
    check_billing()
    out: dict[str, str] = {}
    train_path = DATA_DIR / (args.train or "train.jsonl")
    val_path = DATA_DIR / (args.validation or "validation.jsonl")
    test_path = DATA_DIR / (args.test or "test.jsonl")
    for name, path in (("train", train_path),
                       ("validation", val_path),
                       ("test", test_path)):
        data = path.read_bytes()
        res = call("POST", f"{API}/files", headers={"Content-Type": "application/json"},
                   body=json.dumps({"name": path.name, "bytes": len(data)}).encode())
        file_id, put_url = res["id"], res["url"]
        print(f"[{name}] reserved {file_id}, uploading {len(data):,} bytes ...")
        call("PUT", put_url, headers={"Content-Type": "application/octet-stream"},
             body=data, expect_json=False)
        rec = call("POST", f"{API}/files/{file_id}/complete")
        out[name] = rec["id"]
        print(f"[{name}] complete -> {rec['id']}")
    return out


def cmd_submit(args: argparse.Namespace) -> str:
    check_billing()
    body = {
        "model": "needle-3",
        "training_files": [args.train],
        "validation_files": [args.val],
        "test_files": [args.test],
        "max_depth": 20,
        "suffix": SUFFIX,
    }
    print("Submitting job:", json.dumps(body, indent=2))
    job = call("POST", f"{API}/fine_tuning/jobs",
               headers={"Content-Type": "application/json"},
               body=json.dumps(body).encode())
    print(f"Job {job['id']} status={job.get('status')}")
    print(f"Dashboard: https://cactuscompute.com/dashboard")
    return job["id"]


def cmd_status(args: argparse.Namespace) -> dict:
    job = call("GET", f"{API}/fine_tuning/jobs/{args.job_id}")
    print(f"Job {job['id']}: status={job['status']} steps={job.get('completed_steps')}/{job.get('total_steps')}")
    if job.get("error"):
        print(f"Error: {json.dumps(job['error'])}")
    if job.get("evaluations"):
        for ev in job["evaluations"]:
            if ev["depth"] in DEFAULT_DEPTHS:
                print(f"  depth {ev['depth']:>2}: val {ev['validation']['correct']}/{ev['validation']['total']}"
                      f"  test {ev['test']['correct']}/{ev['test']['total']}")
    return job


def cmd_wait(args: argparse.Namespace) -> dict:
    print(f"Polling job {args.job_id} every 60 s (Ctrl-C leaves the job running).")
    while True:
        job = cmd_status(args)
        if job["status"] in ("succeeded", "failed", "cancelled"):
            return job
        time.sleep(60)


def cmd_download(args: argparse.Namespace) -> list[Path]:
    model = call("GET", f"{API}/models/{args.model_id}")
    variants = {v["depth"]: v["id"] for v in model.get("variants", [])}
    print(f"Model {model['id']} variants: {sorted(variants)}")
    DOWNLOAD_DIR.mkdir(parents=True, exist_ok=True)
    out: list[Path] = []
    for depth in args.depths:
        vid = variants.get(depth)
        if not vid:
            print(f"  depth {depth}: no variant, skipping")
            continue
        dest = DOWNLOAD_DIR / f"kai-reflex-v1-{depth}L.cact"
        print(f"  downloading depth {depth} -> {dest.name} ...")
        raw = call("GET", f"{API}/models/{vid}/content", expect_json=False, timeout=300)
        dest.write_bytes(raw)
        print(f"  saved {len(raw):,} bytes")
        out.append(dest)
    return out


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__)
    sub = p.add_subparsers(dest="cmd", required=True)

    up = sub.add_parser("upload")
    up.add_argument("--train", default=None, help="train jsonl filename under data/")
    up.add_argument("--validation", default=None)
    up.add_argument("--test", default=None)
    sp = sub.add_parser("submit")
    sp.add_argument("--train", required=True)
    sp.add_argument("--val", required=True)
    sp.add_argument("--test", required=True)
    sp.add_argument("--yes", action="store_true",
                    help="Required: confirms this spends 1 fine-tune run")
    st = sub.add_parser("status")
    st.add_argument("job_id")
    w = sub.add_parser("wait")
    w.add_argument("job_id")
    dl = sub.add_parser("download")
    dl.add_argument("model_id")
    dl.add_argument("--depths", default=",".join(str(d) for d in DEFAULT_DEPTHS))
    sub.add_parser("full")

    args = p.parse_args()
    if args.cmd == "upload":
        cmd_upload(args)
    elif args.cmd == "submit":
        if not args.yes:
            raise SystemExit("Refusing to spend a run without --yes (1 fine-tune run is spent at submission).")
        cmd_submit(args)
    elif args.cmd == "status":
        cmd_status(args)
    elif args.cmd == "wait":
        cmd_wait(args)
    elif args.cmd == "download":
        depths = [int(d) for d in args.depths.split(",") if d.strip()]
        args.depths = depths
        cmd_download(args)
    elif args.cmd == "full":
        ids = cmd_upload(args)
        job_id = cmd_submit(argparse.Namespace(train=ids["train"], val=ids["validation"],
                                               test=ids["test"], yes=True))
        args.job_id = job_id
        job = cmd_wait(args)
        if job["status"] != "succeeded":
            raise SystemExit(f"Job ended with status {job['status']}")
        args.model_id = job["fine_tuned_model"]
        args.depths = DEFAULT_DEPTHS
        cmd_download(args)


if __name__ == "__main__":
    main()
