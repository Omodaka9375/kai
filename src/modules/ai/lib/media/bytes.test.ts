import { describe, expect, it } from "vitest";
import { fingerprintBase64, imageDimensionsFromBase64 } from "./bytes";

describe("media byte helpers", () => {
  it("distinguishes different reference images for dedupe keys", () => {
    expect(fingerprintBase64("aW1hZ2UtYQ==")).not.toBe(fingerprintBase64("aW1hZ2UtYg=="));
    expect(fingerprintBase64("aW1hZ2UtYQ==")).toBe(fingerprintBase64("aW1hZ2UtYQ=="));
  });

  it("reads dimensions from PNG", () => {
    const bytes = new Uint8Array(24);
    bytes.set([0x89, 0x50, 0x4e, 0x47]);
    const view = new DataView(bytes.buffer);
    view.setUint32(16, 1920);
    view.setUint32(20, 1080);
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    expect(imageDimensionsFromBase64(btoa(binary))).toEqual({ width: 1920, height: 1080 });
  });

  it("returns unknown dimensions instead of fabricated square metadata", () => {
    expect(imageDimensionsFromBase64("aW1hZ2U=")).toEqual({ width: 0, height: 0 });
    expect(imageDimensionsFromBase64(undefined)).toEqual({ width: 0, height: 0 });
  });
});
