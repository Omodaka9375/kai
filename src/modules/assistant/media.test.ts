import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildAssistantMediaTools } from "./media";

const { invokeMock, getKeyMock, tokenMock, prefsMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  getKeyMock: vi.fn(),
  tokenMock: vi.fn(),
  prefsMock: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
vi.mock("@/modules/ai/lib/keyring", () => ({ getKey: getKeyMock }));
vi.mock("./index", () => ({
  getTelegramToken: tokenMock,
  loadAssistantPrefs: prefsMock,
}));

function jsonResponse(body: unknown) {
  return {
    status: 200,
    body: Array.from(new TextEncoder().encode(JSON.stringify(body))),
  };
}

describe("assistant media provider and delivery", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    getKeyMock.mockReset();
    tokenMock.mockReset();
    prefsMock.mockReset();
    getKeyMock.mockImplementation(async (provider: string) => provider === "xai" ? "xai-key" : null);
    tokenMock.mockResolvedValue("telegram-token");
    prefsMock.mockResolvedValue({ ownerChatId: 42 });
  });

  it("uses xAI when no Google video key exists and reports only actual delivery success", async () => {
    invokeMock
      .mockResolvedValueOnce(jsonResponse({ request_id: "video-req" }))
      .mockResolvedValueOnce(jsonResponse({
        status: "done",
        video: { url: "https://vidgen.x.ai/video.mp4", duration: 5 },
      }))
      .mockResolvedValueOnce({ status: 200, body: Array.from(new TextEncoder().encode("video")) })
      .mockResolvedValueOnce({ ok: true });

    const tools = buildAssistantMediaTools() as Record<string, {
      execute: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
    }>;
    const result = await tools.generate_video!.execute({
      prompt: "A creek",
      duration: 5,
      aspect_ratio: "16:9",
    });

    expect(invokeMock.mock.calls[0]![1]).toMatchObject({
      url: "https://api.x.ai/v1/videos/generations",
    });
    expect(result).toMatchObject({ ok: true, provider: "xai", delivered: true });
    expect(invokeMock.mock.calls[3]![0]).toBe("telegram_send_video");
  });

  it("returns the Telegram delivery failure instead of claiming delivered:true", async () => {
    invokeMock
      .mockResolvedValueOnce(jsonResponse({ request_id: "video-req" }))
      .mockResolvedValueOnce(jsonResponse({
        status: "done",
        video: { url: "https://vidgen.x.ai/video.mp4", duration: 5 },
      }))
      .mockResolvedValueOnce({ status: 200, body: Array.from(new TextEncoder().encode("video")) })
      .mockRejectedValueOnce(new Error("Telegram 429"));

    const tools = buildAssistantMediaTools() as Record<string, {
      execute: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
    }>;
    const result = await tools.generate_video!.execute({
      prompt: "A creek",
      duration: 5,
      aspect_ratio: "16:9",
    });
    expect(result).toEqual({ error: "Telegram 429" });
    expect(result).not.toHaveProperty("delivered");
  });
});
