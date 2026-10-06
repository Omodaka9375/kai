import { describe, expect, it } from "vitest";
import type { UIMessage } from "@ai-sdk/react";
import { summarizeMessagesNow } from "./transport";

/** Build a minimal user/assistant pair with realistic text mass. */
function mkMsgs(pairs: number): UIMessage[] {
  const out: UIMessage[] = [];
  for (let i = 0; i < pairs; i++) {
    out.push({
      id: `u-${i}`,
      role: "user",
      parts: [
        {
          type: "text",
          // ~400 chars per message so 10 pairs clear the 2k-token floor.
          text: `Task request ${i}: `.padEnd(400, `x${i} `),
        } as never,
      ],
    } as UIMessage);
    out.push({
      id: `a-${i}`,
      role: "assistant",
      parts: [{ type: "text", text: `Done ${i}. `.padEnd(400, "y ") }] as never,
    } as UIMessage);
  }
  return out;
}

describe("summarizeMessagesNow", () => {
  it("returns null when the tail already covers everything (≤ 6 pairs)", () => {
    expect(summarizeMessagesNow(mkMsgs(3), [], "s1")).toBeNull();
  });

  it("returns null for a trivially small history (under the token floor)", () => {
    const tiny: UIMessage[] = [
      {
        id: "u",
        role: "user",
        parts: [{ type: "text", text: "hi" }] as never,
      } as UIMessage,
      {
        id: "a",
        role: "assistant",
        parts: [{ type: "text", text: "hello" }] as never,
      } as UIMessage,
    ];
    expect(summarizeMessagesNow(tiny, [], "s1")).toBeNull();
  });

  it("compacts a long history: snapshot first, tail pairs kept", () => {
    const msgs = mkMsgs(20);
    const out = summarizeMessagesNow(msgs, [], "s1");
    expect(out).not.toBeNull();
    const result = out!;
    // First message is the <session_state> snapshot (assistant role).
    expect(result[0].role).toBe("assistant");
    const text = (result[0].parts[0] as { text?: string }).text ?? "";
    expect(text).toContain("<session_state>");
    expect(text).toContain("Task request 0"); // extracted from the first user msg
    // Tail keeps the LAST 6 pairs; the oldest of the kept tail is pair 14.
    const ids = result.map((m) => m.id);
    expect(ids).toContain("u-14");
    expect(ids).not.toContain("u-13");
    expect(ids).toContain("u-19");
    // Massive reduction: 41 -> 13 messages.
    expect(result.length).toBe(13);
  });

  it("includes the file snapshot in the state block", () => {
    const msgs = mkMsgs(10);
    const snapshot = [
      { path: "src/a.ts", state: "modified", at: 1 },
      { path: "src/b.ts", state: "read", at: 2 },
    ] as never;
    const out = summarizeMessagesNow(msgs, snapshot, "s1");
    const text = (out![0].parts[0] as { text?: string }).text ?? "";
    expect(text).toContain("src/a.ts");
    expect(text).toContain("edited");
    expect(text).toContain("src/b.ts");
    expect(text).toContain("read");
  });
});
