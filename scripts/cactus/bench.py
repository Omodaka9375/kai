#!/usr/bin/env python3
"""Local benchmark harness for Needle 3 on KAI V1 Desktop Controls (`scripts/cactus/`).

Evaluates:
1. Schema design: `narrow` (16 narrow single-action tools) vs `native` (11 raw KAI tools) vs both.
2. Model weights: default base `needle-3` (20L) or any downloaded subnetwork (e.g. `needle-3-depth-8.cact`)
   or fine-tuned `.cact`.
3. Pre-LLM Fast-Path Routing Contract across confidence thresholds (0.0 -> 0.90):
   - Action Recall: % of desktop-control turns handled locally with the EXACT right KAI call + args
   - Wrong Action Rate: % of desktop-control turns where Needle executes a wrong tool/arg locally
     instead of escalating cleanly to the main LLM
   - Escalation Hijack Rate (CRITICAL): % of coding/workspace/chat/negated turns (`expected == []`)
     where Needle fires a false-positive tool call above the threshold instead of falling through
     to `transport.ts` / `runAgentStream()`.
   - CPU Latency (p50 / p95 ms) & RAM footprint.

Usage:
  python scripts/cactus/bench.py
  python scripts/cactus/bench.py --mode both --show-failures 25
  python scripts/cactus/bench.py --fetch-depth 8 --weights scripts/cactus/.cache/needle-3-depth-8.cact
"""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import statistics
import sys
import time
from typing import Any
import urllib.request

import cactus

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from kai_mapper import FIXED_BENCH_NOW, to_canonical_kai_calls  # noqa: E402

SCHEMAS_PATH = HERE / "schemas.json"
SUITE_PATH = HERE / "eval_suite.jsonl"
CACHE_DIR = HERE / ".cache"
OUT_DIR = HERE / "out"

THRESHOLDS = [0.0, 0.30, 0.50, 0.65, 0.70, 0.75, 0.80, 0.85, 0.90]


def fetch_base_depth(depth: int) -> Path:
    """Download a keyless/authenticated base subnetwork `.cact` from Cactus `/v1/models`."""
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    variant = "needle-3" if depth == 20 else f"needle-3-depth-{depth}"
    dest = CACHE_DIR / f"{variant}.cact"
    if dest.exists() and dest.stat().st_size > 1_000_000:
        return dest

    url = f"https://cactuscompute.com/v1/models/{variant}/content"
    headers = {"User-Agent": "kai-cactus-bench/1.0"}
    api_key = os.environ.get("CACTUS_API_KEY", "").strip()
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"

    print(f"Downloading {variant} -> {dest} ...")
    req = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(req, timeout=60) as resp:
        data = resp.read()
    dest.write_bytes(data)
    print(f"Downloaded {len(data) / (1024 * 1024):.1f} MB")
    return dest


def canonical_equal(got: list[dict[str, Any]], want: list[dict[str, Any]]) -> bool:
    if len(got) != len(want):
        return False
    for g, w in zip(got, want):
        if g.get("name") != w.get("name"):
            return False
        g_args = g.get("arguments") or {}
        w_args = w.get("arguments") or {}
        if g_args != w_args:
            return False
    return True


