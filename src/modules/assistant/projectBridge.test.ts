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

import { loadAssistantPrefs, updateAssistantPrefs } from "./prefs";
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
const testRouting = vi.hoisted(() => ({
  currentSession: "s-1",
  open: true,
  busy: false,
}));
const ensureChatHydratedMock = vi.hoisted(() => vi.fn(async () => ({ messages: [] })));
const steeringMock = vi.hoisted(() => vi.fn());
const activeSessions = [{ id: "s-1", workspaceRoot: "D:/Code/demo", title: "demo" }];
vi.mock("@/modules/ai/store/chatStore", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/modules/ai/store/chatStore")>();
  return {
    ...actual,
    ensureChatHydrated: ensureChatHydratedMock,
    isProjectOpen: () => testRouting.open,
    resolveBackgroundProjectSession: async () => testRouting.open ? testRouting.currentSession : null,
    setSessionSteeringMessage: steeringMock,
    getSessionSteeringMessage: () => [],
    getSessionAgentMeta: () => ({ status: testRouting.busy ? "streaming" : "idle" }),
    useChatStore: {
      getState: () => ({
        sessions: activeSessions,
        activeSessionId: testRouting.currentSession,
        live: { getWorkspaceRoot: () => "D:/Code/demo" },
        injectMessage: injectMessageMock,
      }),
    },
    subscribeSessionAgentMeta: () => () => {},
  };
});

beforeEach(() => {
  __resetProjectMonitorForTest();
  testRouting.currentSession = "s-1";
  testRouting.open = true;
  testRouting.busy = false;
  activeSessions.splice(0, activeSessions.length, { id: "s-1", workspaceRoot: "D:/Code/demo", title: "demo" });
  injectMessageMock.mockReset();
  ensureChatHydratedMock.mockClear();
  steeringMock.mockClear();
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

  it("preference updates preserve bindings made by another window", async () => {
    await bindProjectForTelegramWith("demo-id", "D:/Code/demo", "demo", "s-1");
    await updateAssistantPrefs({ voiceReplies: false });
    const prefs = await loadAssistantPrefs();
    expect(prefs.voiceReplies).toBe(false);
    expect(prefs.boundProjects["demo-id"]).toBeDefined();
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
    expect(injectMessageMock).toHaveBeenCalledWith("s-1", "[via Telegram] run the tests", expect.any(Function));
  });

  it("finds the target by name (case-insensitive) and id", async () => {
    await bindProjectForTelegramWith("demo-id", "D:/Code/demo", "demo", "s-1");
    await tellProject("DEMO", "a", 42);
    expect(injectMessageMock).toHaveBeenCalledWith("s-1", expect.stringContaining("a"), expect.any(Function));
  });

  it("unknown target produces an actionable reply, not silence", async () => {
    await bindProjectForTelegramWith("demo-id", "D:/Code/demo", "demo", "s-1");
    const outcome = await tellProject("nope", "hello", 42);
    expect(outcome).toContain("No monitored project matches");
    expect(injectMessageMock).not.toHaveBeenCalled();
  });

  it("follows the project's current session after a desktop session switch", async () => {
    activeSessions.push({ id: "s-2", workspaceRoot: "D:/Code/demo", title: "second" });
    await bindProjectForTelegramWith("demo-id", "D:/Code/demo", "demo", "s-1");
    testRouting.currentSession = "s-2";
    await tellProject("demo", "continue here", 42);
    expect(ensureChatHydratedMock).toHaveBeenCalledWith("s-2");
    expect(injectMessageMock).toHaveBeenCalledWith("s-2", "[via Telegram] continue here", expect.any(Function));
    expect((await listBoundProjects())["demo-id"]!.sessionId).toBe("s-2");
  });

  it("steering also releases an approval-paused run before sending", async () => {
    const source = readFileSync(new URL("../ai/components/AgentRunBridge.tsx", import.meta.url), "utf8");
    const effect = source.slice(
      source.indexOf("useEffect(() => {", source.indexOf("const steeringMessage")),
      source.indexOf("// ── Group chat: delegation preamble"),
    );
    expect(effect).toContain("status === \"submitted\" || status === \"streaming\" || approvalsPending > 0");
    expect(effect).toContain("stopSession(sessionId);");
    expect(effect).toContain("[steeringMessage, status, approvalsPending, chat, setSteeringMessage]");
  });

  it("reuses composer steering when the target agent is busy", async () => {
    testRouting.busy = true;
    await bindProjectForTelegramWith("demo-id", "D:/Code/demo", "demo", "s-1");
    const outcome = await tellProject("demo", "steer this", 42);
    expect(outcome).toContain("will steer the run");
    expect(steeringMock).toHaveBeenCalledWith("s-1", [{ type: "text", text: "[via Telegram] steer this" }]);
    expect(injectMessageMock).not.toHaveBeenCalled();
  });

  it("refuses to fabricate a chat for a closed project", async () => {
    await bindProjectForTelegramWith("demo-id", "D:/Code/demo", "demo", "s-1");
    testRouting.open = false;
    const outcome = await tellProject("demo", "hello", 42);
    expect(outcome).toContain("no chat session");
    expect(injectMessageMock).not.toHaveBeenCalled();
  });

  it("/projects status names bindings and their agent state", async () => {
    await bindProjectForTelegramWith("demo-id", "D:/Code/demo", "demo", "s-1");
    const status = await formatProjectsStatus();
    expect(status).toContain("demo (demo-id)");
    expect(status).toContain("/tell");
  });
});

describe("causality + audit (source pins)", () => {
  it("a /tell arms a one-shot mirror provision with a prompt boundary", () => {
    // The mirror accepts only the assistant response AFTER the Telegram
    // prompt, not a response from an older interrupted run.
    expect(bridge).toContain("mirrorProvisions.set(sessionId, { chatId, promptText: text });");
    expect(bridge).toContain("replyIndex > promptIndex");
  });

  it("the monitor mirrors only provoked replies and pings only new ones", () => {
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
    expect(index).toContain("/tell <msg> - message the monitored project");
  });

  it("sole-bound shorthand: /tell <message> routes without a project name", () => {
    // With exactly one binding the ENTIRE argument is the message, unless
    // the first token explicitly names/id's that project (then the
    // two-token form still works).
    expect(index).toContain("const sole = await soleBoundProject();");
    expect(index).toContain("if (sole && !namesSole) {");
    expect(index).toContain("const outcome = await tellProject(sole.id, arg, chatId);");
    expect(index).toContain("namesSole");
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
    expect(menuItem).toContain("Send to Assistant");
    expect(menuItem).toContain("Remove from Assistant");
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
