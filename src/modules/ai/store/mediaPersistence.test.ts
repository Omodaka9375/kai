import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { UIMessage } from "ai";

// Only the chat runtime's dependencies need stubs for this focused test.
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("@tauri-apps/api/path", () => ({ homeDir: async () => "C:/Users/test" }));
vi.mock("@tauri-apps/plugin-store", () => ({
  LazyStore: class {
    async get() { return null; }
    async set() {}
    async delete() {}
    async save() {}
    onChange() {}
  },
}));
vi.mock("../lib/agent", () => ({
  createContextAwareTransport: vi.fn(),
  resolveErrorDisplay: (e: unknown) => String(e),
}));
vi.mock("@/modules/settings/preferences", () => ({
  usePreferencesStore: { getState: () => ({}) },
}));
vi.mock("../lib/keyring", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/keyring")>()),
  onKeysChanged: () => async () => {},
}));
vi.mock("@/modules/workspace", () => ({
  useWorkspaceEnvStore: { getState: () => ({}) },
}));

let store: typeof import("./chatStore");
beforeAll(async () => { store = await import("./chatStore"); });
afterEach(() => store.__mediaPersistenceForTest.clear("media-race"));

function toolPart(id: string, output: unknown): UIMessage["parts"][number] {
  return {
    type: "tool-generate_image",
    toolCallId: id,
    state: "output-available",
    input: {},
    output,
  } as UIMessage["parts"][number];
}
function transcript(parts: UIMessage["parts"], text?: string): UIMessage[] {
  return [
    {
      id: "run",
      role: "assistant",
      parts: [...parts, ...(text ? [{ type: "text", text } as UIMessage["parts"][number]] : [])],
    } as UIMessage,
  ];
}

describe("media completion vs a long streaming response", () => {
  it("two media results survive an older transcript snapshot saved after them", () => {
    const pending1 = toolPart("image-1", { status: "generating" });
    const pending2 = toolPart("image-2", { status: "generating" });
    const staleBeforeResolve = transcript([pending1, pending2], "The agent is still writing.");
    const afterFirst = transcript([toolPart("image-1", { type: "image", base64: "one" }), pending2]);
    const afterSecond = transcript([afterFirst[0]!.parts[0]!, toolPart("image-2", { type: "image", base64: "two" })]);
    const merge = store.__mediaPersistenceForTest.merge;
    store.__mediaPersistenceForTest.register("media-race", "image-1", { type: "image", base64: "one" }, afterFirst);
    store.__mediaPersistenceForTest.register("media-race", "image-2", { type: "image", base64: "two" }, afterSecond);

    // This is the ordering the old resolveMedia-only implementation lacked:
    // two out-of-band completions, then a bridge's stale persist snapshot.
    const live = merge("media-race", afterSecond).messages;
    expect(live[0]!.parts).toEqual(afterSecond[0]!.parts);

    const persisted = merge("media-race", staleBeforeResolve).messages;
    const outputs = persisted[0]!.parts.filter((p) => p.type === "tool-generate_image")
      .map((p) => (p as { output: unknown }).output);
    expect(outputs).toEqual([
      { type: "image", base64: "one" },
      { type: "image", base64: "two" },
    ]);
    expect(persisted[0]!.parts[persisted[0]!.parts.length - 1]).toEqual({ type: "text", text: "The agent is still writing." });
  });
});
