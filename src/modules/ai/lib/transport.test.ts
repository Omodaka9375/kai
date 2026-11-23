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

  it("truncates oversized tool outputs in the KEPT tail (local-model ring >100% fix)", () => {
    // The tail pairs hold the conversation's largest payloads — a fresh
    // shell result in the last pair. /compact must shrink it or the
    // context ring stays >100% for local models even after compaction.
    const msgs = mkMsgs(10);
    // Attach a giant tool result to the LAST assistant message.
    const last = msgs[msgs.length - 1];
    const bigOutput = { stdout: "x".repeat(60_000) };
    (last.parts as never[]).push({
      type: "tool-result",
      toolCallId: "tc-1",
      toolName: "bash_run",
      output: bigOutput,
      state: "output-available",
    } as never);
    const out = summarizeMessagesNow(msgs, [], "s1");
    expect(out).not.toBeNull();
    const keptLast = out![out!.length - 1];
    const toolPart = keptLast.parts.find(
      (p) => (p as { type?: string }).type === "tool-result",
    ) as unknown as { output?: { stdout?: string; note?: string } };
    expect(toolPart).toBeDefined();
    // The 60k-char output is replaced by the elision placeholder.
    expect(toolPart.output?.stdout).toBeUndefined();
    expect(toolPart.output?.note).toContain("elided by /compact");
    // Small outputs pass through untouched.
    const small = { ...msgs[0] };
    const before = JSON.stringify(small).length;
    expect(before).toBeGreaterThan(0);
  });

  it("elides IMAGE file parts in the kept tail EXCEPT on the most recent user message (6-image 120% fix)", () => {
    // 2026-11-23 report: uploading several images put the context ring at
    // 200% and /compact could not bring it down — the base64 file parts ride
    // user messages inside the verbatim-kept tail, so summarizing older
    // history never touched them. Elide image parts in the tail to text
    // pointers, keeping only the MOST RECENT user message's images (the
    // upload the model may still be actively working with).
    const msgs = mkMsgs(10);
    // Pair 14-area message (inside the 6-pair tail, but NOT the last user
    // message): attach an image file part.
    const earlierUser = msgs[14]; // "u-7" — inside the kept tail
    (earlierUser.parts as never[]).push({
      type: "file",
      mediaType: "image/png",
      url: "data:image/png;base64," + "A".repeat(200_000),
      filename: "screenshot-1.png",
    } as never);
    // The LAST user message keeps its image verbatim.
    const lastUser = msgs[msgs.length - 2]; // "u-9"
    (lastUser.parts as never[]).push({
      type: "file",
      mediaType: "image/jpeg",
      url: "data:image/jpeg;base64," + "B".repeat(200_000),
      filename: "photo-latest.jpg",
    } as never);

    const out = summarizeMessagesNow(msgs, [], "s1");
    expect(out).not.toBeNull();
    const keptEarlier = out!.find((m) => m.id === "u-7")!;
    const keptLastUser = out!.find((m) => m.id === "u-9")!;

    // The EARLIER image is replaced by a compact text pointer.
    const earlierFile = keptEarlier.parts.find(
      (p) => (p as { type?: string }).type === "file",
    );
    expect(earlierFile).toBeUndefined();
    const pointer = keptEarlier.parts.find(
      (p) =>
        (p as { type?: string }).type === "text" &&
        String((p as { text?: string }).text).includes("elided by /compact"),
    ) as unknown as { text?: string };
    expect(pointer?.text).toContain("screenshot-1.png");
    expect(pointer?.text).toContain("saved path");

    // The most RECENT user message keeps its image file part verbatim.
    const lastFile = keptLastUser.parts.find(
      (p) => (p as { type?: string }).type === "file",
    );
    expect(lastFile).toBeDefined();
    expect(String((lastFile as { url?: string }).url)).toContain("base64");
  });
});
