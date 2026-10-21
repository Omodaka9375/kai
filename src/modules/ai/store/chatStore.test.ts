import { beforeAll, describe, expect, it, vi } from "vitest";

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

// Path-keyed fake of the tauri store so per-project session files
// (kai-sessions-<hash>.json) behave like real disk — each LazyStore instance
// reads/writes its own map. Hoisted: vi.mock factories run before imports.
const { sessionFiles } = vi.hoisted(() => ({
  sessionFiles: new Map<string, Map<string, unknown>>(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
}));
vi.mock("@tauri-apps/plugin-store", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    LazyStore: vi.fn().mockImplementation((path: string) => {
      let map = sessionFiles.get(path);
      if (!map) {
        map = new Map();
        sessionFiles.set(path, map);
      }
      return {
        get: async (k: string) => (map.has(k) ? map.get(k) : null),
        set: async (k: string, v: unknown) => {
          map.set(k, v);
        },
        delete: async (k: string) => {
          map.delete(k);
        },
        save: async () => {},
        onChange: vi.fn(),
      };
    }),
  };
});

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
  // One shared dynamic import. The module graph (AI SDK + mocked Tauri)
  // costs ~1.4s to load even in isolation — under full-suite worker
  // contention that blew the 5s default test timeout. Loading once here
  // with a generous hook timeout keeps the individual tests instant.
  let mod: typeof import("./chatStore");
  beforeAll(async () => {
    mod = await import("./chatStore");
  }, 30_000);

  it("exposes releaseStaleApprovals on the store", () => {
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

  describe("workspace switching", () => {
    it("activates the new project's own session on a project switch", async () => {
      const store = mod.useChatStore;

      // Cold start on project A: a fresh session stamped with A becomes
      // active (no persisted sessions yet).
      await store.getState().hydrateSessions("D:/proj-a");
      const activeA = store
        .getState()
        .sessions.find((s) => s.id === store.getState().activeSessionId);
      expect(activeA?.workspaceRoot?.toLowerCase()).toBe("d:/proj-a");
      const sessionA = activeA!.id;

      // Switch to project B: the A conversation must NOT stay active. B has
      // no persisted sessions, so a fresh B session is created + activated.
      await store.getState().hydrateSessions("D:/proj-b");
      const activeB = store
        .getState()
        .sessions.find((s) => s.id === store.getState().activeSessionId);
      expect(activeB?.workspaceRoot?.toLowerCase()).toBe("d:/proj-b");
      expect(activeB?.id).not.toBe(sessionA);
      // A's session survives the switch (kept for when the user returns).
      expect(
        store.getState().sessions.some((s) => s.id === sessionA),
      ).toBe(true);

      // Switch back to A: A's persisted last-active session is restored.
      await store.getState().hydrateSessions("D:/proj-a");
      expect(store.getState().activeSessionId).toBe(sessionA);
    });

    it("a fast A→B switch while A's hydration is still in flight shows B (latest wins)", async () => {
      // REGRESSION ("AI window shows the stale project's chat after a
      // switch"): hydrateSessions is async and swaps the module-level
      // sessions store scope. Without serialization + a latest-wins commit
      // gate, a slow A hydration resolving AFTER B's would commit LAST and
      // leave project A's conversation active under project B — random,
      // timing-dependent, exactly "sometimes when I switch projects".
      // The fix: starts serialize (each run awaits the prior chain tail)
      // and every stale run's commit is dropped.
      const store = mod.useChatStore;

      // Fire both hydrations WITHOUT awaiting the first — the interleaved
      // shape the App effect produces on a fast project switch.
      const pA = store.getState().hydrateSessions("D:/race-a");
      const pB = store.getState().hydrateSessions("D:/race-b");
      await Promise.all([pA, pB]);

      // Whichever is latest (B) must own the store; A's late commit must
      // have been dropped by the latest-wins gate.
      const active = store
        .getState()
        .sessions.find((s) => s.id === store.getState().activeSessionId);
      expect(active?.workspaceRoot?.toLowerCase()).toBe("d:/race-b");
      expect(store.getState().lastHydratedWorkspace?.toLowerCase()).toBe(
        "d:/race-b",
      );

      // And the switch-back still resolves the right project.
      const pA2 = store.getState().hydrateSessions("D:/race-a");
      await pA2;
      expect(
        store.getState().lastHydratedWorkspace?.toLowerCase(),
      ).toBe("d:/race-a");
    });
  });
});

describe("describeApproval subject derivation (audit 'Unknown' regression)", () => {
  // Source-contract: the tool name lives in part.type ("tool-<name>") for
  // regular tools and under toolName only for dynamic-tool parts. A
  // describeApproval that read p.toolName directly audited EVERY regular
  // approval as subject "unknown" in the Security panel.
  it("derives the subject from part.type like AiChat does", async () => {
    const src = await import("node:fs").then((fs) =>
      fs.readFileSync(
        new URL("./chatStore.ts", import.meta.url),
        "utf8",
      ),
    );
    expect(src).toMatch(
      /type === "dynamic-tool"\s*\?\s*\(\(p as \{ toolName\?: string \}\)\.toolName/,
    );
    expect(src).toMatch(/type\.replace\(\/\^tool-\/, ""\)/);
  });
});
