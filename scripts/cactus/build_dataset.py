#!/usr/bin/env python3
"""Generate the KAI V1 Desktop-Controls fine-tuning dataset (Cactus Platform chat format).

Deterministic (seed 0) generator producing a strictly disjoint, de-duplicated split:
  data/train.jsonl      (~1,400 lines)
  data/validation.jsonl (~150)
  data/test.jsonl       (~150)

SCHEMA BUDGET (why 19 tools, compact form, --max-len 2048):
- schemas.json `narrow_tools` has 22 tools whose full serialization is ~2,060 tokens
  of EVERY chat line; Cactus's local trainer defaults to --max-len 1024 and silently
  truncates longer examples (Fine-tuning Needle guide). We train with --max-len 2048
  (platform default) so the full 22-tool schema fits, verified by the worst-case
  line-length check in `validate()`.
- Every assistant turn carries a short `reasoning_content` span derivation
  (Cactus docs: Needle writes this line before every answer; models trained
  without it score lower).
- ~15% no-call negatives (`"tool_calls": []`) of five kinds: negations,
  out-of-bounds, missing-args, coding/workspace (must escalate to the main
  LLM), and general chat. Without these the tuned model calls a tool on
  everything.
- Hard developer negatives collide with desktop-control vocabulary
  ("edit palettes.ts", "why is radio_now_playing failing in radio.ts?",
  "create a new persona that ...", "change my default shell").
- Templates x values x paraphrases are expanded programmatically; an MD5
  fingerprint of (prompt, canonical call) guarantees no duplicate or
  cross-split leakage.
- Dates are relative to a fixed now (2026-11-22 14:00 +01:00) so every
  example resolves against the system facts string Needle sees at scoring.
"""
from __future__ import annotations

import hashlib
import json
import random
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

HERE = Path(__file__).resolve().parent
SCHEMAS_PATH = HERE / "schemas.json"
OUT_DIR = HERE / "data"

SEED = 0
NOW = datetime(2026, 11, 22, 14, 0, 0, tzinfo=timezone(timedelta(hours=1)))
SYSTEM_FACTS = "date: 2026-11-22 Sun 14:00; os: windows; shell: pwsh"

TARGET_TRAIN = 1400
TARGET_VAL = 150
TARGET_TEST = 150
MAX_LINE_CHARS = 5300  # 24-tool minimal schema (Run #5 +6 tools): worst line ~950 tokens, bucket 1,024

STATION_NAMES = [
    "groove salad", "drone zone", "def con radio", "space station soma",
    "lush", "indie pop rocks", "secret agent", "fluid", "sonic universe",
    "bagel radio", "boot liquor", "the trip",
]
STATION_GENRES = ["ambient", "jazz", "chill", "indie", "lounge", "downtempo", "space ambient"]
ALL_STATIONS = STATION_NAMES + STATION_GENRES

PALETTES = [
    ("tokyo night", "tokyo-night"), ("nord", "nord"), ("catppuccin", "catppuccin"),
    ("dracula", "dracula"), ("rose pine", "rose-pine"), ("emerald", "emerald"),
    ("amber", "amber"), ("kanagawa", "kanagawa"), ("gruvbox", "gruvbox"),
    ("solarized", "solarized"), ("one dark", "one-dark"), ("default", "default"),
]
EDITOR_THEMES = [
    ("atom one", "atomone"), ("aura", "aura"), ("copilot", "copilot"),
    ("github dark", "github-dark"), ("github light", "github-light"),
    ("nord", "nord"), ("tokyo night", "tokyo-night"),
    ("xcode dark", "xcode-dark"), ("xcode light", "xcode-light"),
]

PERSONAS = [
    ("coder", "coder"), ("architect", "architect"), ("code reviewer", "reviewer"),
    ("reviewer", "reviewer"), ("security", "security"), ("designer", "designer"),
    ("researcher", "researcher"), ("assistant", "assistant"),
    ("senior engineer", "senior engineer"), ("writer", "writer"),
]

REMINDER_TASKS = [
    "check the deploy", "stretch", "drink water", "review the PR", "take a break",
    "check the build", "ping the team", "water the plants", "check on the tests",
    "push the branch", "close the ticket", "look at the logs", "reply to Alice",
    "start the release", "check the crash report", "file the bug", "update the docs",
    "back up the workspace", "check the DNS", "restart the router",
]

