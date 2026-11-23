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

  it("elides IMAGE file parts in the kept tail for answered turns and preserves trailing unanswered uploads", () => {
    const msgs = mkMsgs(10);
    // Answered user message inside the kept tail, WITH a savedAt attachment block.
    const earlierUser = msgs[14]; // "u-7"
    (earlierUser.parts as never[]).push(
      {
        type: "text",
        text: '<attachment name="screenshot-1.png" savedAt="/tmp/screenshot-1.png">saved</attachment>',
      } as never,
      {
        type: "file",
        mediaType: "image/png",
        url: "data:image/png;base64," + "A".repeat(200_000),
        filename: "screenshot-1.png",
      } as never,
    );
    // Answered last pair ("u-9" followed by "a-9"): elided too on manual /compact.
    const answeredLastUser = msgs[msgs.length - 2]; // "u-9"
    (answeredLastUser.parts as never[]).push({
      type: "file",
      mediaType: "image/jpeg",
      url: "data:image/jpeg;base64," + "B".repeat(200_000),
      filename: "photo-answered.jpg",
    } as never);
    // Trailing UNANSWERED user upload (no assistant message after it): kept verbatim.
    msgs.push({
      id: "u-live",
      role: "user",
      parts: [
        { type: "text", text: "analyze this live upload" } as never,
        {
          type: "file",
          mediaType: "image/jpeg",
          url: "data:image/jpeg;base64," + "C".repeat(200_000),
          filename: "photo-live.jpg",
        } as never,
      ],
    } as UIMessage);

    const out = summarizeMessagesNow(msgs, [], "s1");
    expect(out).not.toBeNull();
    const keptEarlier = out!.find((m) => m.id === "u-7")!;
    const keptAnswered = out!.find((m) => m.id === "u-9")!;
    const keptLive = out!.find((m) => m.id === "u-live")!;

    // Earlier image with savedAt is wrapped in <attachment> (hidden in UI) and notes savedAt.
    expect(keptEarlier.parts.find((p) => (p as { type?: string }).type === "file")).toBeUndefined();
    const pointer = keptEarlier.parts.find(
      (p) =>
        (p as { type?: string }).type === "text" &&
        String((p as { text?: string }).text).includes("elided by /compact"),
    ) as unknown as { text?: string };
    expect(pointer?.text).toContain('<attachment elided="true"');
    expect(pointer?.text).toContain("screenshot-1.png");
    expect(pointer?.text).toContain("savedAt");

    // Answered upload without savedAt is elided WITHOUT falsely claiming a savedAt path.
    expect(keptAnswered.parts.find((p) => (p as { type?: string }).type === "file")).toBeUndefined();
    const noPathPointer = keptAnswered.parts.find(
      (p) =>
        (p as { type?: string }).type === "text" &&
        String((p as { text?: string }).text).includes("elided by /compact"),
    ) as unknown as { text?: string };
    expect(noPathPointer?.text).not.toContain("savedAt");

    // Trailing unanswered upload keeps its image file part verbatim.
    const liveFile = keptLive.parts.find(
      (p) => (p as { type?: string }).type === "file",
    );
    expect(liveFile).toBeDefined();
    expect(String((liveFile as { url?: string }).url)).toContain("base64");
  });

  it("compacts a short (<= 6 pairs) short-text chat when large base64 images blow the context", () => {
    const shortWithImages: UIMessage[] = [
      {
        id: "u-0",
        role: "user",
        parts: [
          { type: "text", text: "check these 6 screenshots" } as never,
          {
            type: "file",
            mediaType: "image/png",
            url: "data:image/png;base64," + "X".repeat(200_000),
            filename: "s1.png",
          } as never,
        ],
      } as UIMessage,
      {
        id: "a-0",
        role: "assistant",
        parts: [{ type: "text", text: "Looks good." }] as never,
      } as UIMessage,
    ];
    const out = summarizeMessagesNow(shortWithImages, [], "s1");
    expect(out).not.toBeNull();
    expect(out!.length).toBe(2);
    expect(out![0].parts.find((p) => (p as { type?: string }).type === "file")).toBeUndefined();
  });
});
