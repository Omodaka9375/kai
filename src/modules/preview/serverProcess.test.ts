import { describe, expect, it } from "vitest";
import { findPreviewServerHandle, textMentionsPort } from "./serverProcess";

const processes = [
  { handle: 4, command: "pnpm dev", exited: false },
  { handle: 8, command: "cargo test", exited: false },
  { handle: 12, command: "pnpm dev --port 3000", exited: true },
];

describe("preview server discovery", () => {
  it("finds a running process with an explicit port argument", async () => {
    await expect(findPreviewServerHandle(
      [{ handle: 2, command: "pnpm dev -- --port 5174", exited: false }],
      "5174",
      async () => "",
    )).resolves.toBe(2);
  });

  it("finds an agent-started server by the URL in its logs", async () => {
    await expect(findPreviewServerHandle(processes, "5173", async (handle) => {
      if (handle === 4) return "VITE v7.0.0 ready\n  ➜ Local: http://localhost:5173/";
      return "running";
    })).resolves.toBe(4);
  });

  it("ignores exited processes even when their command has the port", async () => {
    await expect(findPreviewServerHandle(processes, "3000", async () => ""))
      .resolves.toBeNull();
  });

  it("does not guess when multiple processes advertise the same port", async () => {
    await expect(findPreviewServerHandle(
      [
        { handle: 2, command: "pnpm dev", exited: false },
        { handle: 3, command: "npm run dev", exited: false },
      ],
      "5173",
      async () => "Local: http://127.0.0.1:5173/",
    )).resolves.toBeNull();
  });

  it("recognizes common server output without a command-line port", () => {
    expect(textMentionsPort("Local: http://localhost:5173/", "5173")).toBe(true);
    expect(textMentionsPort("ready on http://0.0.0.0:3000", "3000")).toBe(true);
    expect(textMentionsPort("unrelated output", "5173")).toBe(false);
  });
});