CODE_NEGATIVES = [
    "fix the race condition in src/modules/ai/lib/agent.ts",
    "grep for createProxyFetch across src/",
    "run cargo check and fix any compiler warnings",
    "refactor the theme palette CSS variables in palettes.ts",
    "why is radio_now_playing returning an error in radio.ts?",
    "add a new persona icon option in src/modules/ai/lib/agents.ts",
    "commit my staged changes with a clean message",
    "create a new Test Engineer persona that runs vitest before answering",
    "change my default shell to pwsh and enable autostart",
    "edit palettes.ts to add a contrast boost to the dracula palette",
    "read auth.ts lines 1 to 80 and fix the token refresh bug",
    "write a vitest for the reminder scheduler",
    "open https://github.com/Omodaka9375/kai/pulls and summarize open PRs",
    "git rebase the feature branch onto main",
    "optimize the xterm renderer pooling code",
    "explain the pty session spawn lock in session.rs",
    "what is the difference between ConPTY and portable-pty on Windows?",
    "how do Tauri Channels stream bytes to React?",
    "summarize the changes in the last commit",
    "find all uses of patchSessionAgentMeta in chatStore.ts",
    "extract the station list from stations.ts into a json file",
    "benchmark the needle engine against the wasm runtime",
    "search the web for tauri 2 release notes",
    "check the ssl certificate for cactuscompute.com",
    "grep for TODO comments in the rust modules",
    "explain how the shadow mode copies files",
    "profile the startup time of the webview",
    "debug why the terminal freezes on large output",
    "write a migration for the sessions store",
    "rename the radio module to audio",
    "delete the unused themes from palettes.ts",
    "run the full vitest suite and fix failures",
    "what does the kv_window config option do?",
    "how does the engram table differ from attention?",
    "summarize the open issues on the github repo",
    "check whether pnpm is installed and its version",
    "set up a new rust module for the engine bridge",
    "review the diff of my last commit",
    "find memory leaks in the pty session cleanup",
    "convert the reminder store to sqlite",
]
CHAT_NEGATIVES = [
    "what is the capital of France?",
    "tell me a joke about terminal emulators",
    "how was your day?",
    "what year did Rust 1.0 ship?",
    "give me ideas for a blog post about local models",
    "translate 'good morning' into Hungarian",
    "who wrote the pomodoro technique?",
    "what should I name my new side project?",
    "explain quantum computing in one paragraph",
    "write a haiku about grep",
]

SCHEMA_NARROW = json.loads(SCHEMAS_PATH.read_text(encoding="utf-8"))["narrow_tools"]

# Training schema: 18 tools (drop reminder_cancel / radio_list_stations /
# radio_now_playing), 30-char descriptions, NO parameter schemas. The full
# 22-tool block with params renders to ~1,823 tokens per line and blew up
# Run #1 on the platform (execution_failed at step 2, refunded). The parameter
# SHAPES are learned from the answers themselves; at INFERENCE the runtime is
# handed the full schemas.json narrow_tools (decode grammar is a runtime
# concern, not a training concern).
TRAINING_DROP = {"reminder_cancel", "radio_list_stations", "radio_now_playing"}


def training_tools() -> list[dict[str, Any]]:
    return [
        {
            "name": t["name"],
            "description": t["description"][:30],
            "parameters": {"type": "object", "properties": {}, "required": []},
        }
        for t in SCHEMA_NARROW
        if t["name"] not in TRAINING_DROP
    ]


def iso(dt: datetime) -> str:
    return dt.isoformat(timespec="seconds")


def reasoning_join(pairs: list[str]) -> str:
    return "; ".join(p for p in pairs if p)


def tool_call(idx: int, name: str, arguments: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": f"call_{idx}",
        "type": "function",
        "function": {"name": name, "arguments": json.dumps(arguments, ensure_ascii=False)},
    }


def chat_line(calls: list[dict[str, Any]], reasoning: str, tools: list[dict[str, Any]], prompt: str) -> dict[str, Any]:
    return {
        "messages": [
            {"role": "system", "content": SYSTEM_FACTS},
            {"role": "user", "content": prompt},
            {
                "role": "assistant",
                "content": "",
                "reasoning_content": reasoning,
                "tool_calls": calls,
            },
        ],
        "tools": tools,
    }


def wraps(name: str, arguments: dict[str, Any], reasoning: str, tools: list[dict[str, Any]], prompt: str):
    """One canonical example -> (line, fingerprint)."""
    line = chat_line(
        [tool_call(1, name, arguments)] if name else [],
        reasoning,
        tools,
        prompt,
    )
    fp = hashlib.md5(json.dumps([prompt, name, arguments], sort_keys=True).encode()).hexdigest()
    return line, fp


def wraps_multi(
    calls: list[tuple[str, dict[str, Any]]],
    reasoning: str,
    tools: list[dict[str, Any]],
    prompt: str,
):
    """Multi-call example -> (line, fingerprint). Calls are emitted in the given order."""
    line = chat_line(
        [tool_call(i + 1, n, a) for i, (n, a) in enumerate(calls)],
        reasoning,
        tools,
        prompt,
    )
    fp = hashlib.md5(json.dumps([prompt, calls], sort_keys=True).encode()).hexdigest()
    return line, fp


