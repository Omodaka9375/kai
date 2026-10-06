import { invoke } from "@tauri-apps/api/core";
import { currentWorkspaceEnv } from "@/modules/workspace";

/**
 * Extract text from raw PDF bytes.
 * Shared by the path-based parser (`parsePdf`, used by the read_file tool)
 * and the composer's picker attachments (which only have a Blob, no path).
 * Uses pdfjs-dist (Mozilla PDF.js) — pure JS, no native deps.
 */
export async function pdfTextFromBytes(data: Uint8Array): Promise<string> {
  const pdfjsLib = await import("pdfjs-dist");
  // Configure the worker. In pdfjs-dist v5+ we need to point to the actual
  // worker file or disable it. Use the bundled worker via import.
  try {
    // @ts-ignore — no type declarations for the worker module
    const workerModule = await import("pdfjs-dist/build/pdf.worker.min.mjs");
    pdfjsLib.GlobalWorkerOptions.workerSrc = workerModule.default ?? workerModule;
  } catch {
    // If worker import fails, disable it — runs on main thread (slower but works).
    (pdfjsLib.GlobalWorkerOptions as any).workerPort = null;
  }

  const doc = await pdfjsLib.getDocument({ data } as any).promise;
  const pages: string[] = [];

  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    const text = content.items
      .map((item: any) => ("str" in item ? item.str : ""))
      .join(" ");
    if (text.trim()) pages.push(text.trim());
  }

  return pages.join("\n\n");
}

/**
 * Parse a PDF file and extract its text content.
 * Uses pdfjs-dist (Mozilla PDF.js) — pure JS, no native deps.
 */
export async function parsePdf(path: string): Promise<string> {
  // Read the raw binary bytes via Rust.
  const bytes = await invoke<number[]>("fs_read_file_bytes", {
    path,
    workspace: currentWorkspaceEnv(),
  }).catch(() => null);

  if (!bytes) {
    // Fallback: read as base64 via the regular read_file and decode.
    throw new Error("Could not read PDF file bytes");
  }

  return pdfTextFromBytes(new Uint8Array(bytes));
}

/**
 * Parse a DOCX file and extract its text content.
 * Uses mammoth — pure JS, no native deps.
 */
export async function parseDocx(path: string): Promise<string> {
  const bytes = await invoke<number[]>("fs_read_file_bytes", {
    path,
    workspace: currentWorkspaceEnv(),
  }).catch(() => null);

  if (!bytes) {
    throw new Error("Could not read DOCX file bytes");
  }

  const mammoth = await import("mammoth");
  const buffer = new Uint8Array(bytes).buffer;
  const result = await mammoth.extractRawText({ arrayBuffer: buffer });
  return result.value;
}

/** Detect if a file path is a supported document format. */
export function isDocumentFile(path: string): "pdf" | "docx" | "doc" | null {
  const lower = path.toLowerCase();
  if (lower.endsWith(".pdf")) return "pdf";
  if (lower.endsWith(".docx")) return "docx";
  if (lower.endsWith(".doc")) return "doc";
  return null;
}

/** Marker attached in place of empty extracted text — the file is probably
 *  scanned images (no text layer). Points the user at the working path. */
export const EMPTY_DOCUMENT_TEXT =
  "[No extractable text — this document appears to contain scanned images. Attach page screenshots as images instead.]";

/** Parse any supported document file. */
export async function parseDocument(path: string): Promise<string> {
  const type = isDocumentFile(path);
  if (type === "pdf") return parsePdf(path);
  if (type === "docx") return parseDocx(path);
  if (type === "doc") {
    throw new Error(
      "Legacy .doc format is not supported. Please convert to .docx first.",
    );
  }
  throw new Error(`Unsupported document format: ${path}`);
}
