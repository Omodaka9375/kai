/**
 * Regression tests for the poison-tool-part class: a tool part with an empty
 * tool name ("tool-") and empty toolCallId (the SDK emits this error part
 * when a tool call fails to parse/resolve). Before the fix, the part survived
 * every sanitize pass, converted to tool_call_id: "" and the provider
 * rejected the whole request — permanently, because the poison part lived in
 * the PERSISTED history and every retry re-sent it.
 *
 * The functions under test are module-private; we exercise them through the
 * public runAgentStream boundary would need a full model mock, so instead we
 * import the private path via the module's own exports using a targeted
 * re-export shim... they are NOT exported. So this test drives the
 * equivalent conversion the way production does: convertToModelMessages +
 * the same sanitize semantics, duplicated only as far as needed to lock the
 * contract. See agent.ts sanitizeModelMessages for the implementation.
 */
import { describe, expect, it } from "vitest";
import { convertToModelMessages } from "ai";
import type { UIMessage } from "ai";

/**
 * Mirror of agent.ts stripIncompleteToolCalls — the production one is
 * module-private; this copy exists so the CONTRACT is test-locked. If
 * agent.ts changes, update this mirror.
 */
function stripIncompleteToolCalls(messages: UIMessage[]): UIMessage[] {
  if (messages.length === 0) return messages;
  const COMPLETE_STATES = new Set([
    "output-available",
    "output-error",
    "approval-responded",
  ]);
  const hasMalformedToolPart = (m: UIMessage): boolean => {
    for (const p of m.parts as Array<{ type?: string; toolCallId?: unknown }>) {
      const ptype = p.type ?? "";
      if (!ptype.startsWith("tool-")) continue;
      const toolName = ptype.slice("tool-".length);
      const callId = p.toolCallId;
      if (toolName === "" || typeof callId !== "string" || callId === "") {
        return true;
      }
    }
    return false;
  };
  return messages.filter((m) => {
    if (m.role !== "assistant") return true;
    if (hasMalformedToolPart(m)) return false;
    for (const p of m.parts as Array<{ type?: string; state?: string }>) {
      const ptype = p.type ?? "";
      if (!ptype.startsWith("tool-") && ptype !== "dynamic-tool") continue;
      const state = p.state;
      if (state == null || !COMPLETE_STATES.has(state)) return false;
    }
    return true;
  });
}

type AnyPart = { type: string; input?: unknown; toolCallId?: unknown; [k: string]: unknown };
const validId = (v: unknown): v is string =>
  typeof v === "string" && v.trim() !== "";

/** Mirror of agent.ts sanitizeModelMessages (three defenses). */
function sanitizeModelMessages(messages: Array<{ content?: unknown }>) {
  const fixed = messages.map((m) => {
    if (!Array.isArray(m.content)) return m;
    let touched = false;
    const content = (m.content as AnyPart[])
      .map((part) => {
        if (part.type === "tool-call" && (part.input == null || typeof part.input !== "object")) {
          touched = true;
          return { ...part, input: {} };
        }
        return part;
      })
      .filter((part) => {
        if (part.type === "tool-call" && !validId(part.toolCallId)) {
          touched = true;
          return false;
        }
        return true;
      });
    return touched ? { ...m, content } : m;
  });
  const keptCallIds = new Set<string>();
  for (const m of fixed) {
    if (!Array.isArray(m.content)) continue;
    for (const part of m.content as AnyPart[]) {
      if (part.type === "tool-call" && validId(part.toolCallId)) {
        keptCallIds.add(part.toolCallId);
      }
    }
  }
  return fixed.map((m) => {
    if (!Array.isArray(m.content)) return m;
    let touched = false;
    const content = (m.content as AnyPart[]).filter((part) => {
      if (
        part.type === "tool-result" &&
        (!validId(part.toolCallId) || !keptCallIds.has(part.toolCallId))
      ) {
        touched = true;
        return false;
      }
      return true;
    });
    return touched ? { ...m, content } : m;
  });
}

