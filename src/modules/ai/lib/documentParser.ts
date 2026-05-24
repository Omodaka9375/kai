import { invoke } from "@tauri-apps/api/core";
import { currentWorkspaceEnv } from "@/modules/workspace";

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

  const data = new Uint8Array(bytes);
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