def run_mode(
    mode_name: str,
    tools: list[dict[str, Any]],
    system_facts: str,
    suite: list[dict[str, Any]],
    weights: str | None,
) -> dict[str, Any]:
    t_init0 = time.perf_counter()
    agent = cactus.Cactus(
        tools=tools,
        system=system_facts,
        weights=weights,
        auto_date=False,
        stateless=True,
    )
    init_ms = (time.perf_counter() - t_init0) * 1000.0

    # Warmup call so one-time buffer/KV setup doesn't skew p50 latency
    agent.complete("stop the radio")

    rows: list[dict[str, Any]] = []
    latencies: list[float] = []
    peak_ram = 0.0

    for item in suite:
        t0 = time.perf_counter()
        reply = agent.complete(item["prompt"])
        dt_ms = (time.perf_counter() - t0) * 1000.0
        latencies.append(dt_ms)
        peak_ram = max(peak_ram, float(reply.get("peak_ram_mb") or 0.0))

        raw_calls = reply.get("function_calls") or []
        mapped_calls = to_canonical_kai_calls(raw_calls, now=FIXED_BENCH_NOW)
        conf = reply.get("confidence")
        conf_val = float(conf) if conf is not None else 1.0
        exact = canonical_equal(mapped_calls, item["expected_kai"])

        rows.append({
            "id": item["id"],
            "category": item["category"],
            "domain": item["domain"],
            "prompt": item["prompt"],
            "expected_kai": item["expected_kai"],
            "raw_calls": raw_calls,
            "mapped_calls": mapped_calls,
            "suppressed_calls": reply.get("suppressed_calls") or [],
            "confidence": conf,
            "confidence_val": conf_val,
            "reasoning": reply.get("reasoning"),
            "latency_ms": round(dt_ms, 2),
            "exact_raw": exact,
        })

    # Compute threshold sweep for pre-LLM fast-path routing
    action_rows = [r for r in rows if len(r["expected_kai"]) > 0]
    abstain_rows = [r for r in rows if len(r["expected_kai"]) == 0]
    escalate_coding_rows = [
        r for r in rows if r["category"] in ("escalate_coding", "escalate_chat")
    ]

    sweep: list[dict[str, Any]] = []
    for thr in THRESHOLDS:
        acted_right = 0
        acted_wrong = 0
        escalated_action = 0
        for r in action_rows:
            fires = len(r["mapped_calls"]) > 0 and r["confidence_val"] >= thr
            if fires:
                if r["exact_raw"]:
                    acted_right += 1
                else:
                    acted_wrong += 1
            else:
                escalated_action += 1

        hijacked_all = sum(
            1 for r in abstain_rows
            if len(r["mapped_calls"]) > 0 and r["confidence_val"] >= thr
        )
        hijacked_coding = sum(
            1 for r in escalate_coding_rows
            if len(r["mapped_calls"]) > 0 and r["confidence_val"] >= thr
        )
        total_correct_at_thr = acted_right + (len(abstain_rows) - hijacked_all)

        sweep.append({
            "threshold": thr,
            "overall_acc_pct": round(100.0 * total_correct_at_thr / len(rows), 1),
            "local_hit_rate_pct": round(100.0 * acted_right / len(action_rows), 1),
            "wrong_local_exec_pct": round(100.0 * acted_wrong / len(action_rows), 1),
            "safe_escalate_pct": round(100.0 * escalated_action / len(action_rows), 1),
            "hijack_abstain_cnt": hijacked_all,
            "hijack_abstain_total": len(abstain_rows),
            "hijack_coding_cnt": hijacked_coding,
            "hijack_coding_total": len(escalate_coding_rows),
        })

    # Per-domain raw accuracy
    domains: dict[str, list[bool]] = {}
    for r in rows:
        domains.setdefault(r["domain"], []).append(r["exact_raw"])
    domain_summary = {
        d: {
            "correct": sum(vals),
            "total": len(vals),
            "pct": round(100.0 * sum(vals) / len(vals), 1),
        }
        for d, vals in domains.items()
    }

    lat_sorted = sorted(latencies)
    p50 = statistics.median(lat_sorted)
    p95 = lat_sorted[min(len(lat_sorted) - 1, int(len(lat_sorted) * 0.95))]

    return {
        "mode": mode_name,
        "weights": weights or "needle-3 (default 20L)",
        "tool_count": len(tools),
        "init_ms": round(init_ms, 1),
        "latency_p50_ms": round(p50, 1),
        "latency_p95_ms": round(p95, 1),
        "latency_mean_ms": round(statistics.mean(lat_sorted), 1),
        "peak_ram_mb": round(peak_ram, 1),
        "raw_exact_correct": sum(1 for r in rows if r["exact_raw"]),
        "raw_total": len(rows),
        "raw_exact_pct": round(100.0 * sum(1 for r in rows if r["exact_raw"]) / len(rows), 1),
        "domain_summary": domain_summary,
        "threshold_sweep": sweep,
        "rows": rows,
    }