describe("poison tool part recovery (non-empty tool_call_id invariant)", () => {
  it("drops the assistant message carrying an empty-name/empty-id error part before conversion", () => {
    const history: UIMessage[] = [
      { id: "u1", role: "user", parts: [{ type: "text", text: "run the thing" }] },
      {
        id: "a1",
        role: "assistant",
        parts: [
          { type: "text", text: "I will run it." },
          // The exact poison shape from the live store (s-mv38pyum-v2x):
          {
            type: "tool-", // empty tool name
            state: "output-error",
            toolCallId: "", // empty id
            errorText: "tool call failed",
          } as unknown as UIMessage["parts"][number],
        ],
      } as UIMessage,
      { id: "u2", role: "user", parts: [{ type: "text", text: "and now?" }] },
    ];
    const stripped = stripIncompleteToolCalls(history);
    expect(stripped).toHaveLength(2); // poison assistant message dropped
    expect(stripped[1]?.role).toBe("user");
  });

  it("the poison history converts to model messages with NO empty tool_call_id anywhere", async () => {
    const history: UIMessage[] = [
      { id: "u1", role: "user", parts: [{ type: "text", text: "go" }] },
      {
        id: "a1",
        role: "assistant",
        parts: [
          { type: "text", text: "calling" },
          {
            type: "tool-",
            state: "output-error",
            toolCallId: "",
          } as unknown as UIMessage["parts"][number],
        ],
      } as UIMessage,
    ];
    const converted = Array.from(
      await convertToModelMessages(
        stripIncompleteToolCalls(history) as UIMessage[],
        { ignoreIncompleteToolCalls: true },
      ),
    ); // AI SDK v6: async, returns a Proxy-wrapped array
    const sanitized = sanitizeModelMessages(converted);
    // Assert the provider invariant directly: no tool part may carry an
    // empty id, and no tool-result may exist without a matching call.
    const callIds = new Set<string>();
    for (const m of sanitized as Array<{ content?: unknown }>) {
      if (!Array.isArray(m.content)) continue;
      for (const part of m.content as AnyPart[]) {
        if (part.type === "tool-call") {
          expect(typeof part.toolCallId).toBe("string");
          expect((part.toolCallId as string).length).toBeGreaterThan(0);
          callIds.add(part.toolCallId as string);
        }
        if (part.type === "tool-result") {
          expect(callIds.has(part.toolCallId as string)).toBe(true);
        }
      }
    }
  });

  it("healthy tool calls survive the sanitize untouched", async () => {
    const history: UIMessage[] = [
      { id: "u1", role: "user", parts: [{ type: "text", text: "read it" }] },
      {
        id: "a1",
        role: "assistant",
        parts: [
          { type: "text", text: "reading" },
          {
            type: "tool-read_file",
            toolCallId: "read_file:0",
            state: "output-available",
            input: { path: "/x" },
            output: { content: "hi" },
          } as unknown as UIMessage["parts"][number],
        ],
      } as UIMessage,
    ];
    const stripped = stripIncompleteToolCalls(history);
    expect(stripped).toHaveLength(2); // both messages kept
    const converted = Array.from(
      await convertToModelMessages(stripped, {
        ignoreIncompleteToolCalls: true,
      }),
    ); // AI SDK v6: async, returns a Proxy-wrapped array
    const sanitized = sanitizeModelMessages(converted);
    let calls = 0;
    let results = 0;
    for (const m of sanitized as Array<{ content?: unknown }>) {
      if (!Array.isArray(m.content)) continue;
      for (const part of m.content as AnyPart[]) {
        if (part.type === "tool-call") calls++;
        if (part.type === "tool-result") results++;
      }
    }
    expect(calls).toBe(1);
    expect(results).toBe(1);
  });
});
