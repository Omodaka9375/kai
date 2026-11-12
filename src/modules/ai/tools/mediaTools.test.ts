import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildImageGenTools } from "./image-gen";
import { cancelMediaTasksForSession } from "../lib/media/task";

const { invokeMock, persistMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  persistMock: vi.fn(async (_fs: unknown, opts: { index?: number }) => `C:/media/generated-${opts.index ?? 0}.png`),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
vi.mock("../store/chatStore", () => ({
  useChatStore: {
    getState: () => ({
      apiKeys: { google: null, openai: null, xai: "xai-key" },
      resolveMedia: vi.fn(),
    }),
  },
}));
vi.mock("../lib/media/persist", () => ({ persistGeneratedMedia: persistMock }));

function response(body: unknown) {
  return {
    status: 200,
    body: Array.from(new TextEncoder().encode(JSON.stringify(body))),
  };
}

function context() {
  return {
    getCwd: () => "C:/project",
    getSessionId: () => "media-tools-test",
    native: { readFileBytes: vi.fn(async () => [0x89, 0x50, 0x4e, 0x47]) },
  } as never;
}

describe("media tool persistence and dedupe", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    persistMock.mockClear();
    cancelMediaTasksForSession("media-tools-test", "test cleanup");
  });

  it("persists an xAI result as bytes and returns a savedPath", async () => {
    invokeMock.mockResolvedValue(response({ data: [{ b64_json: "QUJD", mime_type: "image/png" }] }));
    const tools = buildImageGenTools(context());
    const pending = await tools.generate_image.execute!(
      { prompt: "one image" },
      { toolCallId: "call-one", messages: [], abortSignal: new AbortController().signal },
    );
    expect(pending).toMatchObject({ status: "generating", provider: "xai" });
    await vi.waitFor(() => expect(persistMock).toHaveBeenCalledTimes(1));
    expect(persistMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      kind: "image",
      base64: "QUJD",
    }));
    const body = JSON.parse(new TextDecoder().decode(new Uint8Array(
      (invokeMock.mock.calls[0]![1] as { body: number[] }).body,
    ))) as Record<string, unknown>;
    expect(body.response_format).toBe("b64_json");
  });

  it("does not share a completed result between different reference images", async () => {
    invokeMock.mockResolvedValue(response({ data: [{ b64_json: "QUJD", mime_type: "image/png" }] }));
    const ctx = context() as unknown as {
      native: { readFileBytes: ReturnType<typeof vi.fn> };
    };
    ctx.native.readFileBytes
      .mockResolvedValueOnce([0x89, 0x50, 0x4e, 0x47, 0x01])
      .mockResolvedValueOnce([0x89, 0x50, 0x4e, 0x47, 0x02]);
    const tools = buildImageGenTools(ctx as never);
    for (const [id, path] of [["call-a", "a.png"], ["call-b", "b.png"]] as const) {
      await tools.generate_image.execute!(
        { prompt: "restyle", imagePath: path },
        { toolCallId: id, messages: [], abortSignal: new AbortController().signal },
      );
    }
    await vi.waitFor(() => expect(persistMock).toHaveBeenCalledTimes(2));
    expect(invokeMock).toHaveBeenCalledTimes(2);
  });
});
