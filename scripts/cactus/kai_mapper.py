#!/usr/bin/env python3
"""Canonical mapping from Needle 3 snake_case calls (narrow or native) to KAI runtime tool calls.

Why this exists:
1. Needle 3 works best on narrow, single-action snake_case schemas where every argument is a direct
   span or enum (`set_ui_theme`, `set_timer_reminder`, `set_editor_comfort`), whereas KAI's internal
   tools consolidate multiple optional camelCase fields (`settings_update`, `reminder_create`,
   `voice_settings`).
2. Scoring at the canonical KAI tool boundary lets us compare the narrow schema design fairly
   against KAI's raw native schemas on the exact same frozen prompt suite, and guarantees 1:1
   translation when wiring the Rust/TS pre-LLM interceptor.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
import re
from typing import Any

FIXED_BENCH_NOW = datetime(2026, 11, 22, 14, 0, 0, tzinfo=timezone(timedelta(hours=1)))

STATION_ALIASES: dict[str, str] = {
    "groove salad": "groovesalad",
    "groovesalad": "groovesalad",
    "defcon": "defcon",
    "def con": "defcon",
    "def con radio": "defcon",
    "drone zone": "dronezone",
    "dronezone": "dronezone",
    "space station": "spacestation",
    "space station soma": "spacestation",
    "spacestation": "spacestation",
    "lush": "lush",
    "indie pop": "indiepop",
    "indie pop rocks": "indiepop",
    "indie pop rocks!": "indiepop",
    "indiepop": "indiepop",
    "secret agent": "secretagent",
    "secretagent": "secretagent",
    "fluid": "fluid",
    "sonic universe": "sonicuniverse",
    "sonicuniverse": "sonicuniverse",
    "bagel": "bagel",
    "bagel radio": "bagel",
    "boot liquor": "bootliquor",
    "bootliquor": "bootliquor",
    "the trip": "thetrip",
    "thetrip": "thetrip",
}

PERSONA_ALIASES: dict[str, str] = {
    "none": "none",
    "off": "none",
    "no persona": "none",
    "__none__": "none",
    "coder": "coder",
    "builtin:coder": "coder",
    "architect": "architect",
    "builtin:architect": "architect",
    "reviewer": "reviewer",
    "code reviewer": "reviewer",
    "builtin:reviewer": "reviewer",
    "security": "security",
    "builtin:security": "security",
    "designer": "designer",
    "builtin:designer": "designer",
    "researcher": "researcher",
    "builtin:researcher": "researcher",
    "assistant": "general",
    "general": "general",
    "builtin:general": "general",
}


def _norm_station(raw: Any) -> str:
    s = str(raw or "").strip().lower()
    s = re.sub(r"\s+radio$", "", s) if s not in STATION_ALIASES else s
    return STATION_ALIASES.get(s, str(raw or "").strip().lower())


def _norm_persona(raw: Any) -> str:
    s = str(raw or "").strip().lower()
    s = re.sub(r"\s+persona$", "", s).strip()
    return PERSONA_ALIASES.get(s, s)


def _norm_iso(raw: Any, now: datetime = FIXED_BENCH_NOW) -> str:
    s = str(raw or "").strip()
    if not s:
        return ""
    if s.endswith("Z"):
        s = s[:-1] + "+00:00"
    try:
        dt = datetime.fromisoformat(s)
    except ValueError:
        return s
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=now.tzinfo)
    return dt.isoformat(timespec="seconds")


def _norm_msg(raw: Any) -> str:
    s = str(raw or "").strip()
    s = re.sub(r"^(to\s+)", "", s, flags=re.IGNORECASE)
    return s.rstrip(".!").lower()


def _norm_url(raw: Any) -> str:
    s = str(raw or "").strip()
    if s and not s.startswith(("http://", "https://")):
        s = "http://" + s
    return s.rstrip("/")


def to_canonical_kai_calls(
    needle_calls: list[dict[str, Any]],
    now: datetime = FIXED_BENCH_NOW,
) -> list[dict[str, Any]]:
    """Map Needle function_calls (either narrow or native schema) into canonical KAI tool calls.

    Multiple narrow settings calls in the same turn (e.g. `set_ui_theme` + `set_color_mode`) are
    merged into one `settings_update` object so multi-intent utterances match KAI's atomic update.
    """
    out: list[dict[str, Any]] = []
    merged_settings: dict[str, Any] = {}

    def flush_settings() -> None:
        nonlocal merged_settings
        if merged_settings:
            out.append({"name": "settings_update", "arguments": dict(merged_settings)})
            merged_settings = {}

    for call in needle_calls:
        name = call.get("name", "")
        args = call.get("arguments") or {}

        if name in ("get_settings", "settings"):
            flush_settings()
            out.append({"name": "settings", "arguments": {}})

        elif name == "set_ui_theme":
            if "palette" in args and args["palette"] is not None:
                merged_settings["uiThemeId"] = str(args["palette"]).lower()

        elif name == "set_color_mode":
            if "mode" in args and args["mode"] is not None:
                merged_settings["theme"] = str(args["mode"]).lower()

        elif name == "set_editor_theme":
            if "editor_theme" in args and args["editor_theme"] is not None:
                merged_settings["editorTheme"] = str(args["editor_theme"]).lower()

        elif name == "set_editor_comfort":
            if "vim_mode" in args and args["vim_mode"] is not None:
                merged_settings["vimMode"] = bool(args["vim_mode"])
            if "word_wrap" in args and args["word_wrap"] is not None:
                merged_settings["editorWordWrap"] = bool(args["word_wrap"])
            if "show_hidden" in args and args["show_hidden"] is not None:
                merged_settings["showHidden"] = bool(args["show_hidden"])
            if "terminal_webgl" in args and args["terminal_webgl"] is not None:
                merged_settings["terminalWebglEnabled"] = bool(args["terminal_webgl"])

        elif name == "set_vim_mode":
            if "enabled" in args and args["enabled"] is not None:
                merged_settings["vimMode"] = bool(args["enabled"])

        elif name == "set_word_wrap":
            if "enabled" in args and args["enabled"] is not None:
                merged_settings["editorWordWrap"] = bool(args["enabled"])

        elif name == "set_show_hidden_files":
            if "enabled" in args and args["enabled"] is not None:
                merged_settings["showHidden"] = bool(args["enabled"])

        elif name == "set_terminal_webgl":
            if "enabled" in args and args["enabled"] is not None:
                merged_settings["terminalWebglEnabled"] = bool(args["enabled"])

        elif name == "set_terminal_font_size":
            if "font_size" in args and args["font_size"] is not None:
                merged_settings["terminalFontSize"] = int(args["font_size"])

        elif name == "set_terminal_scrollback":
            if "lines" in args and args["lines"] is not None:
                merged_settings["terminalScrollback"] = int(args["lines"])

        elif name == "set_zoom_level":
            if "zoom" in args and args["zoom"] is not None:
                merged_settings["zoomLevel"] = round(float(args["zoom"]), 2)

        elif name == "update_kai_appearance":
            if args.get("read_current") is True:
                flush_settings()
                out.append({"name": "settings", "arguments": {}})
            else:
                if args.get("palette") is not None:
                    merged_settings["uiThemeId"] = str(args["palette"]).lower()
                if args.get("color_mode") is not None:
                    merged_settings["theme"] = str(args["color_mode"]).lower()
                if args.get("editor_theme") is not None:
                    merged_settings["editorTheme"] = str(args["editor_theme"]).lower()
                if args.get("vim_mode") is not None:
                    merged_settings["vimMode"] = bool(args["vim_mode"])
                if args.get("word_wrap") is not None:
                    merged_settings["editorWordWrap"] = bool(args["word_wrap"])
                if args.get("show_hidden") is not None:
                    merged_settings["showHidden"] = bool(args["show_hidden"])
                if args.get("terminal_webgl") is not None:
                    merged_settings["terminalWebglEnabled"] = bool(args["terminal_webgl"])
                if args.get("font_size") is not None:
                    merged_settings["terminalFontSize"] = int(args["font_size"])
                if args.get("scrollback") is not None:
                    merged_settings["terminalScrollback"] = int(args["scrollback"])
                if args.get("zoom_level") is not None:
                    merged_settings["zoomLevel"] = round(float(args["zoom_level"]), 2)

        elif name == "control_radio":
            flush_settings()
            act = str(args.get("action") or "").lower()
            if act == "play" and args.get("station"):
                out.append({"name": "play_radio", "arguments": {"station": _norm_station(args["station"])}})
            elif act == "stop":
                out.append({"name": "stop_radio", "arguments": {}})
            elif act == "list_stations":
                out.append({"name": "radio_list_stations", "arguments": {}})
            elif act == "now_playing":
                out.append({"name": "radio_now_playing", "arguments": {}})

        elif name == "manage_reminder":
            flush_settings()
            act = str(args.get("action") or "").lower()
            if act == "list":
                out.append({"name": "reminder_list", "arguments": {}})
            elif act == "cancel" and args.get("id"):
                out.append({"name": "reminder_cancel", "arguments": {"id": str(args["id"]).strip()}})
            elif act == "create":
                total_min = int(args.get("minutes") or 0) + int(args.get("hours") or 0) * 60
                if total_min > 0:
                    due = (now + timedelta(minutes=total_min)).isoformat(timespec="seconds")
                else:
                    due = _norm_iso(args.get("due_at"), now=now)
                r_args: dict[str, Any] = {"message": _norm_msg(args.get("message")), "dueAt": due}
                if args.get("repeat"):
                    r_args["repeat"] = str(args["repeat"]).lower()
                out.append({"name": "reminder_create", "arguments": r_args})

        elif name == "control_voice":
            flush_settings()
            cv_args: dict[str, Any] = {}
            if args.get("mode") is not None:
                cv_args["mode"] = str(args["mode"]).lower()
            if args.get("voice") is not None:
                cv_args["voice"] = str(args["voice"]).lower()
            if args.get("assembly_voice") is not None:
                cv_args["assemblyVoice"] = str(args["assembly_voice"]).lower()
            if args.get("list") is True:
                cv_args["list"] = True
            out.append({"name": "voice_settings", "arguments": cv_args})

        elif name == "desktop_session_action":
            flush_settings()
            if args.get("persona") is not None:
                out.append({"name": "set_persona", "arguments": {"persona": _norm_persona(args["persona"])}})
            if args.get("preview_url") is not None:
                out.append({"name": "open_preview", "arguments": {"url": _norm_url(args["preview_url"])}})

        elif name == "set_terminal_display":
            if "font_size" in args and args["font_size"] is not None:
                merged_settings["terminalFontSize"] = int(args["font_size"])
            if "scrollback" in args and args["scrollback"] is not None:
                merged_settings["terminalScrollback"] = int(args["scrollback"])
            if "zoom_level" in args and args["zoom_level"] is not None:
                merged_settings["zoomLevel"] = round(float(args["zoom_level"]), 2)

        elif name == "settings_update":
            key_map = {
                "ui_theme_id": "uiThemeId",
                "uiThemeId": "uiThemeId",
                "theme": "theme",
                "editor_theme": "editorTheme",
                "editorTheme": "editorTheme",
                "vim_mode": "vimMode",
                "vimMode": "vimMode",
                "editor_word_wrap": "editorWordWrap",
                "editorWordWrap": "editorWordWrap",
                "show_hidden": "showHidden",
                "showHidden": "showHidden",
                "terminal_webgl_enabled": "terminalWebglEnabled",
                "terminalWebglEnabled": "terminalWebglEnabled",
                "terminal_font_size": "terminalFontSize",
                "terminalFontSize": "terminalFontSize",
                "terminal_scrollback": "terminalScrollback",
                "terminalScrollback": "terminalScrollback",
                "zoom_level": "zoomLevel",
                "zoomLevel": "zoomLevel",
            }
            for k, v in args.items():
                if v is None or k not in key_map:
                    continue
                dest = key_map[k]
                if dest in ("terminalFontSize", "terminalScrollback"):
                    merged_settings[dest] = int(v)
                elif dest == "zoomLevel":
                    merged_settings[dest] = round(float(v), 2)
                elif isinstance(v, str):
                    merged_settings[dest] = v.lower()
                else:
                    merged_settings[dest] = v

        elif name == "play_radio":
            flush_settings()
            out.append({"name": "play_radio", "arguments": {"station": _norm_station(args.get("station"))}})

        elif name == "stop_radio":
            flush_settings()
            out.append({"name": "stop_radio", "arguments": {}})

        elif name == "radio_list_stations":
            flush_settings()
            out.append({"name": "radio_list_stations", "arguments": {}})

        elif name == "radio_now_playing":
            flush_settings()
            mapped: dict[str, Any] = {}
            if args.get("station"):
                mapped["station"] = _norm_station(args["station"])
            out.append({"name": "radio_now_playing", "arguments": mapped})

        elif name in ("set_voice_settings", "voice_settings"):
            flush_settings()
            v_args: dict[str, Any] = {}
            if args.get("mode") is not None:
                v_args["mode"] = str(args["mode"]).lower()
            if args.get("voice") is not None:
                v_args["voice"] = str(args["voice"]).lower()
            asm = args.get("assembly_voice") if "assembly_voice" in args else args.get("assemblyVoice")
            if asm is not None:
                v_args["assemblyVoice"] = str(asm).lower()
            if args.get("list") is True:
                v_args["list"] = True
            out.append({"name": "voice_settings", "arguments": v_args})

        elif name == "set_timer_reminder":
            flush_settings()
            total_min = int(args.get("minutes") or 0) + int(args.get("hours") or 0) * 60
            due = (now + timedelta(minutes=total_min)).isoformat(timespec="seconds") if total_min > 0 else ""
            out.append({
                "name": "reminder_create",
                "arguments": {
                    "message": _norm_msg(args.get("message")),
                    "dueAt": due,
                },
            })

        elif name in ("schedule_reminder", "reminder_create"):
            flush_settings()
            raw_due = args.get("due_at") if "due_at" in args else args.get("dueAt")
            r_args: dict[str, Any] = {
                "message": _norm_msg(args.get("message")),
                "dueAt": _norm_iso(raw_due, now=now),
            }
            if args.get("repeat"):
                r_args["repeat"] = str(args["repeat"]).lower()
            out.append({"name": "reminder_create", "arguments": r_args})

        elif name == "reminder_list":
            flush_settings()
            out.append({"name": "reminder_list", "arguments": {}})

        elif name == "reminder_cancel":
            flush_settings()
            out.append({"name": "reminder_cancel", "arguments": {"id": str(args.get("id") or "").strip()}})

        elif name == "set_persona":
            flush_settings()
            out.append({"name": "set_persona", "arguments": {"persona": _norm_persona(args.get("persona"))}})

        elif name == "open_preview":
            flush_settings()
            out.append({"name": "open_preview", "arguments": {"url": _norm_url(args.get("url"))}})

        else:
            flush_settings()
            out.append({"name": name, "arguments": args})

    flush_settings()
    return out