def print_report(res: dict[str, Any], show_failures: int) -> None:
    print("=" * 82)
    print(
        f"MODE: {res['mode']}  |  WEIGHTS: {res['weights']}  |  TOOLS: {res['tool_count']}"
    )
    print(
        f"Init: {res['init_ms']} ms  |  Latency p50: {res['latency_p50_ms']} ms, "
        f"p95: {res['latency_p95_ms']} ms, mean: {res['latency_mean_ms']} ms  |  "
        f"Peak RAM: {res['peak_ram_mb']} MB"
    )
    print(
        f"Unthresholded Exact Match (Platform Metric): "
        f"{res['raw_exact_correct']} / {res['raw_total']} ({res['raw_exact_pct']}%)"
    )
    print("-" * 82)
    print("Per-Domain Raw Exact Match:")
    for dom, stats in res["domain_summary"].items():
        print(f"  {dom:<12} {stats['correct']:>2}/{stats['total']:<2} ({stats['pct']:>5.1f}%)")

    print("-" * 82)
    print("Pre-LLM Fast-Path Routing Sweep (Confidence Gate):")
    print(
        "  Thr   | Prefill Saved | Wrong Local | Fell Through | Hijacked Abstain | Hijacked Coding"
    )
    for s in res["threshold_sweep"]:
        print(
            f"  {s['threshold']:0.2f}  |     {s['local_hit_rate_pct']:>5.1f}%    |"
            f"    {s['wrong_local_exec_pct']:>5.1f}%   |    {s['safe_escalate_pct']:>5.1f}%    |"
            f"      {s['hijack_abstain_cnt']:>2}/{s['hijack_abstain_total']:<2}       |"
            f"      {s['hijack_coding_cnt']:>2}/{s['hijack_coding_total']:<2}"
        )

    failures = [r for r in res["rows"] if not r["exact_raw"]]
    if failures and show_failures > 0:
        print("-" * 82)
        print(f"Failures ({len(failures)} total, showing up to {show_failures}):")
        for f in failures[:show_failures]:
            conf_str = f"{f['confidence']:.2f}" if isinstance(f["confidence"], float) else "None"
            print(
                f"  [{f['id']}] ({f['category']}, conf={conf_str}) {f['prompt']!r}\n"
                f"     want: {json.dumps(f['expected_kai'])}\n"
                f"     got : {json.dumps(f['mapped_calls'])}  (raw: {json.dumps(f['raw_calls'])})"
            )
            if f["suppressed_calls"]:
                print(f"     held: {json.dumps(f['suppressed_calls'])}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--mode",
        choices=["compact5", "narrow", "native", "all"],
        default="all",
        help="Tool schema variant to evaluate",
    )
    parser.add_argument(
        "--weights",
        default=None,
        help="Path to a .cact weights file (default: Needle 3 20L base)",
    )
    parser.add_argument(
        "--fetch-depth",
        type=int,
        default=None,
        help="Download and evaluate a specific base Needle 3 depth (2..20) from Cactus API",
    )
    parser.add_argument(
        "--show-failures",
        type=int,
        default=20,
        help="Number of failing prompts to print per mode",
    )
    args = parser.parse_args()

    if not SUITE_PATH.exists():
        import build_eval_suite
        build_eval_suite.main()

    schemas = json.loads(SCHEMAS_PATH.read_text(encoding="utf-8"))
    suite = [
        json.loads(line)
        for line in SUITE_PATH.read_text(encoding="utf-8").splitlines()
        if line.strip()
    ]
    weights = args.weights
    if args.fetch_depth is not None:
        weights = str(fetch_base_depth(args.fetch_depth))

    mode_map = {
        "compact5": schemas["compact_5_tools"],
        "narrow": schemas["narrow_tools"],
        "native": schemas["native_tools"],
    }
    modes = ["compact5", "narrow", "native"] if args.mode == "all" else [args.mode]
    results = []
    for m in modes:
        tools = mode_map[m]
        res = run_mode(
            mode_name=m,
            tools=tools,
            system_facts=schemas["system_facts_example"],
            suite=suite,
            weights=weights,
        )
        print_report(res, show_failures=args.show_failures)
        results.append(res)

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    tag = Path(weights).stem if weights else "needle3-20L-base"
    out_file = OUT_DIR / f"bench-{tag}-{args.mode}.json"
    out_file.write_text(json.dumps(results, indent=2), encoding="utf-8")
    print(f"\nSaved full benchmark JSON -> {out_file}")


if __name__ == "__main__":
    main()
