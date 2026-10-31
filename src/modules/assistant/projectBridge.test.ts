import { describe, expect, it, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";

/**
 * "Send project to assistant" - Telegram project monitoring contract.
 *
 * The feature's security posture in one line: Telegram is a TRANSPORT for
 * the owner's own prompts into the owner's own project sessions - never a
 * capability grant to the assistant persona. These pins guard the seams:
 *
 *  1. ROUTING: /tell + sole-bound plain text + voice route through
 *     chatStore.injectMessage - the same primitive watches/groups use -
 *     so the project agent's sandbox/approvals apply unchanged.
 *  2. CAUSALITY: a reply is mirrored ONLY when provoked by a /tell
 *     (delivery boundary + one-shot provision, the group-chat contract);
 *     plain monitor pings fire only on busy->idle with a NEW reply.
 *  3. FENCE: the assistant's own toolset never widens - projectBridge
 *     must not touch makeAssistantToolContext's fence or the allowlist.
 *  4. AUDIT: every routed prompt + mirrored reply writes an audit entry.
 */

vi.mock("@tauri-apps/api/core", () => ({
  invoke: async (cmd: string, args?: { account?: string; password?: string }) => {
    if (cmd === "kai_home_dir") return "C:/Users/test";
    if (cmd === "fs_create_dir") return;
    if (cmd === "secrets_get") {
      return args?.account === "telegram_bot_token" ? "test-token" : null;
    }
    if (cmd === "secrets_set") return;
    if (cmd === "audit_append") return;
    throw new Error(`unexpected invoke: ${cmd}`);
  },
}));
vi.mock("@tauri-apps/plugin-store", () => {
  const map = new Map<string, unknown>();
  return {
    LazyStore: class {
      async get(key: string) {
        return map.get(key) ?? null;
      }
      async set(key: string, value: unknown) {
        map.set(key, value);
      }
      async save() {}
    },
  };
});
vi.mock("@/modules/ai/lib/keyring", () => ({
  EMPTY_PROVIDER_KEYS: {},
  getAllKeys: async () => ({}),
  getKey: async () => null,
}));

import {
  bindProjectForTelegramWith,
  clearMirrorProvision,
  formatProjectsStatus,
  listBoundProjects,
  tellProject,
  unbindProjectFromTelegram,
  __resetProjectMonitorForTest,
} from "./projectBridge";

const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");
const bridge = read("./projectBridge.ts");
const index = read("./index.ts");
const menuItem = read("../ai/components/TelegramMonitorMenuItem.tsx");

// chatStore mock: sessions + injectMessage spy.
const injectMessageMock = vi.fn(async () => undefined);
const activeSessions = [{ id: "s-1", workspaceRoot: "D:/Code/demo", title: "demo" }];
vi.mock("@/modules/ai/store/chatStore", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/modules/ai/store/chatStore")>();
  return {
    ...actual,
    useChatStore: {
      getState: () => ({
        sessions: activeSessions,
        activeSessionId: "s-1",
        live: { getWorkspaceRoot: () => "D:/Code/demo" },
        injectMessage: injectMessageMock,
      }),
    },
    subscribeSessionAgentMeta: () => () => {},
  };
});

beforeEach(() => {
  __resetProjectMonitorForTest();
  injectMessageMock.mockReset();
});

describe("bindings", () => {
  it("bind/unbind round-trips through prefs", async () => {
    await bindProjectForTelegramWith("demo-id", "D:/Code/demo", "demo", "s-1");
    let bound = await listBoundProjects();
    expect(bound["demo-id"]).toEqual({ root: "D:/Code/demo", name: "demo", sessionId: "s-1" });

    await unbindProjectFromTelegram("demo-id");
    bound = await listBoundProjects();
    expect(bound["demo-id"]).toBeUndefined();
  });

  it("re-binding the same project replaces, not duplicates", async () => {
    await bindProjectForTelegramWith("demo-id", "D:/Code/demo", "demo", "s-1");
    await bindProjectForTelegramWith("demo-id", "D:/Code/demo", "demo", "s-2");
    const bound = await listBoundProjects();
    expect(Object.keys(bound)).toHaveLength(1);
    expect(bound["demo-id"]!.sessionId).toBe("s-2");
  });
});

