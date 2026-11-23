import { describe, expect, it } from "vitest";
import {
  callGroundedInPrompt,
  decideReflex,
  isClippedByGrammar,
  isCodeShapedPrompt,
  mapNarrowCalls,
  REFLEX_ALLOWED_NARROW_TOOLS,
  REFLEX_MAX_PROMPT_CHARS,
  REFLEX_CONFIDENCE_GATE,
  type NarrowCall,
} from "./localReflex";

/** The runtime narrow schema must stay inside the reflex allowlist: a new
 *  narrow tool added to schemas.json without updating the allowlist must
 *  FAIL this test, not silently fall through at runtime. */
describe("reflex allowlist coverage", () => {
  it("covers every narrow tool in src-tauri/src/modules/reflex_tools.json and scripts/cactus/schemas.json", () => {
    const fs = require("node:fs") as typeof import("node:fs");
    const path = require("node:path") as typeof import("node:path");
    const schemaPath = path.resolve(
      __dirname,
      "../../../../scripts/cactus/schemas.json",
    );
    const embeddedPath = path.resolve(
      __dirname,
      "../../../../src-tauri/src/modules/reflex_tools.json",
    );
    const schemas = JSON.parse(fs.readFileSync(schemaPath, "utf-8")) as {
      narrow_tools: Array<{ name: string }>;
    };
    const embedded = JSON.parse(fs.readFileSync(embeddedPath, "utf-8")) as Array<{
      name: string;
    }>;
    const names = schemas.narrow_tools.map((t) => t.name);
    expect(embedded.map((t) => t.name)).toEqual(names);
    for (const n of names) {
      expect(
        REFLEX_ALLOWED_NARROW_TOOLS.has(n),
        `narrow tool "${n}" missing from REFLEX_ALLOWED_NARROW_TOOLS`,
      ).toBe(true);
    }
  });
});

describe("isClippedByGrammar (decode-grammar range guard)", () => {
  it("accepts in-bounds values", () => {
    expect(isClippedByGrammar("set_terminal_font_size", { font_size: 16 })).toBe(false);
    expect(isClippedByGrammar("set_terminal_scrollback", { lines: 5000 })).toBe(false);
    expect(isClippedByGrammar("set_zoom_level", { zoom: 1.25 })).toBe(false);
    expect(isClippedByGrammar("set_timer_reminder", { minutes: 30 })).toBe(false);
  });

  it("rejects out-of-bounds values (the grammar clips, it does not refuse)", () => {
    // 'set font size to 96' -> engine emitted 9 (clipped). 9 IS in bounds,
    // but 96 is not representable - this guard exists for the mapper's
    // raw-value check; the mapper additionally rejects before clipping by
    // checking the model's own emitted value against bounds.
    expect(isClippedByGrammar("set_terminal_font_size", { font_size: 96 })).toBe(true);
    expect(isClippedByGrammar("set_terminal_font_size", { font_size: 0 })).toBe(true);
    expect(isClippedByGrammar("set_terminal_scrollback", { lines: 999999 })).toBe(true);
    expect(isClippedByGrammar("set_zoom_level", { zoom: 4 })).toBe(true);
    expect(isClippedByGrammar("set_timer_reminder", { minutes: 50000 })).toBe(true);
  });

  it("ignores tools without numeric args", () => {
    expect(isClippedByGrammar("stop_radio", {})).toBe(false);
    expect(isClippedByGrammar("set_ui_theme", { palette: "nord" })).toBe(false);
  });
});