def make_examples() -> tuple[list[tuple], dict[str, int]]:
    tools_openai = [{"type": "function", "function": t} for t in training_tools()]
    # Hold-out discipline: the frozen eval suite (eval_suite.jsonl) must NEVER
    # overlap the fine-tuning data. Skip any generated prompt that collides.
    eval_suite_path = HERE / "eval_suite.jsonl"
    eval_prompts: set[str] = set()
    if eval_suite_path.exists():
        eval_prompts = {
            json.loads(l)["prompt"]
            for l in eval_suite_path.read_text(encoding="utf-8").splitlines() if l.strip()
        }
    rng = random.Random(SEED)
    out: list[tuple] = []  # (line, fingerprint, domain)
    stats: dict[str, int] = {}
    skipped = {"eval_collision": 0}

    def add(line, fp, domain):
        if line["messages"][1]["content"] in eval_prompts:
            skipped["eval_collision"] += 1
            return
        out.append((line, fp, domain))
        stats[domain] = stats.get(domain, 0) + 1

    # ── set_ui_theme ─────────────────────────────────────────────────────
    theme_verbs = [
        "switch ui theme to {}", "change the app color palette to {}",
        "use {} theme for the app", "set palette to {}", "make the app look {}",
        "apply the {} palette", "i want the {} look", "theme the app with {}",
        "give the app a {} style", "put the ui on {}", "switch to the {} theme",
        "let's go with {} for the palette",
    ]
    for spoken, ident in PALETTES:
        for tpl in theme_verbs:
            prompt = tpl.format(spoken)
            add(*wraps(
                "set_ui_theme", {"palette": ident},
                reasoning_join([f"'{spoken}' -> palette '{ident}'"]),
                tools_openai, prompt,
            ), "set_ui_theme")

    # ── set_color_mode ───────────────────────────────────────────────────
    mode_verbs = [
        "switch to {} mode", "turn on {} mode", "change appearance to {}",
        "use the {} theme", "set color mode to {}", "go {} for the app",
        "make it {}", "set the ui to {}",
    ]
    for spoken in ("dark", "light", "system"):
        for tpl in mode_verbs:
            prompt = tpl.format(spoken)
            add(*wraps(
                "set_color_mode", {"mode": spoken},
                reasoning_join([f"'{spoken}' -> mode '{spoken}'"]),
                tools_openai, prompt,
            ), "set_color_mode")

    # ── set_editor_theme ─────────────────────────────────────────────────
    editor_verbs = [
        "set the code editor theme to {}", "change editor syntax theme to {}",
        "use {} for the editor", "editor theme {}", "make the editor use {}",
        "switch the editor highlighting to {}", "apply {} to the code editor",
    ]
    for spoken, ident in EDITOR_THEMES:
        for tpl in editor_verbs:
            prompt = tpl.format(spoken)
            add(*wraps(
                "set_editor_theme", {"editor_theme": ident},
                reasoning_join([f"'{spoken}' -> editor_theme '{ident}'"]),
                tools_openai, prompt,
            ), "set_editor_theme")

    # ── boolean comfort toggles ──────────────────────────────────────────
    comfort = [
        ("set_vim_mode", "enabled",
         ["enable vim mode in the editor", "turn on vim keybindings", "i want vim mode",
          "turn vim mode on", "activate vim keybindings", "start vim mode"],
         ["turn off vim keybindings", "disable vim mode", "no more vim mode",
          "turn vim mode off", "switch off vim keybindings", "stop vim mode"]),
        ("set_word_wrap", "enabled",
         ["turn on word wrap in the editor", "enable word wrap", "wrap long lines in the editor",
          "turn on line wrapping", "enable editor word wrap", "use word wrap"],
         ["turn off word wrap", "disable line wrapping", "stop wrapping lines",
          "turn word wrap off", "disable word wrap in the editor", "no word wrap"]),
        ("set_show_hidden_files", "enabled",
         ["show hidden files in the explorer", "reveal dotfiles", "display hidden files",
          "show dotfiles in the tree", "enable hidden files view", "make hidden files visible"],
         ["hide hidden files in the explorer", "stop showing dotfiles", "hide dotfiles",
          "turn off hidden files view", "don't show hidden files", "disable hidden files"]),
        ("set_terminal_webgl", "enabled",
         ["disable terminal webgl rendering", "turn on terminal webgl",
          "enable webgl for the terminal", "use hardware acceleration in the terminal",
          "turn on gpu rendering in the terminal", "enable terminal webgl renderer"],
         ["turn off terminal webgl", "disable webgl rendering in the terminal",
          "stop hardware acceleration for the terminal", "switch terminal rendering off webgl",
          "disable gpu terminal renderer", "turn webgl off in the terminal"]),
    ]
    for tool, arg, on_phrases, off_phrases in comfort:
        for p in on_phrases:
            add(*wraps(
                tool, {"enabled": True},
                reasoning_join([f"'{p}' -> {arg} true"]),
                tools_openai, p,
            ), tool)
        for p in off_phrases:
            add(*wraps(
                tool, {"enabled": False},
                reasoning_join([f"'{p}' -> {arg} false"]),
                tools_openai, p,
            ), tool)

    # ── terminal display numbers ─────────────────────────────────────────
    for n in (10, 12, 13, 14, 15, 16, 18, 20, 22, 24):
        for tpl in ("set terminal font size to {}",
                    "change the terminal font to {} points",
                    "make the terminal font size {}",
                    "terminal font size {}"):
            prompt = tpl.format(n)
            add(*wraps(
                "set_terminal_font_size", {"font_size": n},
                reasoning_join([f"'{n}' -> font_size {n}"]),
                tools_openai, prompt,
            ), "set_terminal_font_size")
    for n in (500, 1000, 2000, 5000, 10000, 20000, 50000):
        for tpl in ("set terminal scrollback to {} lines",
                    "increase terminal scrollback to {}",
                    "keep {} lines of scrollback in the terminal",
                    "terminal scrollback buffer {}"):
            prompt = tpl.format(n)
            add(*wraps(
                "set_terminal_scrollback", {"lines": n},
                reasoning_join([f"'{n}' -> lines {n}"]),
                tools_openai, prompt,
            ), "set_terminal_scrollback")
    for z in (0.5, 0.75, 0.9, 1.1, 1.25, 1.5, 1.75, 2.0):
        for tpl in ("set app zoom level to {}",
                    "zoom the app to {}",
                    "change app zoom to {}",
                    "ui zoom {}"):
            prompt = tpl.format(z)
            add(*wraps(
                "set_zoom_level", {"zoom": z},
                reasoning_join([f"'{z}' -> zoom {z}"]),
                tools_openai, prompt,
            ), "set_zoom_level")

    # ── get_settings ─────────────────────────────────────────────────────
    for p in ("show my current kai settings", "what are my kai settings?",
              "read the current theme and terminal settings",
              "list kai configuration", "what theme and font size am i using?",
              "show kai settings", "get my settings", "display current kai config",
              "what's my current setup?", "read my settings",
              "what settings do i have?", "show the configuration"):
        add(*wraps(
            "get_settings", {},
            reasoning_join(["'current kai settings' -> get_settings"]),
            tools_openai, p,
        ), "get_settings")

    # ── radio ────────────────────────────────────────────────────────────
    # NOTE (Run #3): "list stations" / "now playing" questions are NO-CALL
    # negatives. Run #2 relabeled them to play_radio("") which taught the
    # model to emit empty-station plays; the main LLM answers them better and
    # can offer to play.
    play_verbs = [
        "play {} on the radio", "put on {}", "play {}", "start {} in the status bar",
        "i want to hear {}", "radio {}", "tune to {}", "give me {}",
        "switch the radio to {}", "cue up {}", "listen to {}", "set the mood with {}",
        "play some {}", "start the {} stream",
    ]
    for station in ALL_STATIONS:
        for tpl in play_verbs:
            prompt = tpl.format(station)
            add(*wraps(
                "play_radio", {"station": station},
                reasoning_join([f"'{station}' -> station '{station}'"]),
                tools_openai, prompt,
            ), "play_radio")
    for p in ("stop the radio", "turn off the music", "pause the radio",
              "stop the music", "silence the radio", "kill the music",
              "stop background music", "turn the radio off", "no more music",
              "quit the radio", "end the music", "stop the stream"):
        add(*wraps(
            "stop_radio", {},
            reasoning_join([f"'{p}' -> stop_radio"]),
            tools_openai, p,
        ), "stop_radio")
    for p in ("what radio stations are available?", "list the soma stations",
              "what stations can i play?", "show radio stations",
              "list radio stations", "which channels are there?",
              "available stations", "what music stations exist?"):
        add(*wraps(
            None, {},
            "informational question about stations, no action requested -> no desktop tool fits",
            tools_openai, p,
        ), "neg_radio_list")
    for p in ("what song is playing right now?", "which track is on?",
              "what's currently playing?", "now playing on the radio",
              "which song is this?", "current radio track",
              "what artist is playing?", "tell me the song on the radio"):
        add(*wraps(
            None, {},
            "informational question about the current song, no action -> no desktop tool fits",
            tools_openai, p,
        ), "neg_radio_now")

    # ── voice / TTS ──────────────────────────────────────────────────────
    for p in ("turn off voice replies", "disable tts", "stop speaking replies",
              "mute the assistant voice", "no voice output", "silence voice"):
        add(*wraps(
            "set_voice_settings", {"mode": "off"},
            reasoning_join([f"'{p}' -> mode 'off'"]),
            tools_openai, p,
        ), "set_voice_settings")
    for p in ("switch tts engine to local", "use the local voice engine",
              "run voice locally with piper", "tts offline please",
              "use piper for the voice", "local voice engine",
              "switch the tts to local engine", "voice engine local",
              "use offline tts", "set speech engine to local",
              "text to speech should be local", "speak with the local engine",
              "switch tts engine to assemblyai", "use assemblyai for tts",
              "assemblyai engine for speech"):
        mode = "assemblyai" if "assemblyai" in p else "local"
        add(*wraps(
            "set_voice_settings", {"mode": mode},
            reasoning_join([f"'{p}' -> mode '{mode}'"]),
            tools_openai, p,
        ), "set_voice_settings")
    for p in ("switch tts engine to api", "use openai for the voice",
              "use the api voice engine", "cloud tts engine",
              "switch tts to the openai engine", "use cloud voice",
              "set speech engine to api"):
        add(*wraps(
            "set_voice_settings", {"mode": "api"},
            reasoning_join([f"'{p}' -> mode 'api'"]),
            tools_openai, p,
        ), "set_voice_settings")
    for v in ("alloy", "echo", "fable", "onyx", "nova", "shimmer", "coral",
              "sage", "ash", "ballad", "verse"):
        for tpl in ("change openai voice to {}", "use the {} voice",
                    "speak with {}", "voice {}", "make the assistant speak as {}",
                    "tts voice {}", "i want the {} voice",
                    "switch the openai tts voice to {}", "set speech voice to {}"):
            prompt = tpl.format(v)
            add(*wraps(
                "set_voice_settings", {"voice": v},
                reasoning_join([f"'{v}' -> voice '{v}'"]),
                tools_openai, prompt,
            ), "set_voice_settings")
    for a in ("aai-jane", "aai-audrey", "aai-sara", "aai-michael", "aai-paul",
              "aai-charles", "aai-eve", "aai-george"):
        for tpl in ("use the assembly voice {}", "assemblyai voice {}",
                    "switch assembly voice to {}", "tts engine assemblyai voice {}"):
            prompt = tpl.format(a)
            add(*wraps(
                "set_voice_settings", {"assembly_voice": a},
                reasoning_join([f"'{a}' -> assembly_voice '{a}'"]),
                tools_openai, prompt,
            ), "set_voice_settings")
    for p in ("list available tts voices", "which voices are there?",
              "show the voice catalog", "what voices can i pick?",
              "list voices", "voice options"):
        add(*wraps(
            "set_voice_settings", {"list": True},
            reasoning_join([f"'{p}' -> list true"]),
            tools_openai, p,
        ), "set_voice_settings")

    # ── reminders ────────────────────────────────────────────────────────
    timer_verbs = [
        "remind me in {} to {}", "in {} remind me to {}",
        "set a reminder in {} to {}", "timer for {} to {}",
        "after {} remind me about {}", "{} from now, remind me to {}",
        "ping me in {} to {}",
    ]
    spans = [("5 minutes", 5, 0), ("10 minutes", 10, 0), ("15 minutes", 15, 0),
             ("20 minutes", 20, 0), ("30 minutes", 30, 0), ("45 minutes", 45, 0),
             ("1 hour", 0, 1), ("90 minutes", 90, 0), ("2 hours", 0, 2),
             ("3 hours", 0, 3), ("4 hours", 0, 4), ("6 hours", 0, 6)]
    for (span, mins, hrs), tpl in [(s, t) for s in spans for t in timer_verbs]:
        task = rng.choice(REMINDER_TASKS)
        prompt = tpl.format(span, task)
        add(*wraps(
            "set_timer_reminder",
            {"message": task, **({"minutes": mins} if mins else {"hours": hrs})},
            reasoning_join([
                f"'{span}' -> {'minutes ' + str(mins) if mins else 'hours ' + str(hrs)}",
                f"'{task}' -> message",
            ]),
            tools_openai, prompt,
        ), "set_timer_reminder")
    cal_verbs = [
        "remind me {} at {} to {}", "{} at {}, remind me to {}",
        "schedule a reminder {} at {} for {}", "set a reminder {} at {} to {}",
        "don't forget: {} at {}, {}", "on {} at {} remind me about {}",
    ]
    cal_spans = [("tomorrow", 9), ("tomorrow", 15), ("monday", 9), ("friday", 17),
                 ("saturday", 10), ("next monday", 9), ("tonight", 20), ("this evening", 19)]
    weekdays = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]
    for (when, hour), tpl in [(s, t) for s in cal_spans for t in cal_verbs]:
        task = rng.choice(REMINDER_TASKS)
        prompt = tpl.format(when, hour, task)
        if when in weekdays:
            offset = (weekdays.index(when) - NOW.weekday()) % 7
            offset = offset if offset > 0 else 7
            target = (NOW + timedelta(days=offset)).replace(hour=hour, minute=0, second=0)
        elif when == "next monday":
            target = (NOW + timedelta(days=13)).replace(hour=hour, minute=0, second=0)
        elif when == "tomorrow":
            target = (NOW + timedelta(days=1)).replace(hour=hour, minute=0, second=0)
        else:  # tonight / this evening
            target = NOW.replace(hour=hour, minute=0, second=0)
        add(*wraps(
            "schedule_reminder",
            {"message": task, "due_at": iso(target)},
            reasoning_join([
                f"'{when} at {hour}' -> due_at '{iso(target)}'",
                f"'{task}' -> message",
            ]),
            tools_openai, prompt,
        ), "schedule_reminder")
    for p in ("list my upcoming reminders", "what reminders do i have?",
              "show pending reminders", "list reminders", "my reminders",
              "which reminders exist?", "show my reminders"):
        add(*wraps(
            "reminder_list", {},
            reasoning_join([f"'{p}' -> reminder_list"]),
            tools_openai, p,
        ), "reminder_list")

    # ── Run #5 domains (2026-11-23) ───────────────────────────────────
    # Zero-argument, every-instance tools. Domain-specific hard negatives
    # ride the shared negative lists below (stop-the-build must escalate,
    # "what timezone is github in" is a web question, etc).

    # get_time - date/time/weekday questions answered locally
    for p in ("what time is it?", "what's the time?", "current time please",
              "what date is it today?", "today's date", "what day is it?",
              "what's today?", "tell me the current date and time",
              "which day of the week is it?", "what day is today",
              "give me the time", "date and time please", "the time?",
              "what is the date", "show me the current time",
              "milyen nap van ma?", "hány óra van?", "mennyi az idő?",
              "mi a dátum ma?"):
        add(*wraps(
            "get_time", {},
            reasoning_join(["date/time question -> get_time"]),
            tools_openai, p,
        ), "get_time")

    # stop_agent - cancel the CURRENT run (bare 'stop' stays conversational)
    for p in ("stop the agent", "stop the current run", "cancel the run",
              "stop the agent please", "halt the generation",
              "cancel the current generation", "stop generating",
              "interrupt the running agent", "stop what you're doing",
              "cancel this reply", "abort the current run",
              "kill the running agent", "stop the agent run"):
        add(*wraps(
            "stop_agent", {},
            reasoning_join([f"'{p}' -> stop_agent"]),
            tools_openai, p,
        ), "stop_agent")

    # new_session - fresh chat, old transcript kept
    for p in ("new session", "start a new session", "new chat",
              "start a new chat", "let's start fresh",
              "start a fresh conversation", "begin a new conversation",
              "i want a blank chat", "clean slate, new chat",
              "open a new session", "fresh session please"):
        add(*wraps(
            "new_session", {},
            reasoning_join([f"'{p}' -> new_session"]),
            tools_openai, p,
        ), "new_session")

    # list_skills - saved capabilities read
    for p in ("what skills do i have?", "list my skills",
              "show the available skills", "which skills are saved?",
              "list skills", "what can you do with skills?",
              "show saved capabilities", "my skills"):
        add(*wraps(
            "list_skills", {},
            reasoning_join([f"'{p}' -> list_skills"]),
            tools_openai, p,
        ), "list_skills")

    # list_personas - persona roster read
    for p in ("what personas do i have?", "list my personas",
              "which personas are available?", "list agents",
              "show the personas", "what agents can i use?",
              "my personas", "available personas"):
        add(*wraps(
            "list_personas", {},
            reasoning_join([f"'{p}' -> list_personas"]),
            tools_openai, p,
        ), "list_personas")

    # list_sessions - session roster read
    for p in ("which sessions are open?", "list my sessions",
              "show the sessions", "what chats do i have?",
              "list the chats in this project", "my sessions",
              "show my conversations", "which chats exist?"):
        add(*wraps(
            "list_sessions", {},
            reasoning_join([f"'{p}' -> list_sessions"]),
            tools_openai, p,
        ), "list_sessions")

    # Domain hard negatives for the Run #5 zero-argument domains: sound
    # like a domain but must escalate (coding/workspace phrasings).
    RUN5_NEGATIVES = [
        ("stop the build", "build stop is a coding action, not the agent run -> no call"),
        ("stop the dev server and commit", "coding request -> no desktop tool fits"),
        ("cancel the deploy", "deploy cancellation is a workspace action -> no call"),
        ("kill the vite process", "process management is a terminal action -> no call"),
        ("what time is it in tokyo?", "timezone conversion needs the web/LLM, not local clock -> no call"),
        ("what time does the github actions run finish?", "external service question -> no call"),
        ("new session for the sparky project", "project-scoped request needs context -> no call"),
        ("create a session store migration", "coding request -> no call"),
        ("delete my old sessions", "destructive action, not a list read -> no call"),
        ("list the session ids from chatStore.ts", "code inspection request -> no call"),
        ("switch to the senior engineer persona", "persona SWITCH is set_persona's job, not a list -> no call"),
        ("write a new persona for testing", "persona creation is a coding/LLM action -> no call"),
        ("install the radio skill for me", "skill creation is human-gated -> no call"),
        ("what's in the deploy-status skill?", "skill BODY read needs read_file -> no call"),
    ]

    print("Skipped eval-suite collisions:", skipped)

    # ── persona ──────────────────────────────────────────────────────────
    persona_verbs = [
        "switch to the {} persona", "activate {} persona", "use the {} persona",
        "become {}", "act as the {}", "switch persona to {}", "change persona to {}",
        "be the {} agent", "i want the {} persona",
    ]
    for spoken, ident in PERSONAS:
        for tpl in persona_verbs:
            prompt = tpl.format(spoken)
            add(*wraps(
                "set_persona", {"persona": ident},
                reasoning_join([f"'{spoken}' -> persona '{ident}'"]),
                tools_openai, prompt,
            ), "set_persona")
    for p in ("clear active persona, use none", "no persona for now",
              "remove the active persona", "switch persona to none",
              "drop the persona", "work without a persona", "persona none"):
        add(*wraps(
            "set_persona", {"persona": "none"},
            reasoning_join([f"'{p}' -> persona 'none'"]),
            tools_openai, p,
        ), "set_persona")

    # ── preview ──────────────────────────────────────────────────────────
    for port in (3000, 4173, 5173, 5174, 8000, 8080, 8888, 9000, 1420, 1430):
        for tpl in ("open preview at http://localhost:{}",
                    "preview http://localhost:{}",
                    "show http://localhost:{} in the preview tab",
                    "open localhost:{} in the preview",
                    "load the dev server preview for localhost:{}"):
            prompt = tpl.format(port)
            add(*wraps(
                "open_preview", {"url": f"http://localhost:{port}"},
                reasoning_join([f"'localhost:{port}' -> url"]),
                tools_openai, prompt,
            ), "open_preview")
    for host in ("127.0.0.1", "localhost"):
        for tpl in ("preview http://{}:5000",
                    "open http://{}:5000 in preview",
                    "show http://{}:5000 in the preview tab"):
            prompt = tpl.format(host)
            add(*wraps(
                "open_preview", {"url": f"http://{host}:5000"},
                reasoning_join([f"'http://{host}:5000' -> url"]),
                tools_openai, prompt,
            ), "open_preview")

    # ── NO-CALL NEGATIVES (~25% of the total) ────────────────────────────
    negatives: list[tuple[str, str, str]] = []
    negations = [
        "don't stop the radio", "do not switch to light mode",
        "don't change the theme", "don't set a reminder",
        "don't turn off voice replies", "do not play any music",
        "don't enable vim mode", "don't cancel my reminders",
        "no need to switch persona", "don't touch the terminal font size",
        "please don't change the zoom level", "don't open the preview",
        "don't switch to dark mode", "do not change the editor theme",
        "don't turn on word wrap", "do not hide the dotfiles",
        "don't disable terminal webgl", "don't change my voice settings",
        "do not switch the tts engine", "don't schedule anything",
        "no reminders please", "don't play groove salad",
        "do not touch the scrollback", "don't zoom the app",
        "don't switch personas", "never change the palette",
        "do not set any timers", "don't touch the terminal settings",
        "don't use the local voice", "no theme changes",
    ]
    for p in negations:
        negatives.append((p, f"negated request ('{p}') -> no call", "negation"))
    oob = [
        ("set terminal font size to 96", "96 exceeds maximum font_size 32", "neg_oob"),
        ("set terminal font size to 0", "0 is below minimum font_size 8", "neg_oob"),
        ("set terminal font size to 100", "100 exceeds maximum font_size 32", "neg_oob"),
        ("set terminal font size to 3", "3 is below minimum font_size 8", "neg_oob"),
        ("set terminal scrollback to 10 lines", "10 is below minimum scrollback 200", "neg_oob"),
        ("set terminal scrollback to 999999 lines", "999999 exceeds maximum scrollback 50000", "neg_oob"),
        ("set terminal scrollback to 50 lines", "50 is below minimum scrollback 200", "neg_oob"),
        ("set app zoom level to 4", "4 exceeds maximum zoom 2.0", "neg_oob"),
        ("set app zoom level to 0.1", "0.1 is below minimum zoom 0.5", "neg_oob"),
        ("set app zoom to 5x", "5 exceeds maximum zoom 2.0", "neg_oob"),
        ("remind me in 0 minutes to stretch", "0 is below minimum minutes 1", "neg_oob"),
        ("set a timer for 20000 minutes", "20000 exceeds maximum minutes 10080", "neg_oob"),
        ("remind me in 500 hours to check the build", "500 exceeds maximum hours 168", "neg_oob"),
        ("cancel my reminder", "missing required reminder id", "neg_oob"),
        ("cancel reminder", "missing required reminder id", "neg_oob"),
    ]
    for p, why, dom in oob:
        negatives.append((p, why, dom))
    for p in CODE_NEGATIVES:
        negatives.append((p, "coding/workspace request, not a desktop control -> no desktop tool fits", "neg_code"))
    for p in CHAT_NEGATIVES:
        negatives.append((p, "general chat question -> no desktop tool fits", "neg_chat"))
    # Run #5 domain hard negatives (defined with the Run #5 generators
    # above; appended here where the negatives bucket is open).
    negatives.extend((p, why, "neg_run5") for p, why in RUN5_NEGATIVES)
    for p, why, dom in negatives:
        if p in eval_prompts:
            skipped["eval_collision"] += 1
            continue
        line, fp = wraps(None, {}, why, tools_openai, p)
        out.append((line, fp, dom))
        stats[dom] = stats.get(dom, 0) + 1

    # ── MULTI-CALL COMPOSITIONS (Run #3: Run #2 had zero of these and
    #    dropped the second intent of every multi-intent prompt) ───────────
    multi = [
        ("switch to dark mode and play groove salad",
         [("set_color_mode", {"mode": "dark"}), ("play_radio", {"station": "groove salad"})],
         "'dark mode' -> set_color_mode dark; 'groove salad' -> play_radio"),
        ("stop the radio and enable vim mode",
         [("stop_radio", {}), ("set_vim_mode", {"enabled": True})],
         "'stop the radio' -> stop_radio; 'enable vim mode' -> enabled true"),
        ("set ui theme to nord and terminal font size to 14",
         [("set_ui_theme", {"palette": "nord"}), ("set_terminal_font_size", {"font_size": 14})],
         "'nord' -> palette 'nord'; '14' -> font_size 14"),
        ("turn on word wrap and set the editor theme to github dark",
         [("set_word_wrap", {"enabled": True}), ("set_editor_theme", {"editor_theme": "github-dark"})],
         "'turn on word wrap' -> enabled true; 'github dark' -> editor_theme 'github-dark'"),
        ("play drone zone and set app zoom to 1.5",
         [("play_radio", {"station": "drone zone"}), ("set_zoom_level", {"zoom": 1.5})],
         "'drone zone' -> station; '1.5' -> zoom 1.5"),
        ("change the palette to catppuccin and show hidden files",
         [("set_ui_theme", {"palette": "catppuccin"}), ("set_show_hidden_files", {"enabled": True})],
         "'catppuccin' -> palette; 'show hidden files' -> enabled true"),
        ("switch to light mode and disable vim keybindings",
         [("set_color_mode", {"mode": "light"}), ("set_vim_mode", {"enabled": False})],
         "'light mode' -> mode light; 'disable vim keybindings' -> enabled false"),
        ("set terminal font size to 18 and scrollback to 20000",
         [("set_terminal_font_size", {"font_size": 18}), ("set_terminal_scrollback", {"lines": 20000})],
         "'18' -> font_size 18; '20000' -> lines 20000"),
        ("turn off voice replies and switch to dark mode",
         [("set_voice_settings", {"mode": "off"}), ("set_color_mode", {"mode": "dark"})],
         "'turn off voice replies' -> mode off; 'dark mode' -> mode dark"),
        ("play some ambient and remind me in 30 minutes to stretch",
         [("play_radio", {"station": "ambient"}), ("set_timer_reminder", {"message": "stretch", "minutes": 30})],
         "'ambient' -> station; '30 minutes' -> minutes 30; 'stretch' -> message"),
        ("switch to the architect persona and change the palette to dracula",
         [("set_persona", {"persona": "architect"}), ("set_ui_theme", {"palette": "dracula"})],
         "'architect' -> persona; 'dracula' -> palette 'dracula'"),
        ("disable terminal webgl and set terminal scrollback to 5000",
         [("set_terminal_webgl", {"enabled": False}), ("set_terminal_scrollback", {"lines": 5000})],
         "'disable terminal webgl' -> enabled false; '5000' -> lines 5000"),
    ]
    for prompt, calls, why in multi:
        if prompt in eval_prompts:
            skipped["eval_collision"] += 1
            continue
        line, fp = wraps_multi(calls, why, tools_openai, prompt)
        out.append((line, fp, "multi_call"))
        stats["multi_call"] = stats.get("multi_call", 0) + 1

    return out, stats


