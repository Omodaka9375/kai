import { describe, expect, it, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";

/**
 * CONVERSATIONAL PERSONA TOOLING (2026-11-01).
 *
 * User ask: "a tool so the user can create agent personas on the go — just
 * say what he wants — create or set new or any persona for the project in
 * conversation on demand without losing context or memory. Similar to how
 * the user can switch personas in the AI window persona picker dropdown."
 *
 * Contract:
 *  - create_persona: builds a NEW custom agent persona (persisted via
 *    agentsStore.upsert — same path Settings uses) and activates it for the
 *    conversation.
 *  - set_persona: switches the conversation to an EXISTING persona by name
 *    or id ("none" deactivates).
 *  - Activation = the persona picker's OWN semantics: the per-SESSION
 *    personaId override (sessionPreferences — what chatRuntime reads first)
 *    plus the full picker path (setActiveId: project persistence + picker
 *    display + cross-window broadcast) ONLY when this session is the
 *    foreground one — a background agent never reassigns the visible
 *    project's persona.
 *  - CONTEXT/MEMORY SAFETY: no message history, memory, todos, or persisted
 *    transcript is touched — the persona is a system-prompt block for
 *    subsequent turns. Pinned below.
 *  - Both tools AUTO-RUN (trivial reversible preference, set_my_name class).
 */

vi.mock("@tauri-apps/plugin-store", () => {
  class FakeLazyStore {
    async get() { return null; }
    async set() {}
    async save() {}
  }
  return { LazyStore: FakeLazyStore };
});

const shared = vi.hoisted(() => ({
  activeSessionId: "s-fg" as string | null,
  upsert: vi.fn(),
  setActiveId: vi.fn(),
}));

vi.mock("./chatStore", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./chatStore")>();
  return {
    ...actual,
    useChatStore: {
      getState: () => ({ activeSessionId: shared.activeSessionId }),
    },
  };
});

vi.mock("./agentsStore", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./agentsStore")>();
  return {
    ...actual,
    useAgentsStore: {
      getState: () => ({
        customAgents: [],
        upsert: shared.upsert,
        setActiveId: shared.setActiveId,
      }),
    },
  };
});

import { buildPersonaTools } from "../tools/persona";
import { getSessionPreferences, removeSessionPreferences } from "./sessionPreferences";

type PersonaTools = {
  create_persona: { needsApproval?: boolean; execute: (i: { name: string; instructions: string; description?: string; icon?: string }) => Promise<{ ok: boolean; id?: string; name?: string; note?: string }> };
  set_persona: { needsApproval?: boolean; execute: (i: { persona: string }) => Promise<{ ok: boolean; note?: string }> };
};

const fgCtx = {
  getSessionId: () => "s-fg",
} as Parameters<typeof buildPersonaTools>[0];
const bgCtx = {
  getSessionId: () => "s-bg",
} as Parameters<typeof buildPersonaTools>[0];

beforeEach(() => {
  shared.activeSessionId = "s-fg";
  shared.upsert.mockReset();
  shared.setActiveId.mockReset();
  removeSessionPreferences("s-fg");
  removeSessionPreferences("s-bg");
});

