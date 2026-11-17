import { describe, expect, it } from "vitest";
import { buildPrintDocument, textToBodyHtml } from "./pdfRender";

// The convert_to_pdf emoji fix: the print document's font stack must END
// with the OS emoji families so Chromium's font fallback maps emoji
// codepoints to Segoe UI Emoji instead of a wrong-glyph substitution from
// an emoji-less family. jsPDF (the old engine) had no fallback mechanism
// at all — the browser path is what fixes the user report.

describe("buildPrintDocument (convert_to_pdf emoji fix)", () => {
  const doc = buildPrintDocument("<h1>Hi</h1>", "test.pdf");

  it("carries an explicit emoji fallback chain after the sans families", () => {
    expect(doc).toContain('"Segoe UI Emoji"');
    expect(doc).toContain('"Apple Color Emoji"');
    expect(doc).toContain('"Noto Color Emoji"');
    // Emoji families must come AFTER the text families in the stack —
    // font-family matching walks the list left to right per glyph.
    const sansIdx = doc.indexOf('"Helvetica Neue"');
    const emojiIdx = doc.indexOf('"Segoe UI Emoji"');
    expect(emojiIdx).toBeGreaterThan(sansIdx);
  });

  it("also arms inline code with the emoji fallback", () => {
    // Code spans are the most common place emoji land in generated docs.
    const codeRule = doc.slice(doc.indexOf("code {"), doc.indexOf("pre {"));
    expect(codeRule).toContain('"Segoe UI Emoji"');
  });

  it("escapes the title", () => {
    const evil = buildPrintDocument("x", '<script>alert(1)</script>');
    expect(evil).not.toContain("<script>");
    expect(evil).toContain("&lt;script&gt;");
  });

  it("sets print color fidelity so styled blocks survive the PDF", () => {
    expect(doc).toContain("print-color-adjust: exact");
  });
});

describe("textToBodyHtml", () => {
  it("escapes HTML in plain text sources", () => {
    const html = textToBodyHtml("<img src=x onerror=alert(1)>");
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
  });

  it("preserves line breaks as <br />", () => {
    expect(textToBodyHtml("one\ntwo")).toContain("one<br />two");
  });
});