describe("mapNarrowCalls", () => {
  const NOW = new Date("2026-11-23T10:00:00Z");

  it("maps narrow setters into a single settings_update", () => {
    const calls: NarrowCall[] = [
      { name: "set_ui_theme", arguments: { palette: "Nord" } },
      { name: "set_terminal_font_size", arguments: { font_size: 16 } },
    ];
    expect(mapNarrowCalls(calls, NOW)).toEqual([
      {
        name: "settings_update",
        arguments: { uiThemeId: "nord", terminalFontSize: 16 },
      },
    ]);
  });

  it("expands set_timer_reminder to an absolute ISO dueAt", () => {
    const out = mapNarrowCalls(
      [{ name: "set_timer_reminder", arguments: { message: "stretch", minutes: 15 } }],
      NOW,
    );
    expect(out).toEqual([
      { name: "reminder_create", arguments: { message: "stretch", dueAt: new Date(NOW.getTime() + 15 * 60_000).toISOString() } },
    ]);
  });

  it("normalizes radio stations and personas", () => {
    expect(
      mapNarrowCalls([{ name: "play_radio", arguments: { station: "Drone Zone" } }], NOW),
    ).toEqual([{ name: "play_radio", arguments: { station: "dronezone" } }]);
    expect(
      mapNarrowCalls([{ name: "set_persona", arguments: { persona: "Code Reviewer persona" } }], NOW),
    ).toEqual([{ name: "set_persona", arguments: { persona: "reviewer" } }]);
  });

  it("returns null on empty-station play (ungrounded slot)", () => {
    expect(mapNarrowCalls([{ name: "play_radio", arguments: { station: "" } }], NOW)).toBeNull();
  });

  it("returns null on grammar-clipped numbers", () => {
    expect(
      mapNarrowCalls([{ name: "set_terminal_font_size", arguments: { font_size: 96 } }], NOW),
    ).toBeNull();
  });

  it("returns null on unknown tools", () => {
    expect(mapNarrowCalls([{ name: "rm_rf", arguments: {} }], NOW)).toBeNull();
  });

  it("returns null when open_preview gets a non-localhost URL", () => {
    expect(
      mapNarrowCalls(
        [{ name: "open_preview", arguments: { url: "https://github.com/x" } }],
        NOW,
      ),
    ).toBeNull();
  });

  it("normalizes scheme-less localhost previews to http", () => {
    expect(
      mapNarrowCalls(
        [{ name: "open_preview", arguments: { url: "localhost:5173" } }],
        NOW,
      ),
    ).toEqual([{ name: "open_preview", arguments: { url: "http://localhost:5173" } }]);
  });

  it("parses schedule_reminder due_at and rejects garbage dates", () => {
    expect(
      mapNarrowCalls(
        [{ name: "schedule_reminder", arguments: { message: "pay bills", due_at: "2026-11-24T09:00:00" } }],
        NOW,
      ),
    ).toEqual([
      { name: "reminder_create", arguments: { message: "pay bills", dueAt: new Date("2026-11-24T09:00:00").toISOString() } },
    ]);
    expect(
      mapNarrowCalls(
        [{ name: "schedule_reminder", arguments: { message: "x", due_at: "not a date" } }],
        NOW,
      ),
    ).toBeNull();
  });
});