def split_and_write(all_items: list[tuple]) -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    seen: set[str] = set()
    deduped: list[tuple] = []
    for line, fp, domain in all_items:
        if fp in seen:
            continue
        seen.add(fp)
        deduped.append((line, fp, domain))

    rng = random.Random(SEED)
    rng.shuffle(deduped)

    # Stratify: proportional domain mix in every split
    by_domain: dict[str, list] = {}
    for item in deduped:
        by_domain.setdefault(item[2], []).append(item)

    train, val, test = [], [], []
    for domain, items in by_domain.items():
        n = len(items)
        n_test = max(1, round(n * 0.10))
        n_val = max(1, round(n * 0.10))
        test.extend(items[:n_test])
        val.extend(items[n_test:n_test + n_val])
        train.extend(items[n_test + n_val:])

    def trim(bucket, target):
        if len(bucket) <= target:
            return bucket
        rng.shuffle(bucket)
        return bucket[:target]

    train = trim(train, TARGET_TRAIN)
    val = trim(val, TARGET_VAL)
    test = trim(test, TARGET_TEST)

    rng.shuffle(train)
    rng.shuffle(val)
    rng.shuffle(test)

    def dump(path: Path, bucket: list[tuple]) -> int:
        with path.open("w", encoding="utf-8", newline="\n") as f:
            for line, _, _ in bucket:
                f.write(json.dumps(line, ensure_ascii=False) + "\n")
        return len(bucket)

    n1 = dump(OUT_DIR / "train.jsonl", train)
    n2 = dump(OUT_DIR / "validation.jsonl", val)
    n3 = dump(OUT_DIR / "test.jsonl", test)
    print(f"Wrote {n1} -> train.jsonl, {n2} -> validation.jsonl, {n3} -> test.jsonl")
    print("Domain mix:", json.dumps({k: v for k, v in sorted(stats.items())}, indent=2))
    fps = {"train": {fp for _, fp, _ in train},
           "val": {fp for _, fp, _ in val},
           "test": {fp for _, fp, _ in test}}
    overlaps = (fps["train"] & fps["val"]) | (fps["train"] & fps["test"]) | (fps["val"] & fps["test"])
    print(f"Cross-split fingerprint overlaps: {len(overlaps)}")


