import { describe, expect, it, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";

/**
 * Telegram approval commands (Phase 2) - contract:
 *
 *  - ONLY bound (monitored) projects' approvals are phone-visible.
 *  - Decisions route through respondToApprovalStandalone (the audited,
 *    latched desktop responder) - a Telegram approve == one desktop click.
 *  - PRIVACY/ELEVATED carve-outs (look_at_screen, bash_run) are NEVER
 *    phone-approvable; their pings say "desktop only" and /approve
 *    refuses them.
 *  - The awaiting-approval ping now carries tool + summary + command ids.
 */

const respondMock = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/api/core", () => ({
  invoke: async (cmd: string, args?: { account?: string }) => {
    if (cmd === "kai_home_dir") return "C:/Users/test";
    if (cmd === "fs_create_dir") return;
    if (cmd === "secrets_get")
      return args?.account === "telegram_bot_token" ? "tok" : null;
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
vi.mock("@/modules/ai/store/chatStore", () => ({
  getChat: (sessionId: string) =>
    sessionId === "sess-a"
      ? {
          messages: [
            {
              role: "assistant",
              parts: [
                {
                  type: "tool-write_file",
                  state: "approval-requested",
                  toolCallId: "tc-1",
                  approval: { id: "ap-1" },
                  input: { path: "src/a.ts", content: "x" },
                },
                {
                  type: "tool-bash_run",
                  state: "approval-requested",
                  toolCallId: "tc-2",
                  approval: { id: "ap-2" },
                  input: { command: "rm -rf build" },
                },
              ],
              metadata: { createdAt: 1 },
            },
          ],
        }
      : sessionId === "sess-other"
        ? {
            messages: [
              {
                role: "assistant",
                parts: [
                  {
                    type: "tool-edit",
                    state: "approval-requested",
                    toolCallId: "tc-3",
                    approval: { id: "ap-3" },
                    input: { path: "y.ts" },
                  },
                ],
                metadata: { createdAt: 2 },
              },
            ],
          }
        : undefined,
  respondToApprovalStandalone: respondMock,
  setChatPinner: () => {},
}));

import {
  formatApprovalPing,
  formatApprovalsList,
  pendingTelegramApprovals,
  respondTelegramApproval,
} from "./telegramApprovals";
import { bindProjectForTelegramWith } from "./projectBridge";

const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");

beforeEach(async () => {
  respondMock.mockReset();
  // Bind one project: sess-a is monitored, sess-other is not.
  await bindProjectForTelegramWith("p-a", "D:/Code/alpha", "alpha", "sess-a");
});

describe("pendingTelegramApprovals", () => {
  it("enumerates ONLY bound project sessions", async () => {
    const pending = await pendingTelegramApprovals();
    expect(pending.some((a) => a.id === "ap-1")).toBe(true);
    expect(pending.some((a) => a.id === "ap-3")).toBe(false);
  });

  it("marks privacy/elevated carve-outs desktop-only", async () => {
    const pending = await pendingTelegramApprovals();
    const write = pending.find((a) => a.id === "ap-1")!;
    const shell = pending.find((a) => a.id === "ap-2")!;
    expect(write.desktopOnly).toBe(false);
    expect(shell.desktopOnly).toBe(true);
  });
});

describe("formatApprovalPing / list", () => {
  it("the ping names the tool, summarizes input, and offers command ids", async () => {
    const pending = await pendingTelegramApprovals();
    const write = pending.find((a) => a.id === "ap-1")!;
    const text = formatApprovalPing(write);
    expect(text).toContain("alpha");
    expect(text).toContain("Write file");
    expect(text).toContain("src/a.ts");
    expect(text).toContain("/approve ap-1");
    expect(text).toContain("/deny ap-1");
  });

  it("desktop-only calls refuse command ids in the ping", async () => {
    const pending = await pendingTelegramApprovals();
    const shell = pending.find((a) => a.id === "ap-2")!;
    const text = formatApprovalPing(shell);
    expect(text).toContain("only be approved on the desktop");
    expect(text).not.toContain("/approve ap-2");
  });

  it("/approvals lists pending ids", async () => {
    const list = await formatApprovalsList();
    expect(list).toContain("Pending approvals");
    expect(list).toContain("/approve ap-1");
  });
});

describe("respondTelegramApproval", () => {
  it("approves a bound session's approval via the standalone responder", async () => {
    const out = await respondTelegramApproval("ap-1", true);
    expect(out).toContain("Approved");
    expect(respondMock).toHaveBeenCalledWith("ap-1", true);
  });

  it("denies route the same way", async () => {
    await respondTelegramApproval("ap-1", false);
    expect(respondMock).toHaveBeenCalledWith("ap-1", false);
  });

  it("refuses desktop-only calls even with a valid id", async () => {
    const out = await respondTelegramApproval("ap-2", true);
    expect(out).toContain("only be approved on the desktop");
    expect(respondMock).not.toHaveBeenCalled();
  });

  it("unknown id produces an actionable reply", async () => {
    const out = await respondTelegramApproval("ap-nope", true);
    expect(out).toContain("No pending approval");
    expect(respondMock).not.toHaveBeenCalled();
  });

  it("unbound sessions' approvals are not decidable from the phone", async () => {
    const out = await respondTelegramApproval("ap-3", true);
    expect(out).toContain("No pending approval");
    expect(respondMock).not.toHaveBeenCalled();
  });
});

describe("source pins", () => {
  it("commands + help + rich ping wiring", () => {
    const index = read("../assistant/index.ts");
    expect(index).toContain('case "/approvals"');
    expect(index).toContain('case "/approve":');
    expect(index).toContain("respondTelegramApproval(arg");
    expect(index).toContain('"/approvals - list pending approvals');
    const bridge = read("./projectBridge.ts");
    expect(bridge).toContain("approvalPing(sessionId)");
    expect(bridge).toContain("pingOwnerApprovalWithButtons(text, approvalId)");
  });

  it("Phase 3: inline buttons on the approval ping + callback routing", () => {
    const bridge = read("./projectBridge.ts");
    // Buttons carry approve:/deny: callback data referencing the approval id.
    expect(bridge).toContain('["Approve", `approve:${approvalId}`]');
    expect(bridge).toContain('["Deny", `deny:${approvalId}`]');
    // Button-send failure falls back to plain text (approval still visible).
    expect(bridge).toContain("// Button send failed");
    const index = read("../assistant/index.ts");
    // The callback_query event routes through the SAME decision path as
    // /approve - audited, latched, bound-only.
    expect(index).toContain('if (e.kind === "callback_query")');
    expect(index).toContain("/^(approve|deny):(.+)$/");
    expect(index).toContain("respondTelegramApproval(m[2]!");
    expect(index).toContain("answerCallback(token, e.queryId");
    const prefs = read("./prefs.ts");
    expect(prefs).toContain('kind: "callback_query"');
    expect(prefs).toContain("sendMessageWithButtons:");
    expect(prefs).toContain("answerCallback:");
  });

  it("Phase 3 Rust: callback_query is owner-gated in classify()", () => {
    const rust = read("../../../src-tauri/src/modules/telegram.rs");
    expect(rust).toContain("callback_query: Option<TgCallbackQuery>");
    expect(rust).toContain("Some(id) if owner != -1 && id == owner => id,");
    expect(rust).toContain('"allowed_updates": ["message", "callback_query"]');
    expect(rust).toContain("telegram_send_message_with_buttons");
    expect(rust).toContain("telegram_answer_callback");
  });

  it("carve-out set: look_at_screen + bash_run are desktop-only", () => {
    const src = read("./telegramApprovals.ts");
    expect(src).toContain('"look_at_screen"');
    expect(src).toContain('"bash_run"');
    // Every decision is audited.
    expect(src).toContain('"telegram-approve"');
    expect(src).toContain('"telegram-deny"');
  });
});