describe("create_persona", () => {
  it("creates a persisted custom persona and activates it for the conversation (picker semantics)", async () => {
    const tools = buildPersonaTools(fgCtx) as unknown as PersonaTools;
    expect(tools.create_persona.needsApproval).not.toBe(true);
    const res = await tools.create_persona.execute({
      name: "Test Engineer",
      instructions: "You are a test engineer. Always run the test suite first.",
      description: "Runs tests first",
      icon: "reviewer",
    });
    expect(res.ok).toBe(true);
    expect(res.name).toBe("Test Engineer");
    // Persisted via the SAME path Settings uses (agentsStore.upsert).
    expect(shared.upsert).toHaveBeenCalledTimes(1);
    const saved = shared.upsert.mock.calls[0]?.[0] as { id: string; name: string; builtIn: boolean };
    expect(saved.name).toBe("Test Engineer");
    expect(saved.builtIn).toBe(false);
    // Activated for the session (the picker's per-session override)...
    expect(getSessionPreferences("s-fg").personaId).toBe(saved.id);
    // ...and the FULL picker path ran for the foreground session.
    expect(shared.setActiveId).toHaveBeenCalledWith(saved.id);
  });

  it("a BACKGROUND session never touches the foreground project's persona", async () => {
    const tools = buildPersonaTools(bgCtx) as unknown as PersonaTools;
    const res = await tools.create_persona.execute({
      name: "Bg Helper",
      instructions: "You help in the background.",
    });
    expect(res.ok).toBe(true);
    // Session-scoped activation happened for ITS OWN session...
    expect(getSessionPreferences("s-bg").personaId).toBe(res.id);
    // ...but the picker path (project-level persona) never ran.
    expect(shared.setActiveId).not.toHaveBeenCalled();
  });

  it("refuses an empty name", async () => {
    const tools = buildPersonaTools(fgCtx) as unknown as PersonaTools;
    const res = await tools.create_persona.execute({ name: "   ", instructions: "x" });
    expect(res.ok).toBe(false);
  });
});

describe("set_persona", () => {
  it("switches by name, id, and prefix (relaxed matcher, case-insensitive)", async () => {
    const tools = buildPersonaTools(fgCtx) as unknown as PersonaTools;
    const r1 = await tools.set_persona.execute({ persona: "security" });
    expect(r1.ok).toBe(true);
    expect(getSessionPreferences("s-fg").personaId).toBe("builtin:security");
    const r2 = await tools.set_persona.execute({ persona: "Code Reviewer" });
    expect(r2.ok).toBe(true);
    expect(getSessionPreferences("s-fg").personaId).toBe("builtin:reviewer");
    const r3 = await tools.set_persona.execute({ persona: "sec" });
    expect(r3.ok).toBe(true);
    expect(getSessionPreferences("s-fg").personaId).toBe("builtin:security");
  });

  it('"none" deactivates the persona for the conversation', async () => {
    const tools = buildPersonaTools(fgCtx) as unknown as PersonaTools;
    await tools.set_persona.execute({ persona: "architect" });
    expect(getSessionPreferences("s-fg").personaId).toBe("builtin:architect");
    const res = await tools.set_persona.execute({ persona: "none" });
    expect(res.ok).toBe(true);
    expect(getSessionPreferences("s-fg").personaId).toBe("__none__");
  });

  it("refuses unknown personas with the roster in the note", async () => {
    const tools = buildPersonaTools(fgCtx) as unknown as PersonaTools;
    const res = await tools.set_persona.execute({ persona: "no-such-persona" });
    expect(res.ok).toBe(false);
    expect(res.note).toContain("unknown persona");
    expect(res.note).toContain("Coder");
  });
});

describe("context/memory safety (the ask)", () => {
  const persona = readFileSync(new URL("../tools/persona.ts", import.meta.url), "utf8");

  it("the tool never touches message history or memory — only sessionPreferences personaId", () => {
    // The ONLY session-mutation surface is the personaId preference.
    expect(persona).toContain("setSessionPreferences(sid, { personaId })");
    expect(persona).toContain('activatePersona(ctx, "__none__")');
    // No message/memory/transcript mutation APIs anywhere in the tool.
    for (const banned of [
      "persistMessages",
      "deleteMessages",
      "chat.messages",
      "saveMemory",
      "clearSession",
      "removeSession",
    ]) {
      expect(persona).not.toContain(banned);
    }
  });

  it("activation mirrors the persona picker's own semantics (session pref + foreground-only setActiveId)", () => {
    // The picker's per-session override is the primary write; the full
    // picker path (setActiveId: persistence + broadcast + picker display)
    // runs ONLY when this session is the foreground one.
    expect(persona).toContain("useChatStore.getState().activeSessionId === sid");
    expect(persona).toContain("useAgentsStore.getState().setActiveId(personaId)");
  });

  it("both tools are auto-run (no approval pause) — set_my_name class", () => {
    expect(persona).not.toMatch(/needsApproval: true/);
  });
});