import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Custom-instructions persistence contract (2026-10-31).
 *
 * "Make sure Custom instructions under Agents settings are saved and
 * survive restarts and updates."
 *
 * Verified storage path: AgentsSection's CustomInstructionsBlock →
 * setCustomInstructions → writePref(KEY_CUSTOM_INSTRUCTIONS) →
 * tauri-plugin-store LazyStore (Kai-settings.json, app-data dir) →
 * survives restarts AND app updates (the app-data dir is untouched by
 * NSIS installs). The instruction text ALSO flows into every agent run
 * via transport.ts getCustomInstructions → system prompt.
 *
 * The bug class fixed here is at the UI layer: the settings window
 * renders the section BEFORE init() hydrates, and the old block latched
 * its draft to the pre-hydration empty string, so the textarea showed
 * BLANK after every restart — the text was safe on disk the whole time,
 * but LOOKED lost (and retyping over it destroyed the real value).
 */

const read = (rel: string) =>
  readFileSync(new URL(rel, import.meta.url), "utf8") as string;

describe("storage layer (disk durability)", () => {
  const store = read("../modules/settings/store.ts");

  it("persists via the tauri plugin store, not localStorage (WebView2 wipes localStorage per-PID)", () => {
    expect(store).toContain("LazyStore");
    expect(store).toContain('const STORE_PATH = "Kai-settings.json"');
    expect(store).not.toContain("localStorage");
  });

  it("writes and loads under the SAME key (a mismatch would silently strand saved text)", () => {
    expect(store).toMatch(
      /const KEY_CUSTOM_INSTRUCTIONS = "customInstructions";/,
    );
    // loadPreferences reads it…
    expect(store).toMatch(
      /get<string>\(KEY_CUSTOM_INSTRUCTIONS\) \?\?/,
    );
    // …and setCustomInstructions writes it.
    expect(store).toMatch(
      /setCustomInstructions\(value: string\)[\s\S]{0,120}writePref\(KEY_CUSTOM_INSTRUCTIONS, value\)/,
    );
  });

  it("writePref persists + flushes (set AND save) and broadcasts cross-window", () => {
    expect(store).toMatch(
      /async function writePref[\s\S]{0,200}await store\.set\(key, value\);[\s\S]{0,60}await store\.save\(\);[\s\S]{0,80}emit\(PREFS_CHANGED_EVENT/,
    );
  });

  it("the pref change event maps customInstructions so the main window re-reads it live", () => {
    expect(store).toMatch(
      /\[KEY_CUSTOM_INSTRUCTIONS\]: "customInstructions",/,
    );
  });
});

describe("consumption layer (the instructions actually reach the model)", () => {
  const transport = read("../modules/ai/lib/transport.ts");
  const agent = read("../modules/ai/lib/agent.ts");

  it("transport reads customInstructions from the preferences store lazily", () => {
    expect(transport).toContain(
      "getCustomInstructions: () => string;",
    );
  });
  it("the prompt builder appends the USER CUSTOM INSTRUCTIONS block", () => {
    expect(agent).toContain("## USER CUSTOM INSTRUCTIONS");
  });
});

describe("AgentsSection CustomInstructionsBlock (hydration + save UX)", () => {
  const section = read("./sections/AgentsSection.tsx");

  it("the draft re-syncs from the store on EVERY value change while clean — no once-only latch", () => {
    // The old once-only sync latch captured the pre-hydration "" and
    // ignored the real value when it landed (textarea showed blank after
    // restart).
    expect(section).not.toContain("hadFirstSync");
    expect(section).toMatch(/if \(!isDirty\) setDraft\(value\);/);
  });

  it("the textarea is gated on hydration — blank + 'Loading' placeholder until prefs land", () => {
    expect(section).toContain("disabled={!hydrated}");
    expect(section).toContain('placeholder={\n          hydrated\n            ? "e.g.');
  });

  it("emptying the field is saveable (isDirty alone, not isDirty && draft)", () => {
    expect(section).toMatch(/\{isDirty \? \(\s*\n\s*<Button size="xs" onClick=\{handleSave\}>/);
    expect(section).not.toMatch(/isDirty && draft \?/);
  });

  it("a failed save surfaces an error instead of looking like success", () => {
    expect(section).toContain("Save failed — try again");
    expect(section).toMatch(
      /const handleSave = async \(\) => \{\s*try \{\s*await setCustomInstructions\(draft\);[\s\S]{0,400}catch/,
    );
  });
});

describe("per-agent instructions (AgentEditorDialog + agentsStore)", () => {
  const store = read("../modules/ai/store/agentsStore.ts");
  const lib = read("../modules/ai/lib/agents.ts");

  it("upsert/remove persist to disk immediately (kai-agents.json), not just zustand state", () => {
    expect(store).toMatch(
      /upsert: \(agent\) => \{[\s\S]{0,400}void saveCustomAgents\(next\)\.then\(broadcast\);/,
    );
    expect(store).toMatch(
      /remove: \(id\) => \{[\s\S]{0,900}void saveCustomAgents\(list\)\.then\(broadcast\);/,
    );
  });

  it("saveCustomAgents flushes the store file (set + save)", () => {
    expect(lib).toMatch(
      /export async function saveCustomAgents[\s\S]{0,140}await store\.set\(KEY_CUSTOM, custom\);\s*await store\.save\(\);/,
    );
  });

  it("a failed hydrate unlatches and retries (no permanently-empty agent list)", () => {
    expect(store).toContain(
      "initialized = false;",
    );
    expect(store).toContain("hydrate failed (will retry on next call)");
  });
});
