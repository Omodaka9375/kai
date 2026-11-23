#!/usr/bin/env python3
"""Build the Run #4 training mix from:
  1. Run #2 base data (data/train.jsonl) - the foundation
  2. Live-engine hijack prompts (the 4 real misfires) - HARD NEGATIVES: relabel NO-CALL
  3. Low-confidence real-usage prompts (correct tool but below gate) - POSITIVES
     with the correct tool call the LLM chose
Output: data/train4.jsonl, val4.jsonl, test4.jsonl (90/5/5).
"""
import json, random, sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "data")

# ── 1. Live battery results (Run #4 targets) ─────────────────────────────
hijacks = []   # wrong-tool / wrong-arg executions -> negatives (NO-CALL)
weak_positives = []  # correct tool, fell below gate -> positive examples

def load(name):
    with open(os.path.join(DATA, name), encoding="utf-8") as f:
        return json.load(f)

for fname in ["live-test-results.json", "live-test-variations.json", "live-test-negatives.json"]:
    j = load(fname)
    for r in j["results"]:
        p, conf, calls = r["prompt"], r["confidence"], r["calls"]
        if conf >= 0.75 and calls:  # executed (or would execute)
            hijacks.append(r)

# Hand-label: hijack prompts that misfired above gate (wrong tool or wrong
# arg or should be NO-CALL). From the 2026-11-23 live batteries.
HIJACK_NEGATIVES = [
    # prompt, why it is negative
    ("open the file src/lib.rs in the editor", "file vocab must not open preview"),
    ("what radio station is this", "question about radio must not PLAY radio"),
    ("wait 100000 seconds", "wrong tool entirely"),
    ("set font size to 300", "OOB number, grammar clips 300->30"),
    ("set the font size to 5000", "OOB number"),
    ("remind me in 999999 minutes to test", "OOB duration"),
]
# Real-usage + battery weak spots: correct tool but engine underconfident.
WEAK_POSITIVES = [
    # (prompt, narrow tool, narrow args)
    ("play ambient radio", "play_radio", {"station": "ambient"}),
    ("turn on the radio", "play_radio", {"station": "groovesalad"}),
    ("put on groove salad", "play_radio", {"station": "groovesalad"}),
    ("what's playing", "radio_now_playing", {}),
    ("what is playing on the radio", "radio_now_playing", {}),
    ("now playing", "radio_now_playing", {}),
    ("show me the radio stations", "radio_list_stations", {}),
    ("what stations are there", "radio_list_stations", {}),
    ("which stations can I pick from", "radio_list_stations", {}),
    ("whats playing right now", "radio_now_playing", {}),
    ("switch to dark mode", "settings_update", {"uiThemeId": "dark"}),
    ("turn off dark mode", "settings_update", {"uiThemeId": "default"}),
    ("night mode", "settings_update", {"theme": "dark"}),
    ("ping me in an hour", "set_timer_reminder", {"message": "ping", "minutes": 60}),
    ("remind me to call mom tomorrow morning", "set_timer_reminder", {"message": "call mom", "hours": 24}),
    ("remind me at 6pm to leave", "set_timer_reminder", {"message": "leave", "time": "18:00"}),
    ("set a reminder for 30 minutes from now", "set_timer_reminder", {"minutes": 30}),
    ("I want the architect persona", "set_persona", {"persona": "architect"}),
    ("use the coder agent", "set_persona", {"persona": "coder"}),
    ("activate the architect agent", "set_persona", {"persona": "architect"}),
    ("turn on the reviewer", "set_persona", {"persona": "reviewer"}),
    ("speak with echo voice", "set_voice_settings", {"voice": "echo"}),
    ("preview localhost 8080", "open_preview", {"url": "http://localhost:8080"}),
    ("speak replies with the alloy voice", "set_voice_settings", {"voice": "alloy"}),
    ("remind me to call mom tomorrow morning", "set_timer_reminder", {"message": "call mom", "hours": 24}),
]

SYSTEM = "date: 2026-11-23 Mon; os: windows; shell: pwsh"

def train_line(user_msg, tool_calls=None, reasoning=""):
    if tool_calls:
        tcs = [{"id": f"call_{i+1}", "type": "function",
                "function": {"name": n, "arguments": json.dumps(args)}}
               for i, (n, args) in enumerate(tool_calls)]
    else:
        tcs = []
    return {"messages": [
        {"role": "system", "content": SYSTEM},
        {"role": "user", "content": user_msg},
        {"role": "assistant", "content": "", "reasoning_content": reasoning,
         "tool_calls": tcs}]}

base = [json.loads(l) for l in open(os.path.join(DATA, "train.jsonl"), encoding="utf-8")]
print(f"base rows: {len(base)}")

new_rows = []
for prompt, why in HIJACK_NEGATIVES:
    new_rows.append(train_line(prompt, None, f"'{prompt}' -> NO-CALL ({why})"))
for prompt, tool, args in WEAK_POSITIVES:
    new_rows.append(train_line(prompt, [(tool, args)], f"'{prompt}' -> {tool}"))

# Mined real-usage rows (from mine_usage.py output)
mined = os.path.join(DATA, "mined_train.jsonl")
if os.path.exists(mined):
    with open(mined, encoding="utf-8") as f:
        for line in f:
            if line.strip():
                new_rows.append(json.loads(line))
    print(f"+{sum(1 for l in open(mined, encoding='utf-8') if l.strip())} mined rows")

all_rows = base + new_rows
random.seed(42); random.shuffle(all_rows)
n = len(all_rows)
train_n = int(n*0.9); val_n = int(n*0.05)
train, val, test = all_rows[:train_n], all_rows[train_n:train_n+val_n], all_rows[train_n+val_n:]
for name, rows in [("train4.jsonl", train), ("validation4.jsonl", val), ("test4.jsonl", test)]:
    with open(os.path.join(DATA, name), "w", encoding="utf-8") as f:
        for r in rows:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")
    print(f"{name}: {len(rows)} rows")
