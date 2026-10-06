import { beforeAll, describe, expect, it, vi } from "vitest";

// pdfjs-dist's main build targets browsers (DOMMatrix at module scope,
// Promise.try in the message handler). Node 22 — this repo's test floor —
// needs the legacy build, which pdf.js maintains exactly for this case.
// The KAI webview is evergreen Chromium and is unaffected by this mock.
vi.mock("pdfjs-dist", async () => await import("pdfjs-dist/legacy/build/pdf.mjs"));
// documentParser imports the worker module and assigns `default ?? module` to
// workerSrc. A module namespace object is not a loadable worker in Node's
// fake-worker path — hand it the legacy worker's resolvable specifier.
vi.mock("pdfjs-dist/build/pdf.worker.min.mjs", () => ({
  default: "pdfjs-dist/legacy/build/pdf.worker.mjs",
}));

// Promise.try — used unconditionally by pdf.js's message handler — exists in
// evergreen Chromium and Node 24+, not in Node 22. Test-environment polyfill.
if (typeof (Promise as { try?: unknown }).try !== "function") {
  (Promise as unknown as { try: unknown }).try = <T,>(
    fn: () => T | PromiseLike<T>,
  ): Promise<T> => new Promise<T>((resolve) => resolve(fn()));
}

// The non-legacy build references browser DOM geometry classes at module
// scope. Text extraction never renders, but the classes must exist.
beforeAll(() => {
  const g = globalThis as Record<string, unknown>;
  for (const name of [
    "DOMMatrix",
    "DOMMatrixReadOnly",
    "DOMPoint",
    "DOMPointReadOnly",
    "DOMRect",
    "Path2D",
    "ImageData",
    "CanvasRenderingContext2D",
    "OffscreenCanvas",
  ]) {
    if (!(name in g)) g[name] = class {};
  }
});

/** Build a real in-memory PDF with jsPDF (already a dependency). */
async function makePdf(text?: string): Promise<Uint8Array> {
  const { jsPDF } = await import("jspdf");
  const doc = new jsPDF();
  if (text) doc.text(text, 10, 10);
  const buf =
    (await (doc as unknown as {
      arrayBuffer?: () => Promise<ArrayBuffer>;
    }).arrayBuffer?.()) ?? (doc.output("arraybuffer") as ArrayBuffer);
  return new Uint8Array(buf);
}

describe("pdfTextFromBytes (composer PDF attach path)", () => {
  it(
    "extracts the text layer from a real PDF",
    { timeout: 30_000 },
    async () => {
      const { pdfTextFromBytes } = await import("./documentParser");
      const bytes = await makePdf("Kai PDF attach smoke 12345");
      const text = await pdfTextFromBytes(bytes);
      expect(text).toContain("Kai");
      expect(text).toContain("12345");
    },
  );

  it(
    "returns empty string for a textless PDF (composer substitutes the marker)",
    { timeout: 30_000 },
    async () => {
      const { pdfTextFromBytes, EMPTY_DOCUMENT_TEXT } = await import(
        "./documentParser"
      );
      const bytes = await makePdf(); // blank page — no text layer
      const text = await pdfTextFromBytes(bytes);
      expect(text.trim()).toBe("");
      expect(EMPTY_DOCUMENT_TEXT).toContain("scanned images");
    },
  );
});
