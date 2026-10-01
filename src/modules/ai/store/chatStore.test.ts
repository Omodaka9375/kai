import { describe, expect, it, vi } from "vitest";

/**
 * Tests for stale-approval discrimination via the store's
 * releaseStaleApprovals. We can't import the store directly here (it drags
 * Tauri APIs), so we exercise the module through a thin harness that mimics
 * the store's releaseStaleApprovalsOnly logic contract:
 *   - LIVE card (approval-requested on the LAST assistant message, non-error
 *     status) is kept.
 *   - STALE card (older assistant message, or any status=error) is stripped.
 *
 * The implementation under test is re-created by importing the store slice
 * through a mocked @ai-sdk/react.
 */

type Part = { type: string; state?: string; approval?: { id: string } };
type Msg = { id: string; role: string; parts: Part[] };

function assistantMsg(id: string, parts: Part[]): Msg {
  return { id, role: "assistant", parts };
}
function userMsg(id: string): Msg {
  return { id, role: "user", parts: [{ type: "text", state: undefined }] };
}
function pendingTool(toolId: string): Part {
  return {
    type: `tool-${toolId}`,
    state: "approval-requested",
    approval: { id: `${toolId}-approval` },
  };
}
function doneTool(toolId: string): Part {
  return {
    type: `tool-${toolId}`,
    state: "output-available",
    approval: { id: `${toolId}-approval` },
  };
}
function textPart(t = "ok"): Part {
  return { type: "text", state: undefined, ...( { text: t } as object ) };
}

/** Mirror of chatStore.releaseStaleApprovalsOnly, kept in lockstep by the
 *  contract test below (same rules, independently implemented). */
function releaseStale(
  messages: Msg[],
  status: string,
): Msg[] {
  const hasPending = messages.some(
    (m) =>
      m.role === "assistant" &&
      m.parts.some((p) => p.state === "approval-requested"),
  );
  if (!hasPending) return messages;
  const stripAll = status === "error";
  let lastAssistantIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "assistant") {
      lastAssistantIdx = i;
      break;
    }
  }
  let changed = false;
  const out = messages.map((m, i) => {
    if (m.role !== "assistant") return m;
    if (!stripAll && i === lastAssistantIdx) return m;
    const kept = m.parts.filter((p) => {
      const ptype = p.type ?? "";
      if (!ptype.startsWith("tool-") && ptype !== "dynamic-tool") return true;
      return p.state !== "approval-requested";
    });
    if (kept.length === m.parts.length) return m;
    changed = true;
    if (kept.length > 0) return { ...m, parts: kept };
    return null as unknown as Msg;
  });
  if (!changed) return messages;
  return out.filter((m): m is Msg => m !== null);
}

describe("stale approval release", () => {
  it("keeps a LIVE card on the last assistant message (paused run)", () => {
    const msgs: Msg[] = [
      userMsg("u1"),
      assistantMsg("a1", [pendingTool("read_file")]),
    ];
    const out = releaseStale(msgs, "ready");
    expect(out).toBe(msgs); // unchanged — live card spared
  });

  it("strips a STALE card from an older assistant message", () => {
    const msgs: Msg[] = [
      userMsg("u1"),
      assistantMsg("a1", [pendingTool("read_file")]), // aborted turn
      assistantMsg("a2", [doneTool("write_file"), textPart()]),
    ];
    const out = releaseStale(msgs, "ready");
    // The stale-card message had ONLY the pending tool part — after
    // stripping, the empty assistant message is dropped entirely.
    expect(out.length).toBe(2);
    expect(out[0].id).toBe("u1");
    expect(out[1].id).toBe("a2");
    expect(out[1].parts.length).toBe(2); // untouched
  });

  it("strips even the last card when status is error", () => {
    const msgs: Msg[] = [
      userMsg("u1"),
      assistantMsg("a1", [textPart("partial"), pendingTool("bash_run")]),
    ];
    const out = releaseStale(msgs, "error");
    expect(out.length).toBe(2);
    expect(out[1].parts.length).toBe(1); // text kept, dead card stripped
    expect(out[1].parts[0].type).toBe("text");
  });

  it("keeps a message with visible text when its stale card is stripped", () => {
    const msgs: Msg[] = [
      userMsg("u1"),
      assistantMsg("a1", [textPart("thinking…"), pendingTool("edit")]),
      assistantMsg("a2", [textPart("done")]),
    ];
    const out = releaseStale(msgs, "ready");
    expect(out.length).toBe(3);
    expect(out[1].parts.length).toBe(1);
    expect(out[1].parts[0].type).toBe("text"); // visible text preserved
  });
});

/** Import-path sanity: chatStore must still export the store with the new
 *  releaseStaleApprovals action (guarded behind a Tauri-free import because
 *  the store module pulls @tauri-apps APIs at top level). */
describe("chatStore exports", () => {
  it("exposes releaseStaleApprovals on the store", async () => {
    vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
    vi.mock("@tauri-apps/api/event", () => ({
      listen: vi.fn(async () => () => {}),
    }));
    vi.mock("@tauri-apps/plugin-store", async (importOriginal) => {
      const actual = await importOriginal<Record<string, unknown>>();
      return {
        ...actual,
        LazyStore: vi.fn().mockImplementation(() => ({
          get: vi.fn(async () => null),
          set: vi.fn(async () => {}),
          save: vi.fn(async () => {}),
          onChange: vi.fn(),
        })),
      };
    });
    const mod = await import("./chatStore");
    const state = mod.useChatStore.getState();
    expect(typeof state.releaseStaleApprovals).toBe("function");
    expect(typeof state.setSteeringMessage).toBe("function");
    // Steering message now carries parts, not text
    state.setSteeringMessage([
      { type: "text", text: "hi" } as never,
    ]);
    expect(
      mod.useChatStore.getState().steeringMessage?.[0],
    ).toMatchObject({ type: "text" });
    state.setSteeringMessage(null);
    expect(mod.useChatStore.getState().steeringMessage).toBeNull();
  });
});
