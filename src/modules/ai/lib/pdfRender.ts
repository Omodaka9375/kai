/**
 * Markdown / txt / docx → printable HTML → PDF.
 *
 * EMOJI FIX (2026-11-17 user report): the jsPDF renderer maps emoji to the
 * wrong glyphs — its Standard-14 fonts (helvetica/courier) carry no emoji
 * coverage at all and jsPDF cannot embed any other font data without shipping
 * one. A headless Chromium-family browser (Edge ships with Windows) rasterizes
 * with the OS font stack — Segoe UI Emoji — and embeds those glyphs into the
 * PDF as vectors, so they render in ANY PDF viewer. This module builds the
 * document (marked + DOMPurify + print CSS with an explicit emoji fallback
 * chain) and drives the native `fs_render_html_to_pdf` command; the legacy
 * jsPDF text renderer stays as the fallback for machines with no browser.
 */
import type { NativeClient } from "./native";

export type PdfRenderOutcome =
  | { engine: "browser" }
  | { engine: "jspdf"; reason: string };

/** marked → GFM HTML, then DOMPurify. Markdown source is untrusted-ish data
 *  (agent-written files, imported docs): raw <script> or onerror handlers in
 *  it must never reach the print document. */
export async function markdownToSanitizedHtml(markdown: string): Promise<string> {
  const [{ marked }, { default: DOMPurify }] = await Promise.all([
    import("marked"),
    import("dompurify"),
  ]);
  marked.setOptions({ gfm: true, breaks: false });
  const raw = await marked.parse(markdown, { async: false });
  return DOMPurify.sanitize(raw, { USE_PROFILES: { html: true } });
}

