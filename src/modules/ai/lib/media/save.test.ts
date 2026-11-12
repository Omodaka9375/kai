import { afterEach, describe, expect, it, vi } from "vitest";
import { mimeFromDataUri, saveMediaViaDialog } from "./save";

// The invoke mock: the module under test imports invoke from
// @tauri-apps/api/core directly, so we must resolve the SAME module the
// helper sees (vi.mock factory would be cleaner, but hoisting plus the
// ESM-only @tauri-apps/api makes the spy-on-namespace form the reliable one).
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

import { invoke } from "@tauri-apps/api/core";

const invokeMock = vi.mocked(invoke);

afterEach(() => {
  invokeMock.mockReset();
});

describe("mimeFromDataUri", () => {
  it("extracts the mime from a base64 data URI", () => {
    expect(mimeFromDataUri("data:image/png;base64,AAAA")).toBe("image/png");
    expect(mimeFromDataUri("data:video/mp4;base64,AAAA")).toBe("video/mp4");
  });

  it("returns undefined for blob and http URLs", () => {
    expect(mimeFromDataUri("blob:https://example.test/123")).toBeUndefined();
    expect(mimeFromDataUri("https://example.test/x.mp4")).toBeUndefined();
  });
});

describe("saveMediaViaDialog", () => {
  it("returns null when the user cancels the dialog", async () => {
    invokeMock.mockResolvedValueOnce(null);
    const out = await saveMediaViaDialog({
      src: "data:image/png;base64,AAAA",
      prompt: "a cat",
      kind: "image",
    });
    expect(out).toBeNull();
    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock.mock.calls[0]![0]).toBe("save_file_dialog");
  });

  it("writes decoded bytes of a data URI to the chosen path", async () => {
    invokeMock.mockResolvedValueOnce("C:/Users/x/Downloads/cat.png");
    // "AAAA" base64-decodes to three zero bytes.
    invokeMock.mockResolvedValueOnce(undefined);
    const out = await saveMediaViaDialog({
      src: "data:image/png;base64,AAAA",
      prompt: "a cat",
      kind: "image",
    });
    expect(out).toBe("C:/Users/x/Downloads/cat.png");
    const write = invokeMock.mock.calls[1]!;
    expect(write[0]).toBe("fs_write_file_bytes");
    expect(write[1]).toMatchObject({ path: "C:/Users/x/Downloads/cat.png" });
    expect((write[1] as { bytes: number[] }).bytes).toEqual([0, 0, 0]);
  });

  it("passes the png extension filter for a png data URI", async () => {
    invokeMock.mockResolvedValueOnce(null);
    await saveMediaViaDialog({
      src: "data:image/png;base64,AAAA",
      prompt: "a cat",
      kind: "image",
    });
    const dialog = invokeMock.mock.calls[0]!;
    expect((dialog[1] as { filters: unknown }).filters).toEqual([
      { name: "PNG file", extensions: ["png"] },
    ]);
  });

  it("refuses a non-base64 data URI BEFORE opening any dialog", async () => {
    invokeMock.mockResolvedValueOnce("C:/Users/x/Downloads/cat.png");
    await expect(
      saveMediaViaDialog({
        src: "data:text/plain,hello",
        prompt: "a cat",
        kind: "image",
      }),
    ).rejects.toThrow();
    // The validation is deliberate pre-dialog: a broken source must never
    // flash an OS save dialog at the user only to fail after.
    expect(invokeMock).toHaveBeenCalledTimes(0);
  });
});