describe("decideReflex", () => {
  const good: NarrowCall[] = [{ name: "stop_radio", arguments: {} }];
  const NOW2 = new Date("2026-11-23T10:00:00Z");

  it("executes a confident allowlisted call", () => {
    const d = decideReflex("stop the radio", { calls: good, confidence: 0.9 });
    expect(d).toEqual({
      action: "execute",
      calls: [{ name: "stop_radio", arguments: {} }],
      confidence: 0.9,
    });
  });

  it("falls through below the confidence gate", () => {
    const d = decideReflex("stop the radio", {
      calls: good,
      confidence: REFLEX_CONFIDENCE_GATE - 0.01,
    });
    expect(d.action === "fallthrough" && d.reason === "low-confidence").toBe(true);
  });

  it("falls through on empty calls (engine refusal)", () => {
    const d = decideReflex("fix the race condition in agent.ts", { calls: [], confidence: 0.99 });
    expect(d.action === "fallthrough" && d.reason === "empty-calls").toBe(true);
  });

  it("falls through on conversational acknowledgments regardless of engine reply", () => {
    for (const p of ["yes", "continue", "ok", "no", "go ahead", " Continue "]) {
      const d = decideReflex(p, { calls: good, confidence: 0.99 });
      expect(d.action === "fallthrough" && d.reason === "conversational").toBe(true);
    }
  });

  it("falls through on stall/interjection phrases even with tool-shaped words after", () => {
    for (const p of ["wait I have the bug list", "wait a second", "hold on let me find it", "give me a second", "let me think"]) {
      const d = decideReflex(p, { calls: good, confidence: 0.99 });
      expect(d.action === "fallthrough" && d.reason === "conversational").toBe(true);
    }
  });

  it("non-ack commands still execute", () => {
    // "wait" alone is conversational, but "wait 5 seconds" is a real sleep command.
    const d = decideReflex("stop the radio", { calls: good, confidence: 0.99 });
    expect(d.action).toBe("execute");
    const w = decideReflex("wait 5 seconds then remind me to check the build", {
      calls: [{ name: "set_timer_reminder", arguments: { minutes: 5, message: "check the build" } }],
      confidence: 0.99,
    });
    expect(w.action).toBe("execute");
  });

  it("falls through on long prompts", () => {
    const long = "x".repeat(REFLEX_MAX_PROMPT_CHARS + 1);
    const d = decideReflex(long, { calls: good, confidence: 0.99 });
    expect(d.action === "fallthrough" && d.reason === "long-prompt").toBe(true);
  });

  it("falls through on disallowed tools", () => {
    const d = decideReflex("do a thing", {
      calls: [{ name: "bash_run", arguments: {} }],
      confidence: 0.99,
    });
    expect(d.action === "fallthrough" && d.reason === "disallowed-tool").toBe(true);
  });

  it("falls through when the reply is null (engine unavailable)", () => {
    const d = decideReflex("stop the radio", null);
    expect(d.action === "fallthrough" && d.reason === "no-reply").toBe(true);
  });

  it("falls through on code-shaped prompts regardless of the engine reply (2026-11-23 live hijack)", () => {
    // The live false positive: a python -c code-execution prompt classified
    // as set_terminal_webgl at 0.77 and EXECUTED. Any code marker -> LLM.
    const codeCall: NarrowCall[] = [
      { name: "set_terminal_webgl", arguments: { enabled: false } },
    ];
    const prompts = [
      'python -c "import sys, os; sys.stdout.reconfigure()"',
      "run this: node -e \"console.log(1)\"",
      "fix the import sys reconfigure line in the script",
      "run scripts/run-tests.mjs and show me the output",
      "here is the code ```print(1)``` run it",
      // 2026-11-23 live false positive: a quoted PowerShell pipeline
      // classified as reminder_list and executed ("Listed reminders").
      "Set-Location D:\\Code\\2026\\KAI; Get-Content scripts/cactus/build_dataset.py | Select-Object -Skip 80 -First 120",
    ];
    for (const p of prompts) {
      expect(isCodeShapedPrompt(p), `expected code-shaped: ${p}`).toBe(true);
      const d = decideReflex(p, { calls: codeCall, confidence: 0.99 });
      expect(d.action === "fallthrough" && d.reason === "code-shaped", p).toBe(true);
    }
  });

  it("code-shape guard does NOT fire on real desktop-control prompts", () => {
    for (const p of [
      "switch to dark mode",
      "play groove salad",
      "remind me in 15 minutes to stretch",
      "open http://localhost:5173",
      "set terminal font size to 14",
      "zoom level 150 percent",
    ]) {
      expect(isCodeShapedPrompt(p), `must stay reflex-eligible: ${p}`).toBe(false);
    }
  });

  it("falls through when a settings key has no trace in the prompt (ungrounded hijack)", () => {
    // Same live hijack from the grounding side: "run a python script" carries
    // no webgl/hardware token, so terminalWebglEnabled is unjustified.
    const d = decideReflex(
      "run the tests in that package",
      { calls: [{ name: "set_terminal_webgl", arguments: { enabled: false } }], confidence: 0.99 },
    );
    expect(d.action === "fallthrough" && d.reason === "ungrounded").toBe(true);
  });

  it("grounds real settings calls by prompt tokens and value text", () => {
    // Key token + value text both traceable -> executes.
    const d = decideReflex(
      "switch the theme to tokyo night",
      { calls: [{ name: "set_ui_theme", arguments: { palette: "tokyo-night" } }], confidence: 0.9 },
    );
    expect(d.action).toBe("execute");
    // Value absent from the prompt -> ungrounded, falls through.
    const d2 = decideReflex(
      "switch the theme please",
      { calls: [{ name: "set_ui_theme", arguments: { palette: "tokyo-night" } }], confidence: 0.9 },
    );
    expect(d2.action === "fallthrough" && d2.reason === "ungrounded").toBe(true);
  });

  it("computed arguments (dueAt dates) are exempt from value grounding", () => {
    const ok = callGroundedInPrompt("remind me in 15 minutes to stretch", {
      name: "reminder_create",
      arguments: { message: "stretch", dueAt: "2026-11-23T18:00:00.000Z" },
    });
    expect(ok).toBe(true);
  });

  it("persona 'none' requires a persona trigger token and non-ASCII reminder values ground cleanly", () => {
    expect(
      callGroundedInPrompt("no persona for now", {
        name: "set_persona",
        arguments: { persona: "none" },
      }),
    ).toBe(true);
    // Hallucinated set_persona("none") with no persona keyword must be rejected.
    expect(
      callGroundedInPrompt("check the weather in Budapest", {
        name: "set_persona",
        arguments: { persona: "none" },
      }),
    ).toBe(false);
    // Unicode text grounds cleanly instead of collapsing to empty string.
    expect(
      callGroundedInPrompt("remind me in 5 min to meet at café", {
        name: "reminder_create",
        arguments: { message: "meet at café", dueAt: "2026-11-23T18:00:00.000Z" },
      }),
    ).toBe(true);
    expect(
      callGroundedInPrompt("play groove salad", {
        name: "play_radio",
        arguments: { station: "groovesalad" },
      }),
    ).toBe(true);
  });

  it("falls through when a coding prompt is classified as a radio command (2026-11-23 live hijack)", () => {
    // Live false positive: "start building the dynamic OpenAI proxy"
    // classified as play_radio and reported "Radio playing" — a coding
    // prompt carries zero radio vocabulary, so the radio-domain trigger
    // floor must refuse it regardless of confidence.
    const radioCall: NarrowCall[] = [
      { name: "play_radio", arguments: { station: "groovesalad" } },
    ];
    for (const p of [
      "start building the dynamic OpenAI proxy",
      "refactor the auth module",
      "explain how the scheduler works",
    ]) {
      const d = decideReflex(p, { calls: radioCall, confidence: 0.99 });
      expect(d.action === "fallthrough" && d.reason === "ungrounded", p).toBe(true);
    }
    // Real radio phrasings still execute.
    const ok = decideReflex("play some ambient music on the radio", {
      calls: [{ name: "play_radio", arguments: { station: "dronezone" } }],
      confidence: 0.9,
    });
    expect(ok.action).toBe("execute");
  });

  it("refuses sub-3-char radio stations (garbage the loose genre match would resolve)", () => {
    // A one/two-char "station" passes value grounding (any letter appears
    // somewhere in the prompt) and would resolve through play_radio's loose
    // substring/genre matching — refuse at the mapper instead.
    expect(
      mapNarrowCalls([{ name: "play_radio", arguments: { station: "ai" } }], NOW2),
    ).toBeNull();
    expect(
      mapNarrowCalls([{ name: "play_radio", arguments: { station: "x" } }], NOW2),
    ).toBeNull();
    // Real shortest station id ("lush", 4 chars) still passes.
    expect(
      mapNarrowCalls([{ name: "play_radio", arguments: { station: "lush" } }], NOW2),
    ).toEqual([{ name: "play_radio", arguments: { station: "lush" } }]);
  });

  // ── Run #5 zero-argument domains (2026-11-23) ──────────────────────
  it("maps the Run #5 zero-argument tools and refuses non-empty arguments", () => {
    for (const name of ["get_time", "stop_agent", "new_session", "list_skills", "list_personas", "list_sessions"]) {
      expect(
        mapNarrowCalls([{ name, arguments: {} }], NOW2),
      ).toEqual([{ name, arguments: {} }]);
      // A clipped slot into a no-arg tool poisons the turn.
      expect(
        mapNarrowCalls([{ name, arguments: { station: "lush" } }], NOW2),
      ).toBeNull();
    }
  });

  it("executes real Run #5 phrasings at high confidence", () => {
    const cases: Array<[string, string]> = [
      ["what time is it?", "get_time"],
      ["what date is it today?", "get_time"],
      ["hány óra van?", "get_time"],
      ["stop the agent", "stop_agent"],
      ["cancel the current run", "stop_agent"],
      ["new session", "new_session"],
      ["start a fresh conversation", "new_session"],
      ["what skills do i have?", "list_skills"],
      ["list my personas", "list_personas"],
      ["which sessions are open?", "list_sessions"],
    ];
    for (const [prompt, tool] of cases) {
      const d = decideReflex(prompt, {
        calls: [{ name: tool, arguments: {} }],
        confidence: 0.9,
      });
      expect(d.action === "execute" && d.calls?.[0]?.name === tool, prompt).toBe(true);
    }
  });

  it("Run #5 domains fall through when the prompt lacks domain vocabulary (hijack floor)", () => {
    // The classifier may emit a Run #5 tool at high confidence on a prompt
    // with zero domain vocabulary - the trigger floor must refuse it, the
    // same guard that stopped the radio coding-prompt hijack.
    const cases: Array<[string, string]> = [
      ["start building the dynamic openai proxy", "stop_agent"],
      ["refactor the auth module", "new_session"],
      ["explain the pty session spawn lock", "list_sessions"],
      ["fix the router bug", "get_time"],
    ];
    for (const [prompt, tool] of cases) {
      const d = decideReflex(prompt, {
        calls: [{ name: tool, arguments: {} }],
        confidence: 0.99,
      });
      expect(d.action === "fallthrough" && d.reason === "ungrounded", `${prompt} -> ${tool}`).toBe(true);
    }
  });

  it("reminder_list requires reminder vocabulary in the prompt (2026-11-23 shell-command false positive)", () => {
    // The engine classified a quoted PowerShell command as reminder_list;
    // the zero-arg call passes value grounding vacuously, so the domain
    // floor is the only guard. A prompt with no reminder vocabulary must
    // fall through as ungrounded, whatever the classifier says.
    const hijack = decideReflex(
      "Get-Content scripts/cactus/build_dataset.py | Select-Object -Skip 80",
      { calls: [{ name: "reminder_list", arguments: {} }], confidence: 0.99 },
    );
    expect(hijack.action === "fallthrough" && hijack.reason === "code-shaped").toBe(true);

    const noVocab = decideReflex("show me the build_dataset file", {
      calls: [{ name: "reminder_list", arguments: {} }],
      confidence: 0.99,
    });
    expect(noVocab.action === "fallthrough" && noVocab.reason === "ungrounded").toBe(true);

    // Real reminder_list prompts still execute.
    for (const p of ["what reminders do i have?", "list my reminders", "show pending reminders"]) {
      const d = decideReflex(p, {
        calls: [{ name: "reminder_list", arguments: {} }],
        confidence: 0.9,
      });
      expect(d.action === "execute", p).toBe(true);
    }
  });

  it("bare stop/cancel stay conversational acks (LLM context needed), but stop-the-agent is a real command", () => {
    // Bare "stop" is ambiguous mid-conversation (STOP the run? stop
    // asking? stop the radio?) - only the LLM has that context. The
    // engine never sees these prompts.
    for (const p of ["stop", "cancel", "abort"]) {
      const d = decideReflex(p, {
        calls: [{ name: "stop_agent", arguments: {} }],
        confidence: 0.99,
      });
      expect(d.action === "fallthrough" && d.reason === "conversational", p).toBe(true);
    }
  });
});