/** docx → HTML through mammoth (styles mapped to plain semantic tags). */
export async function docxToSanitizedHtml(bytes: Uint8Array): Promise<string> {
  const mammoth = await import("mammoth");
  const result = await mammoth.convertToHtml({ arrayBuffer: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer });
  const { default: DOMPurify } = await import("dompurify");
  return DOMPurify.sanitize(result.value, { USE_PROFILES: { html: true } });
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Plain text → body that preserves line breaks without HTML injection. */
export function textToBodyHtml(text: string): string {
  return `<div class="plain">${escapeHtml(text).replace(/\n/g, "<br />")}</div>`;
}

/**
 * The print document. The font stack is the actual bug fix: the body family
 * ENDS with the OS emoji fonts, so Chromium's font fallback maps emoji
 * codepoints to Segoe UI Color Emoji (Windows) / Apple Color Emoji / Noto
 * Color Emoji instead of picking a wrong-glyph substitution from an
 * emoji-less family. Page rules give A4 with sane margins; print-color-adjust
 * keeps code-block backgrounds and table stripes.
 */
export function buildPrintDocument(bodyHtml: string, title: string): string {
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8" />
<title>${escapeHtml(title)}</title>
<style>
  @page { size: A4; margin: 18mm 16mm; }
  html { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  body {
    font-family: "Segoe UI", system-ui, -apple-system, "Helvetica Neue", Arial,
      sans-serif, "Segoe UI Emoji", "Segoe UI Symbol", "Apple Color Emoji",
      "Noto Color Emoji";
    font-size: 11pt;
    line-height: 1.55;
    color: #212529;
    margin: 0;
  }
  .plain { white-space: normal; }
  h1, h2, h3, h4 { margin: 1.2em 0 0.5em; line-height: 1.25; }
  h1 { font-size: 20pt; }
  h2 { font-size: 15pt; }
  h3 { font-size: 12.5pt; }
  p, ul, ol { margin: 0.55em 0; }
  ul, ol { padding-left: 1.6em; }
  li { margin: 0.2em 0; }
  code {
    font-family: "Cascadia Mono", Consolas, "Courier New", monospace,
      "Segoe UI Emoji";
    font-size: 9.5pt;
    background: #f1f3f5;
    padding: 0.1em 0.3em;
    border-radius: 3px;
  }
  pre {
    background: #f8f9fa;
    border: 1px solid #e9ecef;
    border-radius: 5px;
    padding: 10px 12px;
    overflow-x: hidden;
    white-space: pre-wrap;
    word-break: break-word;
    page-break-inside: avoid;
  }
  pre code { background: none; padding: 0; font-size: 9pt; }
  table { border-collapse: collapse; margin: 0.7em 0; width: auto; max-width: 100%; }
  th, td { border: 1px solid #ced4da; padding: 4px 9px; text-align: left; }
  th { background: #f1f3f5; }
  blockquote {
    margin: 0.7em 0;
    padding: 0.2em 1em;
    border-left: 3px solid #ced4da;
    color: #495057;
  }
  img { max-width: 100%; }
  hr { border: none; border-top: 1px solid #ced4da; margin: 1.2em 0; }
  a { color: inherit; text-decoration: underline; }
</style>
</head>
<body>
${bodyHtml}
</body>
</html>`;
}

/**
 * Render source → PDF at resolvedTarget. Tries the browser path first; on ANY
 * browser failure (no Edge/Chrome, spawn refused, timeout) falls back to the
 * jsPDF text renderer so the conversion never hard-fails on emoji grounds
 * alone. `text` is the already-extracted plain text (raw markdown or docx
 * text) used by the fallback.
 */
export async function renderDocumentToPdf(opts: {
  resolvedTarget: string;
  kind: "md" | "txt" | "docx";
  /** raw markdown / plain text (for md/txt browser path + all fallbacks) */
  text: string;
  /** docx bytes (browser path only; skip for md/txt) */
  docxBytes?: Uint8Array;
  native: NativeClient;
}): Promise<PdfRenderOutcome> {
  const { resolvedTarget, kind, text, docxBytes, native } = opts;
  let browserError = "";
  try {
    let bodyHtml: string;
    if (kind === "md") {
      bodyHtml = await markdownToSanitizedHtml(text);
    } else if (kind === "docx") {
      bodyHtml = docxBytes
        ? await docxToSanitizedHtml(docxBytes)
        : textToBodyHtml(text);
    } else {
      bodyHtml = textToBodyHtml(text);
    }
    const doc = buildPrintDocument(bodyHtml, resolvedTarget);
    await native.renderHtmlToPdf(doc, resolvedTarget);
    return { engine: "browser" };
  } catch (e) {
    browserError = String(e);
  }
  await nativeJsPdfFallback(text, resolvedTarget, native);
  return { engine: "jspdf", reason: browserError };
}

/** The legacy renderer, kept verbatim as the fallback path. */
async function nativeJsPdfFallback(
  text: string,
  resolvedTarget: string,
  native: NativeClient,
): Promise<void> {
  const { jsPDF } = await import("jspdf");
  const doc = new jsPDF();
  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();
  const margin = 20;
  const contentWidth = pageWidth - margin * 2;

  const lines = text.split("\n");
  let y = margin;

  function checkNewPage(neededHeight: number) {
    if (y + neededHeight > pageHeight - margin) {
      doc.addPage();
      y = margin;
    }
  }

  let inCodeBlock = false;

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i].trim();

    // Code block toggle
    if (rawLine.startsWith("```")) {
      inCodeBlock = !inCodeBlock;
      continue;
    }

    if (inCodeBlock) {
      doc.setFont("courier", "normal");
      doc.setFontSize(9);
      doc.setTextColor(80, 80, 80);
      const codeLines = doc.splitTextToSize(lines[i], contentWidth - 10);
      for (const codeLine of codeLines) {
        checkNewPage(5);
        doc.text(codeLine, margin + 5, y);
        y += 5;
      }
      continue;
    }

    if (rawLine.startsWith("# ")) {
      const headingText = rawLine.slice(2);
      doc.setFont("helvetica", "bold");
      doc.setFontSize(18);
      doc.setTextColor(33, 37, 41);
      const headingLines = doc.splitTextToSize(headingText, contentWidth);
      y += 4;
      for (const line of headingLines) {
        checkNewPage(8);
        doc.text(line, margin, y);
        y += 8;
      }
      y += 4;
    } else if (rawLine.startsWith("## ")) {
      const headingText = rawLine.slice(3);
      doc.setFont("helvetica", "bold");
      doc.setFontSize(14);
      doc.setTextColor(33, 37, 41);
      const headingLines = doc.splitTextToSize(headingText, contentWidth);
      y += 3;
      for (const line of headingLines) {
        checkNewPage(7);
        doc.text(line, margin, y);
        y += 7;
      }
      y += 3;
    } else if (rawLine.startsWith("### ")) {
      const headingText = rawLine.slice(4);
      doc.setFont("helvetica", "bold");
      doc.setFontSize(12);
      doc.setTextColor(33, 37, 41);
      const headingLines = doc.splitTextToSize(headingText, contentWidth);
      y += 2;
      for (const line of headingLines) {
        checkNewPage(6);
        doc.text(line, margin, y);
        y += 6;
      }
      y += 2;
    } else if (rawLine.startsWith("- ") || rawLine.startsWith("* ")) {
      const itemText = rawLine.slice(2);
      doc.setFont("helvetica", "normal");
      doc.setFontSize(10.5);
      doc.setTextColor(50, 50, 50);
      const itemLines = doc.splitTextToSize(itemText, contentWidth - 8);
      let isFirstLine = true;
      for (const line of itemLines) {
        checkNewPage(6);
        if (isFirstLine) {
          doc.text("•", margin + 2, y);
          doc.text(line, margin + 8, y);
          isFirstLine = false;
        } else {
          doc.text(line, margin + 8, y);
        }
        y += 6;
      }
      y += 1.5;
    } else if (rawLine === "") {
      y += 4;
    } else {
      doc.setFont("helvetica", "normal");
      doc.setFontSize(10.5);
      doc.setTextColor(50, 50, 50);
      const pLines = doc.splitTextToSize(lines[i], contentWidth);
      for (const line of pLines) {
        checkNewPage(6);
        doc.text(line, margin, y);
        y += 6;
      }
    }
  }

  // Auto-create parent directories for target file
  const lastSep = Math.max(resolvedTarget.lastIndexOf("/"), resolvedTarget.lastIndexOf("\\"));
  if (lastSep > 0) {
    const parentDir = resolvedTarget.slice(0, lastSep);
    try {
      await native.createDir(parentDir);
    } catch {
      // already exists
    }
  }

  const arrayBuffer = doc.output("arraybuffer");
  const uint8Array = new Uint8Array(arrayBuffer);
  await native.writeFileBytes(resolvedTarget, Array.from(uint8Array));
}
