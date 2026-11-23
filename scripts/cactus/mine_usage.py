#!/usr/bin/env python3
"""Mine real reflex usage (kai-reflex-log.json) into training rows for the
next Cactus fine-tune.

The store lives in KAI's app-local data dir:
  Windows: %LOCALAPPDATA%/app.kai.terminal/kai-reflex-log.json
The transport appends three outcome kinds (see src/modules/ai/lib/reflexLog.ts):
  executed        reflex handled the prompt locally (calls = canonical KAI)
  fallthrough     reflex passed it to the LLM (with a reason)
  mined-llm-tool  the MAIN LLM executed a reflex-capable tool (ground truth)

What becomes training data (chat format, Cactus Platform):
  1. mined-llm-tool entries -> POSITIVE lines (prompt -> canonical call args,
     translated to the narrow schema via the inverse of kai_mapper).
  2. executed entries       -> POSITIVE lines (already proven good; deduped
     against (1), executed wins because it is user-confirmed behavior).
  3. fallthrough entries with reason low-confidence/empty-calls where the
     SAME prompt was later mined-llm-tool'd -> NEGATIVE lines (the model
     should have returned [] / refused and didn't, or was too unsure).
     A prompt mined as a positive is never also used as a negative.

Dedup by (prompt, canonical calls) fingerprint. Split 90/5/5 train/val/test.
Lines carry the minimal 18-tool training schema exactly like build_dataset.py.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import random
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

STORE_PATHS = [
    # tauri-plugin-store (LazyStore) lives in RoamingAppData for this app
    Path(os.environ.get("APPDATA", "")) / "app.kai.terminal" / "kai-reflex-log.json"
    if os.environ.get("APPDATA")
    else Path.home() / "AppData/Roaming/app.kai.terminal/kai-reflex-log.json",
    Path(os.environ.get("LOCALAPPDATA", "")) / "app.kai.terminal" / "kai-reflex-log.json"
    if os.environ.get("LOCALAPPDATA")
    else Path.home() / "AppData/Local/app.kai.terminal/kai-reflex-log.json",
]

OUT_DIR = HERE / "data"

CANONICAL_TO_NARROW: dict[str, str] = {
    "settings": "get_settings",
    "settings_update": "settings_update-canonical",
    "play_radio": "play_radio",
    "stop_radio": "stop_radio",
    "radio_list_stations": "radio_list_stations",
    "radio_now_playing": "radio_now_playing",
    "voice_settings": "set_voice_settings",
    "reminder_create": "reminder_create-canonical",
    "reminder_list": "reminder_list",
    "reminder_cancel": "reminder_cancel",
    "set_persona": "set_persona",
    "open_preview": "open_preview",
}

# settings_update key -> (narrow tool name, narrow arg key)
SETTINGS_KEY_TO_NARROW: dict[str, tuple[str, str]] = {
    "uiThemeId": ("set_ui_theme", "palette"),
    "theme": ("set_color_mode", "mode"),
    "editorTheme": ("set_editor_theme", "editor_theme"),
    "vimMode": ("set_vim_mode", "enabled"),
    "editorWordWrap": ("set_word_wrap", "enabled"),
    "showHidden": ("set_show_hidden_files", "enabled"),
    "terminalWebglEnabled": ("set_terminal_webgl", "enabled"),
    "terminalFontSize": ("set_terminal_font_size", "font_size"),
    "terminalScrollback": ("set_terminal_scrollback", "lines"),
    "zoomLevel": ("set_zoom_level", "zoom"),
}


def canonical_to_narrow_calls(
    calls: list[dict[str, Any]],
) -> list[dict[str, Any]] | None:
    """Inverse of kai_mapper.to_canonical_kai_calls for the subset the reflex
    can produce. Returns None when a call cannot be represented (skip it)."""
    out: list[dict[str, Any]] = []
    for c in calls:
        name = c.get("name", "")
        args = c.get("arguments") or {}
        narrow = CANONICAL_TO_NARROW.get(name)
        if narrow is None:
            return None
        if narrow == "settings_update-canonical":
            for k, v in args.items():
                if k not in SETTINGS_KEY_TO_NARROW or v is None:
                    return None
                tn, ta = SETTINGS_KEY_TO_NARROW[k]
                out.append({"name": tn, "arguments": {ta: v}})
            continue
        if narrow == "reminder_create-canonical":
            due = str(args.get("dueAt") or "")
            if not due:
                return None
            call: dict[str, Any] = {"name": "schedule_reminder",
                                    "arguments": {"message": args.get("message", ""),
                                                  "due_at": due}}
            if args.get("repeat"):
                call["arguments"]["repeat"] = args["repeat"]
            out.append(call)
            continue
        mapped_args: dict[str, Any] = dict(args)
        if name == "voice_settings":
            if "assemblyVoice" in mapped_args:
                mapped_args["assembly_voice"] = mapped_args.pop("assemblyVoice")
        out.append({"name": narrow, "arguments": mapped_args})
    return out


def training_tools() -> list[dict[str, Any]]:
    schemas = json.loads((HERE / "schemas.json").read_text(encoding="utf-8"))
    drop = {"reminder_cancel", "radio_list_stations", "radio_now_playing"}
    return [
        {"name": t["name"], "description": t["description"][:30],
         "parameters": {"type": "object", "properties": {}, "required": []}}
        for t in schemas["narrow_tools"] if t["name"] not in drop
    ]


SYSTEM_FACTS = "date: 2026-11-23 Mon 14:00; os: windows; shell: pwsh"


def chat_line(prompt: str, narrow_calls: list[dict[str, Any]], tools_openai: list) -> dict:
    calls = []
    for i, c in enumerate(narrow_calls, 1):
        calls.append({
            "id": f"call_{i}",
            "type": "function",
            "function": {"name": c["name"],
                         "arguments": json.dumps(c["arguments"], ensure_ascii=False)},
        })
    reasoning = "; ".join(
        f"{c['name']}({json.dumps(c['arguments'], ensure_ascii=False)})"
        for c in narrow_calls
    ) or "no call"
    return {
        "messages": [
            {"role": "system", "content": SYSTEM_FACTS},
            {"role": "user", "content": prompt},
            {"role": "assistant", "content": "", "reasoning_content": reasoning,
             "tool_calls": calls},
        ],
        "tools": tools_openai,
    }


def load_entries() -> list[dict[str, Any]]:
    for p in STORE_PATHS:
        if p.exists():
            data = json.loads(p.read_text(encoding="utf-8"))
            entries = data.get("entries", [])
            print(f"Loaded {len(entries)} entries from {p}")
            return entries
    print("No kai-reflex-log.json found. Nothing to mine.", file=sys.stderr)
    return []


def mine(entries: list[dict[str, Any]]) -> None:
    tools = training_tools()
    tools_openai = [{"type": "function", "function": t} for t in tools]

    positives: dict[str, list[dict[str, Any]]] = {}  # prompt -> canonical calls
    negatives: dict[str, str] = {}  # prompt -> reason

    for e in entries:
        prompt = str(e.get("prompt") or "").strip()
        if not prompt:
            continue
        outcome = e.get("outcome")
        if outcome == "executed":
            calls = e.get("calls") or []
            if calls:
                positives.setdefault(prompt, calls)
        elif outcome == "mined-llm-tool":
            for c in e.get("calls") or []:
                prev = positives.get(prompt) or []
                if not any(x["name"] == c["name"] for x in prev):
                    prev.append(c)
                positives[prompt] = prev
        elif outcome == "fallthrough":
            reason = str(e.get("reason") or "")
            if reason in ("low-confidence", "empty-calls", "unmapped", "disallowed-tool"):
                negatives[prompt] = reason

    # Drop prompts that ended up positive from the negative set.
    negative_prompts = [p for p in negatives if p not in positives]

    rows: list[tuple[str, dict, str]] = []  # (fingerprint, line, domain)
    seen: set[str] = set()

    def add(prompt: str, narrow_calls: list[dict[str, Any]] | None, dom: str) -> None:
        if narrow_calls is None:
            return
        fp = hashlib.md5(json.dumps([prompt, narrow_calls], sort_keys=True).encode()).hexdigest()
        if fp in seen:
            return
        seen.add(fp)
        rows.append((fp, chat_line(prompt, narrow_calls, tools_openai), dom))

    for prompt, canon_calls in positives.items():
        add(prompt, canonical_to_narrow_calls(canon_calls), "mined-positive")
    for prompt in negative_prompts:
        add(prompt, [], "mined-negative")

    rng = random.Random(7)
    rng.shuffle(rows)
    n = len(rows)
    n_test = max(1, round(n * 0.05)) if n >= 20 else 0
    n_val = max(1, round(n * 0.05)) if n >= 20 else 0
    test, val, train = rows[:n_test], rows[n_test:n_test + n_val], rows[n_test + n_val:]

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    for name, bucket in (("mined_train.jsonl", train), ("mined_validation.jsonl", val),
                         ("mined_test.jsonl", test)):
        path = OUT_DIR / name
        with path.open("w", encoding="utf-8", newline="\n") as f:
            for _, line, _ in bucket:
                f.write(json.dumps(line, ensure_ascii=False) + "\n")
        print(f"Wrote {len(bucket)} -> {path.name}")

    dom_counts: dict[str, int] = {}
    for _, _, d in rows:
        dom_counts[d] = dom_counts.get(d, 0) + 1
    print("Domain mix:", json.dumps(dom_counts, indent=2))
    print("\nSample mined positives:")
    for prompt, canon in list(positives.items())[:5]:
        print(f"  {prompt!r} -> {json.dumps(canon)}")
    if negative_prompts:
        print("Sample mined negatives (reflex too unsure / wrong):")
        for p in negative_prompts[:5]:
            print(f"  {p!r} ({negatives[p]})")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--store", default=None, help="Explicit path to kai-reflex-log.json")
    args = parser.parse_args()
    if args.store:
        STORE_PATHS.insert(0, Path(args.store))
    entries = load_entries()
    if entries:
        mine(entries)
