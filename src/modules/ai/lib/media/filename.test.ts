import { describe, expect, it } from "vitest";
import { safeFileStem, safeMediaFilename } from "./filename";

/** Fixed clock: 2026-11-12 14:05:09 local. */
const NOW = new Date(2026, 10, 12, 14, 5, 9).getTime();

describe("safeFileStem", () => {
  it("turns a prompt sentence into a short readable stem", () => {
    // The live bug: this whole sentence landed in the save dialog's name
    // field (and broke its extension parsing).
    const stem = safeFileStem("generate an image of Jhin and Mel from LoL ina coreography");
    expect(stem).toBe("generate-an-image-of-Jhin-and-Mel-from-LoL-ina-coreography");
    expect(stem.length).toBeLessThanOrEqual(60);
    expect(stem).not.toMatch(/\s/);
  });

  it("strips every character Windows rejects", () => {
    const stem = safeFileStem('a<b>c:d"e/f\\g|h?i*j');
    expect(stem).not.toMatch(/[<>:"/\\|?*]/);
    expect(stem).toBe("a-b-c-d-e-f-g-h-i-j");
  });

  it("collapses runs and trims leading/trailing dashes", () => {
    expect(safeFileStem("  ...hello---world?!  ")).toBe("hello-world");
  });

  it("never ends in a dot or space (Windows rejects both)", () => {
    expect(safeFileStem("name.")).toBe("name");
    expect(safeFileStem("name ...")).toBe("name");
  });

  it("escapes the reserved device names", () => {
    // "con.png" is still the CON device on Windows.
    expect(safeFileStem("con")).toBe("con-file");
    expect(safeFileStem("NUL")).toBe("NUL-file");
    expect(safeFileStem("com1")).toBe("com1-file");
  });

  it("falls back for empty or unusable input", () => {
    expect(safeFileStem("")).toBe("kai-image");
    expect(safeFileStem(undefined)).toBe("kai-image");
    expect(safeFileStem("///")).toBe("kai-image");
    expect(safeFileStem("", "kai-video")).toBe("kai-video");
  });

  it("keeps non-latin text instead of blanking it", () => {
    expect(safeFileStem("猫のイラスト")).toBe("猫のイラスト");
    expect(safeFileStem("Кот в сапогах")).toBe("Кот-в-сапогах");
  });
});

describe("safeMediaFilename", () => {
  it("produces extension-correct names for each mime type", () => {
    expect(safeMediaFilename("a cat", { mimeType: "image/png", kind: "image", now: NOW }))
      .toBe("a-cat-20261112-140509.png");
    expect(safeMediaFilename("a cat", { mimeType: "image/jpeg", kind: "image", now: NOW }))
      .toBe("a-cat-20261112-140509.jpg");
    expect(safeMediaFilename("a cat", { mimeType: "image/webp", kind: "image", now: NOW }))
      .toBe("a-cat-20261112-140509.webp");
    expect(safeMediaFilename("a cat", { mimeType: "video/mp4", kind: "video", now: NOW }))
      .toBe("a-cat-20261112-140509.mp4");
    expect(safeMediaFilename("a cat", { mimeType: "video/webm", kind: "video", now: NOW }))
      .toBe("a-cat-20261112-140509.webm");
  });

  it("falls back to the kind's default extension when mime is missing", () => {
    expect(safeMediaFilename("x", { kind: "image", now: NOW })).toBe("x-20261112-140509.png");
    expect(safeMediaFilename("x", { kind: "video", now: NOW })).toBe("x-20261112-140509.mp4");
  });

  it("ignores mime parameters and casing", () => {
    expect(
      safeMediaFilename("x", { mimeType: "IMAGE/JPEG; charset=binary", kind: "image", now: NOW }),
    ).toBe("x-20261112-140509.jpg");
  });

  it("an unknown mime never produces a dotless or bogus extension", () => {
    expect(
      safeMediaFilename("x", { mimeType: "application/octet-stream", kind: "image", now: NOW }),
    ).toBe("x-20261112-140509.png");
  });

  it("two generations of the same prompt do not collide", () => {
    const a = safeMediaFilename("a cat", { mimeType: "image/png", kind: "image", now: NOW });
    const b = safeMediaFilename("a cat", {
      mimeType: "image/png",
      kind: "image",
      now: NOW + 1000,
    });
    expect(a).not.toBe(b);
  });

  it("the whole name is a valid Windows basename", () => {
    const name = safeMediaFilename('a<b>c:d"e/f\\g|h?i*j and a very long tail ' + "x".repeat(200), {
      mimeType: "image/png",
      kind: "image",
      now: NOW,
    });
    expect(name).not.toMatch(/[<>:"/\\|?*]/);
    expect(name.length).toBeLessThan(255);
    expect(name).toMatch(/\.png$/);
    // Exactly one dot, at the extension.
    expect(name.split(".").length).toBe(2);
  });
});