describe("/tell routing", () => {
  it("routes the message into the bound session via injectMessage", async () => {
    await bindProjectForTelegramWith("demo-id", "D:/Code/demo", "demo", "s-1");
    const outcome = await tellProject("demo", "run the tests", 42);
    expect(outcome).toContain("Sent to demo");
    expect(injectMessageMock).toHaveBeenCalledWith("s-1", "[via Telegram] run the tests");
  });

  it("finds the target by name (case-insensitive) and id", async () => {
    await bindProjectForTelegramWith("demo-id", "D:/Code/demo", "demo", "s-1");
    await tellProject("DEMO", "a", 42);
    expect(injectMessageMock).toHaveBeenCalledWith("s-1", expect.stringContaining("a"));
  });

  it("unknown target produces an actionable reply, not silence", async () => {
    await bindProjectForTelegramWith("demo-id", "D:/Code/demo", "demo", "s-1");
    const outcome = await tellProject("nope", "hello", 42);
    expect(outcome).toContain("No monitored project matches");
    expect(injectMessageMock).not.toHaveBeenCalled();
  });

  it("re-resolves a dead bound session to the project's current one", async () => {
    // Bound session s-old no longer exists; s-1 is the project's session.
    await bindProjectForTelegramWith("demo-id", "D:/Code/demo", "demo", "s-old");
    await tellProject("demo", "status?", 42);
    expect(injectMessageMock).toHaveBeenCalledWith(
      "s-1",
      expect.stringContaining("[via Telegram] status?"),
    );
    // The re-resolution persists back into prefs.
    const bound = await listBoundProjects();
    expect(bound["demo-id"]!.sessionId).toBe("s-1");
  });

  it("/projects status names bindings and their agent state", async () => {
    await bindProjectForTelegramWith("demo-id", "D:/Code/demo", "demo", "s-1");
    const status = await formatProjectsStatus();
    expect(status).toContain("demo (demo-id)");
    expect(status).toContain("/tell");
  });
});

describe("causality + audit (source pins)", () => {
  it("a /tell arms a one-shot mirror provision with a reply boundary", () => {
    // tellProject snapshots the last assistant id BEFORE injecting and
    // stores { chatId, boundaryId } - mirror sends only a reply that
    // post-dates it, once.
    expect(bridge).toContain("mirrorProvisions.set(sessionId, { chatId, boundaryId: lastAssistant?.id ?? null });");
    expect(bridge).toMatch(/const lastAssistant = \[\.\.\.chat\.messages\]\.reverse\(\)\.find\(\(m\) => m\.role === \"assistant\"\)/);
  });

  it("the monitor mirrors only provoked replies and pings only new ones", () => {
    expect(bridge).toContain("lastAssistant.id !== provision.boundaryId");
    expect(bridge).toContain("monitorLastReplyId.get(sessionId) !== lastAssistant.id");
    // Provision is consumed either way (one-shot).
    expect(bridge).toContain("mirrorProvisions.delete(sessionId)");
    expect(bridge).toContain("clearMirrorProvision");
  });

  it("approval transitions ping once and point at the desktop", () => {
    expect(bridge).toContain("meta.status === \"awaiting-approval\" && prev !== \"awaiting-approval\"");
    expect(bridge).toMatch(/respond on the desktop/);
  });

  it("every routed prompt + mirrored reply is audited", () => {
    expect(bridge).toContain('auditAppend(\n    AUDIT_KINDS.assistantExec,\n    "telegram-tell"');
    expect(bridge).toContain('"telegram-reply"');
    expect(bridge).toContain('"telegram-bind"');
  });

  it("FENCE: routing never widens the assistant toolset", () => {
    // projectBridge must not touch the fenced context builder, the tool
    // allowlist, or any sandbox override - the assistant persona stays
    // inside ~/.kai/assistant. (Code-only scan: skip the doc comments.)
    const code = bridge.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    expect(code).not.toContain("makeAssistantToolContext");
    expect(code).not.toContain("allowedTools");
    expect(code).not.toContain("getSandboxOverride");
    expect(code).not.toContain("isToolAllowed");
  });
});

describe("telegram command surface (source pins)", () => {
  it("/projects and /tell exist and /help documents them", () => {
    expect(index).toContain('case "/projects"');
    expect(index).toContain('case "/tell"');
    expect(index).toContain("/projects - list monitored projects");
    expect(index).toContain("/tell <name> <msg> - prompt a monitored project's agent");
  });

  it("plain text routes to the sole bound project, assistant otherwise", () => {
    expect(index).toContain("soleBoundTarget");
    expect(index).toMatch(/entries\.length === 1 \? entries\[0\]!\[0\] : null/);
    // Voice transcripts route the same way.
    expect(index).toContain("// Sole bound project: the voice transcript routes to the project agent");
  });

  it("/tell does not consume an assistant turn", () => {
    const tellCase = index.slice(index.indexOf('case "/tell"'), index.indexOf('case "/new"'));
    expect(tellCase).not.toContain("runAssistantTurn");
    expect(tellCase).not.toContain("pendingQueue.push");
  });
});

describe("desktop bind toggle (source pins)", () => {
  it("the session menu exposes the monitor toggle, hidden when the bot is off", () => {
    expect(menuItem).toContain("Monitor via Telegram");
    expect(menuItem).toContain("Stop Telegram monitoring");
    expect(menuItem).toContain("if (!prefs.enabled)");
  });

  it("bind uses explicit identity (no chatStore import at the UI layer)", () => {
    expect(menuItem).toContain("bindProjectForTelegramWith");
  });

  it("mounting: the toggle sits in the session dropdown next to Shadow mode", () => {
    const mini = read("../ai/components/AiMiniWindow.tsx");
    expect(mini).toContain("<TelegramMonitorMenuItem />");
  });
});

void clearMirrorProvision;
