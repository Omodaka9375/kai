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
  it("covers every narrow tool in scripts/cactus/schemas.json", () => {
    // Raw read so the test does not depend on tsconfig JSON imports.
    const fs = require("node:fs") as typeof import("node:fs");
    const path = require("node:path") as typeof import("node:path");
    // src/modules/ai/lib -> ../../../../scripts/cactus
    const schemaPath = path.resolve(
      __dirname,
      "../../../../scripts/cactus/schemas.json",
    );
    const schemas = JSON.parse(fs.readFileSync(schemaPath, "utf-8")) as {
      narrow_tools: Array<{ name: string }>;
    };
    const names = schemas.narrow_tools.map((t) => t.name);
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
    const w = decideReflex("wait 5 seconds", { calls: good, confidence: 0.99 });
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

  it("persona 'none' and station values ground through synonyms", () => {
    expect(
      callGroundedInPrompt("no persona for now", {
        name: "set_persona",
        arguments: { persona: "none" },
      }),
    ).toBe(true);
    expect(
      callGroundedInPrompt("play groove salad", {
        name: "play_radio",
        arguments: { station: "groovesalad" },
      }),
    ).toBe(true);
  });
});