def validate(all_lines: list[dict[str, Any]], max_chars: int) -> None:
    errors = []
    for idx, line in enumerate(all_lines, 1):
        if "messages" not in line or "tools" not in line:
            errors.append(f"line {idx}: missing messages/tools")
            continue
        msgs = line["messages"]
        if len(msgs) != 3 or msgs[0]["role"] != "system" or msgs[1]["role"] != "user" \
                or msgs[2]["role"] != "assistant":
            errors.append(f"line {idx}: bad message roles")
            continue
        rc = msgs[2].get("reasoning_content", "")
        if not isinstance(rc, str) or not rc.strip():
            errors.append(f"line {idx}: empty reasoning_content")
        for tc in msgs[2]["tool_calls"]:
            fn = tc["function"]
            if fn["name"] != fn["name"].lower() or " " in fn["name"]:
                errors.append(f"line {idx}: tool name not snake_case: {fn['name']}")
            try:
                json.loads(fn["arguments"])
            except json.JSONDecodeError:
                errors.append(f"line {idx}: arguments is not valid JSON string")
        valid_names = {t["function"]["name"] for t in line["tools"]}
        for tc in msgs[2]["tool_calls"]:
            if tc["function"]["name"] not in valid_names:
                errors.append(f"line {idx}: call to undeclared tool {tc['function']['name']}")
        line_chars = len(json.dumps(line))
        if line_chars > max_chars:
            errors.append(f"line {idx}: {line_chars} chars exceeds max {max_chars}")
    if errors:
        print(f"VALIDATION FAILURES ({len(errors)}):")
        for e in errors[:20]:
            print("  " + e)
        raise SystemExit(1)
    print(f"Validation PASSED on {len(all_lines)} lines (max_chars={max_chars}).")


