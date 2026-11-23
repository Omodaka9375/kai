#!/usr/bin/env python3
"""Build the frozen KAI V1 Desktop-Controls evaluation suite (`eval_suite.jsonl`).

Every row records:
- `id`: stable case id
- `category`: `positive` | `multi_call` | `negation` | `missing_or_oob` | `escalate_coding` | `escalate_chat`
- `domain`: `settings` | `radio` | `voice` | `reminders` | `persona` | `preview` | `escalate`
- `prompt`: realistic short KAI user message
- `expected_kai`: canonical KAI runtime call(s) (scored after `kai_mapper.to_canonical_kai_calls`)
- `expected_narrow`: expected Needle narrow-schema call(s) (also used to export Cactus platform `test.jsonl`)

Why `escalate_*` matters so much in automatic pre-LLM mode:
When Needle runs on EVERY short user message before `transport.ts`, any false-positive tool call
above the confidence threshold intercepts a coding/workspace prompt instead of letting the main LLM
handle it. So the benchmark treats `escalate_*` false positives as the #1 safety metric.
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any

HERE = Path(__file__).resolve().parent
SCHEMAS_PATH = HERE / "schemas.json"
OUT_SUITE = HERE / "eval_suite.jsonl"
OUT_PLATFORM_TEST = HERE / "platform_test_preview.jsonl"


def case(
    cid: str,
    category: str,
    domain: str,
    prompt: str,
    expected_kai: list[dict[str, Any]],
    expected_narrow: list[dict[str, Any]],
    reasoning: str = "",
) -> dict[str, Any]:
    return {
        "id": cid,
        "category": category,
        "domain": domain,
        "prompt": prompt,
        "expected_kai": expected_kai,
        "expected_narrow": expected_narrow,
        "reasoning": reasoning,
    }


SUITE: list[dict[str, Any]] = [
    # ── Settings: UI palette & color mode ────────────────────────────────────
    case(
        "set_01", "positive", "settings",
        "switch ui theme to tokyo night",
        [{"name": "settings_update", "arguments": {"uiThemeId": "tokyo-night"}}],
        [{"name": "set_ui_theme", "arguments": {"palette": "tokyo-night"}}],
        "'tokyo night' -> palette 'tokyo-night'",
    ),
    case(
        "set_02", "positive", "settings",
        "change the app color palette to catppuccin",
        [{"name": "settings_update", "arguments": {"uiThemeId": "catppuccin"}}],
        [{"name": "set_ui_theme", "arguments": {"palette": "catppuccin"}}],
        "'catppuccin' -> palette 'catppuccin'",
    ),
    case(
        "set_03", "positive", "settings",
        "use dracula theme for the app",
        [{"name": "settings_update", "arguments": {"uiThemeId": "dracula"}}],
        [{"name": "set_ui_theme", "arguments": {"palette": "dracula"}}],
        "'dracula' -> palette 'dracula'",
    ),
    case(
        "set_04", "positive", "settings",
        "set palette to rose pine",
        [{"name": "settings_update", "arguments": {"uiThemeId": "rose-pine"}}],
        [{"name": "set_ui_theme", "arguments": {"palette": "rose-pine"}}],
        "'rose pine' -> palette 'rose-pine'",
    ),
    case(
        "set_05", "positive", "settings",
        "reset app palette back to default",
        [{"name": "settings_update", "arguments": {"uiThemeId": "default"}}],
        [{"name": "set_ui_theme", "arguments": {"palette": "default"}}],
        "'default' -> palette 'default'",
    ),
    case(
        "set_06", "positive", "settings",
        "switch to dark mode",
        [{"name": "settings_update", "arguments": {"theme": "dark"}}],
        [{"name": "set_color_mode", "arguments": {"mode": "dark"}}],
        "'dark mode' -> mode 'dark'",
    ),
    case(
        "set_07", "positive", "settings",
        "turn on light mode",
        [{"name": "settings_update", "arguments": {"theme": "light"}}],
        [{"name": "set_color_mode", "arguments": {"mode": "light"}}],
        "'light mode' -> mode 'light'",
    ),
    case(
        "set_08", "positive", "settings",
        "follow system color mode",
        [{"name": "settings_update", "arguments": {"theme": "system"}}],
        [{"name": "set_color_mode", "arguments": {"mode": "system"}}],
        "'system' -> mode 'system'",
    ),
    # ── Settings: Editor & Terminal comfort ──────────────────────────────────
    case(
        "set_09", "positive", "settings",
        "set the code editor theme to github dark",
        [{"name": "settings_update", "arguments": {"editorTheme": "github-dark"}}],
        [{"name": "set_editor_theme", "arguments": {"editor_theme": "github-dark"}}],
        "'github dark' -> editor_theme 'github-dark'",
    ),
    case(
        "set_10", "positive", "settings",
        "change editor syntax theme to nord",
        [{"name": "settings_update", "arguments": {"editorTheme": "nord"}}],
        [{"name": "set_editor_theme", "arguments": {"editor_theme": "nord"}}],
        "'nord' -> editor_theme 'nord'",
    ),
    case(
        "set_11", "positive", "settings",
        "enable vim mode in the editor",
        [{"name": "settings_update", "arguments": {"vimMode": True}}],
        [{"name": "set_vim_mode", "arguments": {"enabled": True}}],
        "'enable vim mode' -> enabled true",
    ),
    case(
        "set_12", "positive", "settings",
        "turn off vim keybindings",
        [{"name": "settings_update", "arguments": {"vimMode": False}}],
        [{"name": "set_vim_mode", "arguments": {"enabled": False}}],
        "'turn off vim keybindings' -> enabled false",
    ),
    case(
        "set_13", "positive", "settings",
        "turn on word wrap in the editor",
        [{"name": "settings_update", "arguments": {"editorWordWrap": True}}],
        [{"name": "set_word_wrap", "arguments": {"enabled": True}}],
        "'turn on word wrap' -> enabled true",
    ),
    case(
        "set_14", "positive", "settings",
        "show hidden files in the explorer",
        [{"name": "settings_update", "arguments": {"showHidden": True}}],
        [{"name": "set_show_hidden_files", "arguments": {"enabled": True}}],
        "'show hidden files' -> enabled true",
    ),
    case(
        "set_15", "positive", "settings",
        "disable terminal webgl rendering",
        [{"name": "settings_update", "arguments": {"terminalWebglEnabled": False}}],
        [{"name": "set_terminal_webgl", "arguments": {"enabled": False}}],
        "'disable terminal webgl' -> enabled false",
    ),
    case(
        "set_16", "positive", "settings",
        "set terminal font size to 16",
        [{"name": "settings_update", "arguments": {"terminalFontSize": 16}}],
        [{"name": "set_terminal_font_size", "arguments": {"font_size": 16}}],
        "'16' -> font_size 16",
    ),
    case(
        "set_17", "positive", "settings",
        "increase terminal scrollback to 10000 lines",
        [{"name": "settings_update", "arguments": {"terminalScrollback": 10000}}],
        [{"name": "set_terminal_scrollback", "arguments": {"lines": 10000}}],
        "'10000' -> lines 10000",
    ),
    case(
        "set_18", "positive", "settings",
        "set app zoom level to 1.25",
        [{"name": "settings_update", "arguments": {"zoomLevel": 1.25}}],
        [{"name": "set_zoom_level", "arguments": {"zoom": 1.25}}],
        "'1.25' -> zoom 1.25",
    ),
    case(
        "set_19", "positive", "settings",
        "show my current kai settings",
        [{"name": "settings", "arguments": {}}],
        [{"name": "get_settings", "arguments": {}}],
        "'current kai settings' -> get_settings",
    ),
    # ── Radio ────────────────────────────────────────────────────────────────
    case(
        "rad_01", "positive", "radio",
        "play groove salad on the radio",
        [{"name": "play_radio", "arguments": {"station": "groovesalad"}}],
        [{"name": "play_radio", "arguments": {"station": "groove salad"}}],
        "'groove salad' -> station 'groove salad'",
    ),
    case(
        "rad_02", "positive", "radio",
        "put on drone zone",
        [{"name": "play_radio", "arguments": {"station": "dronezone"}}],
        [{"name": "play_radio", "arguments": {"station": "drone zone"}}],
        "'drone zone' -> station 'drone zone'",
    ),
    case(
        "rad_03", "positive", "radio",
        "play def con radio",
        [{"name": "play_radio", "arguments": {"station": "defcon"}}],
        [{"name": "play_radio", "arguments": {"station": "def con radio"}}],
        "'def con radio' -> station 'def con radio'",
    ),
    case(
        "rad_04", "positive", "radio",
        "play some ambient music",
        [{"name": "play_radio", "arguments": {"station": "ambient"}}],
        [{"name": "play_radio", "arguments": {"station": "ambient"}}],
        "'ambient' -> station 'ambient'",
    ),
    case(
        "rad_05", "positive", "radio",
        "stop the radio",
        [{"name": "stop_radio", "arguments": {}}],
        [{"name": "stop_radio", "arguments": {}}],
        "'stop the radio' -> stop_radio",
    ),
    case(
        "rad_06", "positive", "radio",
        "turn off the music",
        [{"name": "stop_radio", "arguments": {}}],
        [{"name": "stop_radio", "arguments": {}}],
        "'turn off the music' -> stop_radio",
    ),
    case(
        "rad_07", "positive", "radio",
        "what radio stations are available?",
        [{"name": "radio_list_stations", "arguments": {}}],
        [{"name": "radio_list_stations", "arguments": {}}],
        "'what radio stations are available' -> radio_list_stations",
    ),
    case(
        "rad_08", "positive", "radio",
        "what song is playing right now?",
        [{"name": "radio_now_playing", "arguments": {}}],
        [{"name": "radio_now_playing", "arguments": {}}],
        "'what song is playing' -> radio_now_playing",
    ),
    # ── Voice / TTS ──────────────────────────────────────────────────────────
    case(
        "voi_01", "positive", "voice",
        "turn off voice replies",
        [{"name": "voice_settings", "arguments": {"mode": "off"}}],
        [{"name": "set_voice_settings", "arguments": {"mode": "off"}}],
        "'turn off voice replies' -> mode 'off'",
    ),
    case(
        "voi_02", "positive", "voice",
        "switch tts engine to local",
        [{"name": "voice_settings", "arguments": {"mode": "local"}}],
        [{"name": "set_voice_settings", "arguments": {"mode": "local"}}],
        "'local' -> mode 'local'",
    ),
    case(
        "voi_03", "positive", "voice",
        "change openai voice to nova",
        [{"name": "voice_settings", "arguments": {"voice": "nova"}}],
        [{"name": "set_voice_settings", "arguments": {"voice": "nova"}}],
        "'nova' -> voice 'nova'",
    ),
    case(
        "voi_04", "positive", "voice",
        "list available tts voices",
        [{"name": "voice_settings", "arguments": {"list": True}}],
        [{"name": "set_voice_settings", "arguments": {"list": True}}],
        "'list available tts voices' -> list true",
    ),
    # ── Reminders ────────────────────────────────────────────────────────────
    case(
        "rem_01", "positive", "reminders",
        "remind me in 15 minutes to check the deploy",
        [{"name": "reminder_create", "arguments": {"message": "check the deploy", "dueAt": "2026-11-22T14:15:00+01:00"}}],
        [{"name": "set_timer_reminder", "arguments": {"message": "check the deploy", "minutes": 15}}],
        "'15 minutes' -> minutes 15; 'check the deploy' -> message",
    ),
    case(
        "rem_02", "positive", "reminders",
        "set a reminder in 2 hours to stretch",
        [{"name": "reminder_create", "arguments": {"message": "stretch", "dueAt": "2026-11-22T16:00:00+01:00"}}],
        [{"name": "set_timer_reminder", "arguments": {"message": "stretch", "hours": 2}}],
        "'2 hours' -> hours 2; 'stretch' -> message",
    ),
    case(
        "rem_03", "positive", "reminders",
        "remind me tomorrow at 9am to pay bills",
        [{"name": "reminder_create", "arguments": {"message": "pay bills", "dueAt": "2026-11-23T09:00:00+01:00"}}],
        [{"name": "schedule_reminder", "arguments": {"message": "pay bills", "due_at": "2026-11-23T09:00:00"}}],
        "'tomorrow at 9am' -> 2026-11-23T09:00:00; 'pay bills' -> message",
    ),
    case(
        "rem_04", "positive", "reminders",
        "list my scheduled reminders",
        [{"name": "reminder_list", "arguments": {}}],
        [{"name": "reminder_list", "arguments": {}}],
        "'list my scheduled reminders' -> reminder_list",
    ),
    case(
        "rem_05", "positive", "reminders",
        "cancel reminder rmd_7f3a91",
        [{"name": "reminder_cancel", "arguments": {"id": "rmd_7f3a91"}}],
        [{"name": "reminder_cancel", "arguments": {"id": "rmd_7f3a91"}}],
        "'rmd_7f3a91' -> id 'rmd_7f3a91'",
    ),
    # ── Personas & Preview ───────────────────────────────────────────────────
    case(
        "per_01", "positive", "persona",
        "switch to the architect persona",
        [{"name": "set_persona", "arguments": {"persona": "architect"}}],
        [{"name": "set_persona", "arguments": {"persona": "architect"}}],
        "'architect' -> persona 'architect'",
    ),
    case(
        "per_02", "positive", "persona",
        "activate security persona",
        [{"name": "set_persona", "arguments": {"persona": "security"}}],
        [{"name": "set_persona", "arguments": {"persona": "security"}}],
        "'security' -> persona 'security'",
    ),
    case(
        "per_03", "positive", "persona",
        "clear active persona, use none",
        [{"name": "set_persona", "arguments": {"persona": "none"}}],
        [{"name": "set_persona", "arguments": {"persona": "none"}}],
        "'none' -> persona 'none'",
    ),
    case(
        "prv_01", "positive", "preview",
        "open preview at http://localhost:5173",
        [{"name": "open_preview", "arguments": {"url": "http://localhost:5173"}}],
        [{"name": "open_preview", "arguments": {"url": "http://localhost:5173"}}],
        "'http://localhost:5173' -> url",
    ),
    case(
        "prv_02", "positive", "preview",
        "open localhost:3000 in the preview tab",
        [{"name": "open_preview", "arguments": {"url": "http://localhost:3000"}}],
        [{"name": "open_preview", "arguments": {"url": "http://localhost:3000"}}],
        "'localhost:3000' -> url 'http://localhost:3000'",
    ),
    # ── Multi-call compositions ──────────────────────────────────────────────
    case(
        "mul_01", "multi_call", "settings",
        "switch to dark mode and play groove salad",
        [
            {"name": "settings_update", "arguments": {"theme": "dark"}},
            {"name": "play_radio", "arguments": {"station": "groovesalad"}},
        ],
        [
            {"name": "set_color_mode", "arguments": {"mode": "dark"}},
            {"name": "play_radio", "arguments": {"station": "groove salad"}},
        ],
        "'dark mode' -> set_color_mode dark; 'groove salad' -> play_radio",
    ),
    case(
        "mul_02", "multi_call", "settings",
        "stop the radio and enable vim mode",
        [
            {"name": "stop_radio", "arguments": {}},
            {"name": "settings_update", "arguments": {"vimMode": True}},
        ],
        [
            {"name": "stop_radio", "arguments": {}},
            {"name": "set_vim_mode", "arguments": {"enabled": True}},
        ],
        "'stop the radio' -> stop_radio; 'enable vim mode' -> enabled true",
    ),
    case(
        "mul_03", "multi_call", "settings",
        "set ui theme to nord and terminal font size to 14",
        [
            {"name": "settings_update", "arguments": {"uiThemeId": "nord", "terminalFontSize": 14}},
        ],
        [
            {"name": "set_ui_theme", "arguments": {"palette": "nord"}},
            {"name": "set_terminal_font_size", "arguments": {"font_size": 14}},
        ],
        "'nord' -> palette 'nord'; '14' -> font_size 14",
    ),
    # ── Negations & Missing/Out-of-Bounds (must return []) ───────────────────
    case(
        "neg_01", "negation", "radio",
        "don't stop the radio",
        [], [],
        "negated request -> no call",
    ),
    case(
        "neg_02", "negation", "settings",
        "do not switch to light mode",
        [], [],
        "negated request -> no call",
    ),
    case(
        "oob_01", "missing_or_oob", "settings",
        "set terminal font size to 96",
        [], [],
        "96 exceeds maximum font_size 32 -> no call",
    ),
    case(
        "oob_02", "missing_or_oob", "reminders",
        "cancel my reminder",
        [], [],
        "missing required reminder id -> no call",
    ),
    # ── CRITICAL: Coding / Workspace / Shell / Chat Escalations (must return []) ──
    case(
        "esc_01", "escalate_coding", "escalate",
        "fix the race condition in src/modules/ai/lib/agent.ts",
        [], [],
        "code bug fix requires main coding agent -> no desktop tool fits",
    ),
    case(
        "esc_02", "escalate_coding", "escalate",
        "grep for createProxyFetch across src/",
        [], [],
        "codebase search is not a desktop control -> no tool fits",
    ),
    case(
        "esc_03", "escalate_coding", "escalate",
        "run cargo check and fix any compiler warnings",
        [], [],
        "build and fix task -> no tool fits",
    ),
    case(
        "esc_04", "escalate_coding", "escalate",
        "refactor the theme palette CSS variables in palettes.ts to support contrast boost",
        [], [],
        "mentions theme/palettes.ts but asks to refactor source code -> no desktop tool fits",
    ),
    case(
        "esc_05", "escalate_coding", "escalate",
        "why is radio_now_playing returning an error in radio.ts?",
        [], [],
        "debugging code in radio.ts, not asking what song is playing -> no tool fits",
    ),
    case(
        "esc_06", "escalate_coding", "escalate",
        "add a new persona icon option in src/modules/ai/lib/agents.ts",
        [], [],
        "editing TypeScript code for personas, not switching active persona -> no tool fits",
    ),
    case(
        "esc_07", "escalate_coding", "escalate",
        "open https://github.com/Omodaka9375/kai/pulls and summarize open PRs",
        [], [],
        "external GitHub URL + summarization, open_preview only accepts localhost -> no tool fits",
    ),
    case(
        "esc_08", "escalate_coding", "escalate",
        "commit my staged changes with a clean message",
        [], [],
        "git commit action -> no desktop tool fits",
    ),
    case(
        "esc_09", "escalate_coding", "escalate",
        "create a new Test Engineer persona that runs vitest before answering",
        [], [],
        "creating a brand-new persona with instructions requires create_persona / LLM -> set_persona only switches existing ones",
    ),
    case(
        "esc_10", "escalate_coding", "escalate",
        "change my default shell to pwsh and enable autostart",
        [], [],
        "restricted behavioral settings require settings_update_restricted approval card -> not in cosmetic fast-path",
    ),
    case(
        "esc_11", "escalate_chat", "escalate",
        "what is the difference between ConPTY and portable-pty on Windows?",
        [], [],
        "general technical question -> no tool fits",
    ),
    case(
        "esc_12", "escalate_chat", "escalate",
        "explain how Tauri Channels stream bytes to React",
        [], [],
        "conceptual explanation -> no tool fits",
    ),
]


def main() -> None:
    schemas = json.loads(SCHEMAS_PATH.read_text(encoding="utf-8"))
    narrow_tools_openai = [
        {"type": "function", "function": t} for t in schemas["narrow_tools"]
    ]
    sys_msg = schemas["system_facts_example"]

    with OUT_SUITE.open("w", encoding="utf-8", newline="\n") as f:
        for row in SUITE:
            f.write(json.dumps(row, ensure_ascii=False) + "\n")

    with OUT_PLATFORM_TEST.open("w", encoding="utf-8", newline="\n") as f:
        for row in SUITE:
            tool_calls = [
                {
                    "id": f"call_{idx + 1}",
                    "type": "function",
                    "function": {
                        "name": c["name"],
                        "arguments": json.dumps(c["arguments"], ensure_ascii=False),
                    },
                }
                for idx, c in enumerate(row["expected_narrow"])
            ]
            chat_line = {
                "messages": [
                    {"role": "system", "content": sys_msg},
                    {"role": "user", "content": row["prompt"]},
                    {
                        "role": "assistant",
                        "content": "",
                        "reasoning_content": row["reasoning"],
                        "tool_calls": tool_calls,
                    },
                ],
                "tools": narrow_tools_openai,
            }
            f.write(json.dumps(chat_line, ensure_ascii=False) + "\n")

    print(f"Wrote {len(SUITE)} cases -> {OUT_SUITE}")
    print(f"Wrote {len(SUITE)} Cactus platform chat lines -> {OUT_PLATFORM_TEST}")


if __name__ == "__main__":
    main()
