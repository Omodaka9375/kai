import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { buildStableSystem } from "./agent";

/**
 * The assistant-name wiring regression: a custom agent name set in Settings
 * must (a) reach the system prompt as an explicit "Your name is" statement,
 * (b) win over the same-id builtin persona (Settings saves builtin edits as
 * customAgents entries with the builtin id), and (c) flow into the Telegram
 * assistant persona too.
 *
 * (b) and (c) are pinned at source level — the wiring lives behind
 * tauri-store IPC (loadAgents) that Node cannot drive; the PRECEDENCE is
 * the contract that matters: customAgents-first lookup + the renamed name
 * landing in the prompt.
 */

const libDir = import.meta.dirname;
const read = (rel: string) =>
  readFileSync(`${libDir}/${rel}`, "utf8");

describe("persona name reaches the system prompt", () => {
  it("buildStableSystem states the persona name explicitly", () => {
    const sys = buildStableSystem(
      "test-model" as never,
      { name: "Ziggy", instructions: "Be brief." },
      undefined,
      null,
    );
    expect(sys).toContain('Your name is "Ziggy"');
    expect(sys).toContain("## ACTIVE AGENT");
    expect(sys).toContain("Be brief.");
  });

  it("omits the persona block entirely when no persona is set", () => {
    const sys = buildStableSystem("test-model" as never, null, undefined, null);
    expect(sys).not.toContain("Your name is");
    expect(sys).not.toContain("ACTIVE AGENT");
  });

  it("does not state a name when instructions are empty (header-only guard)", () => {
    // A persona with blank instructions produced an empty block before; the
    // name statement must not appear on its own either.
    const sys = buildStableSystem(
      "test-model" as never,
      { name: "Ghost", instructions: "   " },
      undefined,
      null,
    );
    expect(sys).not.toContain('Your name is "Ghost"');
  });
});

describe("Settings override precedence (source pins)", () => {
  it("chatRuntime resolves customAgents BEFORE builtins", () => {
    const src = read("chatRuntime.ts");
    // The override-first lookup - the old code spread BUILTIN_AGENTS first
    // and .find() always matched the stock builtin, so a renamed builtin
    // never reached the model.
    expect(src).toContain("customAgents.find((x) => x.id === selectedId)");
    expect(src).not.toMatch(
      /\[\.\.\.BUILTIN_AGENTS, \.\.\.customAgents\]\s*\n?\s*\.find/,
    );
  });

  it("Telegram assistant honors the Settings rename too", () => {
    const src = read("../../assistant/index.ts");
    // resolveAssistantPersona: customAgents-first for builtin:general.
    expect(src).toContain("resolveAssistantPersona");
    expect(src).toContain('custom.find((c) => c.id === "builtin:general")');
    // The name must reach the assistant's system prompt.
    expect(src).toContain('`Your name is "${persona.name}"');
    expect(src).toContain("await resolveAssistantPersona()");
  });
});