def check_no_leakage(eval_suite_path: Path, all_lines: list[dict[str, Any]]) -> None:
    suite_prompts = {
        json.loads(l)["prompt"]
        for l in eval_suite_path.read_text(encoding="utf-8").splitlines() if l.strip()
    }
    data_prompts = {
        m["content"] for line in all_lines for m in line["messages"] if m["role"] == "user"
    }
    overlap = suite_prompts & data_prompts
    if overlap:
        print(f"LEAKAGE: {len(overlap)} prompts appear in both eval suite and training data:")
        for p in sorted(overlap)[:10]:
            print("  " + p)
        raise SystemExit(1)
    print(f"No leakage: {len(overlap)} shared prompts between eval_suite.jsonl and data/.")


if __name__ == "__main__":
    all_items, stats = make_examples()
    print(f"Generated {len(all_items)} raw examples; deduplicating and splitting...")
    split_and_write(all_items)
    lines = []
    for name in ("train.jsonl", "validation.jsonl", "test.jsonl"):
        for l in (OUT_DIR / name).read_text(encoding="utf-8").splitlines():
            if l.strip():
                lines.append(json.loads(l))
    validate(lines, max_chars=MAX_LINE_CHARS)
    check_no_leakage(HERE / "eval_suite.jsonl", lines)
