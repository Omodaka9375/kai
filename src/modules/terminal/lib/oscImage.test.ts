import { describe, expect, it } from "vitest";
import { parseOsc1337, sniffImageMime } from "./oscImage";

describe("parseOsc1337", () => {
  it("parses the iTerm2 File payload", () => {
    const r = parseOsc1337(
      "File=name=aGVsbG8ucG5n;size=15;inline=1:AAECAwQFBgcICQ==",
    );
    expect(r).not.toBeNull();
    expect(r?.name).toBe("aGVsbG8ucG5n");
    expect(r?.base64Data).toBe("AAECAwQFBgcICQ==");
  });

  it("returns null for other OSC 1337 payloads", () => {
    expect(parseOsc1337("SetUserVar=x=1")).toBeNull();
    expect(parseOsc1337("RequestUpload=targz")).toBeNull();
    expect(parseOsc1337("")).toBeNull();
  });

  it("tolerates empty name with valid data", () => {
    const r = parseOsc1337("File=name=;size=4;inline=1:AAAA");
    expect(r?.base64Data).toBe("AAAA");
  });
});

describe("sniffImageMime", () => {
  it("detects JPEG from magic bytes", () => {
    expect(sniffImageMime(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe(
      "image/jpeg",
    );
  });

  it("detects GIF from magic bytes", () => {
    expect(sniffImageMime(new Uint8Array([0x47, 0x49, 0x46, 0x38]))).toBe(
      "image/gif",
    );
  });

  it("detects WebP from RIFF box header", () => {
    expect(
      sniffImageMime(
        new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]),
      ),
    ).toBe("image/webp");
  });

  it("defaults to PNG", () => {
    expect(
      sniffImageMime(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a])),
    ).toBe("image/png");
  });
});
