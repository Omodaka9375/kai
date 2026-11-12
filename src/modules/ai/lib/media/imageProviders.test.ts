import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
const { invoke } = await import("@tauri-apps/api/core");
const mockedInvoke = vi.mocked(invoke);

const { generateOpenAIImage } = await import("./openai-image");
const { generateXAIImage } = await import("./xai-image");

function ok(body: unknown) {
  return {
    status: 200,
    headers: {},
    body: Array.from(new TextEncoder().encode(JSON.stringify(body))),
  };
}
function fail(status: number, body: unknown) {
  return {
    status,
    headers: {},
    body: Array.from(new TextEncoder().encode(JSON.stringify(body))),
  };
}

/** The JSON body the provider actually sent. */
function sentBody(): Record<string, unknown> {
  const calls = mockedInvoke.mock.calls;
  const call = calls[calls.length - 1]!;
  const args = call[1] as { body: number[] };
  return JSON.parse(new TextDecoder().decode(new Uint8Array(args.body)));
}

describe("OpenAI image request", () => {
  beforeEach(() => mockedInvoke.mockReset());

  it("never sends response_format (GPT image models 400 on it)", async () => {
    // Live failure: `response_format` is deprecated and "Unsupported for GPT
    // image models", so every request was rejected with an API error.
    mockedInvoke.mockResolvedValue(ok({ data: [{ b64_json: "AAA" }] }));
    await generateOpenAIImage("key", { prompt: "x" });
    const body = sentBody();
    expect(body).not.toHaveProperty("response_format");
    expect(body).not.toHaveProperty("style");
  });

  it("sends the current model and validates size/quality", async () => {
    mockedInvoke.mockResolvedValue(ok({ data: [{ b64_json: "AAA" }] }));
    await generateOpenAIImage("key", {
      prompt: "x",
      size: "not-a-size",
      quality: "ultra",
    });
    const body = sentBody();
    expect(body.model).toBe("gpt-image-2.6-flare");
    // Invalid inputs are normalized, never forwarded (an unknown enum 400s).
    expect(body).not.toHaveProperty("size");
    expect(body.quality).toBe("auto");
    expect(body.n).toBe(1);
  });

  it("accepts a b64_json payload and reports the format it produced", async () => {
    mockedInvoke.mockResolvedValue(
      ok({ data: [{ b64_json: "AAA" }], output_format: "jpeg", size: "1536x1024" }),
    );
    const r = await generateOpenAIImage("key", { prompt: "x" });
    expect(r.base64).toBe("AAA");
    expect(r.mimeType).toBe("image/jpeg");
    expect(r.width).toBe(1536);
    expect(r.height).toBe(1024);
  });

  it("edits a reference image through the JSON images API", async () => {
    mockedInvoke.mockResolvedValue(ok({ data: [{ b64_json: "AAA" }] }));
    await generateOpenAIImage("key", { prompt: "restyle", referenceImage: "aW1hZ2U=" });
    expect(mockedInvoke.mock.calls[0]![1]).toMatchObject({
      url: "https://api.openai.com/v1/images/edits",
    });
    expect(sentBody().images).toEqual([{ image_url: "data:image/png;base64,aW1hZ2U=" }]);
  });

  it("surfaces the provider's error message, not just the status", async () => {
    mockedInvoke.mockResolvedValue(
      fail(400, {
        error: { message: "Unknown parameter: 'response_format'", code: "invalid" },
      }),
    );
    await expect(generateOpenAIImage("key", { prompt: "x" })).rejects.toThrow(
      /Unknown parameter.*invalid/,
    );
  });

  it("rejects an empty data array instead of returning a blank card", async () => {
    mockedInvoke.mockResolvedValue(ok({ data: [] }));
    await expect(generateOpenAIImage("key", { prompt: "x" })).rejects.toThrow(
      /no image data/,
    );
  });
});

describe("xAI image request", () => {
  beforeEach(() => mockedInvoke.mockReset());

  it("uses the current Grok Imagine model id", async () => {
    mockedInvoke.mockResolvedValue(ok({ data: [{ url: "https://x/1.jpg" }] }));
    await generateXAIImage("key", { prompt: "x" });
    expect(sentBody().model).toBe("grok-imagine-image-2.0");
  });

  it("maps a pixel size onto the documented aspect_ratio enum", async () => {
    mockedInvoke.mockResolvedValue(ok({ data: [{ url: "https://x/1.jpg" }] }));
    await generateXAIImage("key", { prompt: "x", size: "1792x1024" });
    const body = sentBody();
    expect(body.aspect_ratio).toBe("16:9");
    // xAI sizes by 1k/2k, so a pixel pair must NOT be forwarded as size.
    expect(body).not.toHaveProperty("size");
  });

  it("maps the common high quality to xAI's supported medium tier", async () => {
    mockedInvoke.mockResolvedValue(ok({ data: [{ url: "https://x/1.jpg" }] }));
    await generateXAIImage("key", { prompt: "x", quality: "high" });
    expect(sentBody().quality).toBe("medium");
  });

  it("requests base64 so temporary URLs cannot break later editing", async () => {
    mockedInvoke.mockResolvedValue(ok({ data: [{ b64_json: "AAA" }] }));
    await generateXAIImage("key", { prompt: "x" });
    expect(sentBody().response_format).toBe("b64_json");
  });

  it("edits a reference image through xAI's native JSON endpoint", async () => {
    mockedInvoke.mockResolvedValue(ok({ data: [{ b64_json: "AAA" }] }));
    await generateXAIImage("key", { prompt: "restyle", referenceImage: "aW1hZ2U=" });
    expect(mockedInvoke.mock.calls[0]![1]).toMatchObject({ url: "https://api.x.ai/v1/images/edits" });
    expect(sentBody().image).toEqual({
      type: "image_url",
      url: "data:image/png;base64,aW1hZ2U=",
    });
  });

  it("returns a URL-only payload (a compatible response shape)", async () => {
    mockedInvoke.mockResolvedValue(
      ok({ data: [{ url: "https://x/1.jpg", mime_type: "image/webp" }] }),
    );
    const r = await generateXAIImage("key", { prompt: "x" });
    expect(r.url).toBe("https://x/1.jpg");
    expect(r.mimeType).toBe("image/webp");
  });
});
