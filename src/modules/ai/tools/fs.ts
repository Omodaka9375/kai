import { tool } from "ai";
import { z } from "zod";
import { isDocumentFile, parseDocument, parseDocx } from "../lib/documentParser";
import { djb2 } from "../lib/hash";
import { native } from "../lib/native";
import {
  checkReadableCanonical,
  checkWritableCanonical,
} from "../lib/security";
import { newQueuedEditId, usePlanStore } from "../store/planStore";
import { resolvePath, type ToolContext } from "./context";

const READ_BYTE_CAP = 25 * 1024;
const READ_LINE_CAP = 2000;

export function buildFsTools(ctx: ToolContext) {
  return {
    read_file: tool({
      description:
        "Read a file's text content. Supports UTF-8 text files, PDF, and DOCX. Defaults to the first 2000 lines (capped at 25KB). Pass `offset`/`limit` for line-based windowing of large text files. Refuses binary (except PDF/DOCX), oversized, or sensitive files (.env, keys, credentials). If the file hasn't changed since your last read in this session, returns `unchanged: true` with a short preview. Pass `force: true` if you need the full content again (e.g. the earlier read has scrolled out of context).",
      inputSchema: z.object({
        path: z
          .string()
          .describe("Absolute path, or relative to the active terminal cwd."),
        offset: z
          .number()
          .min(0)
          .optional()
          .describe("0-based start line. Default 0."),
        limit: z
          .number()
          .min(1)
          .max(10000)
          .optional()
          .describe("Max lines to return. Default 2000."),
        force: z
          .boolean()
          .optional()
          .describe("Bypass the unchanged-dedup cache and return the full content even if the file hasn't changed since the last read."),
      }),
      execute: async ({ path, offset, limit, force }) => {
        const reqPath = resolvePath(path, ctx.getCwd());
        const safety = await checkReadableCanonical(reqPath, native.canonicalize);
        if (!safety.ok) return { error: safety.reason, path: reqPath };
        const abs = safety.canonical;

        // Handle document formats (PDF, DOCX) via dedicated parsers.
        const docType = isDocumentFile(abs);
        if (docType) {
          try {
            const text = await parseDocument(abs);
            ctx.readCache.set(abs, { size: text.length, hash: djb2(text) });
            return {
              path: abs,
              content: text.slice(0, READ_BYTE_CAP),
              size: text.length,
              format: docType,
              ...(text.length > READ_BYTE_CAP ? { truncated: true } : {}),
            };
          } catch (e) {
            return { error: String(e), path: abs };
          }
        }

        try {
          const r = await native.readFile(abs);
          if (r.kind === "binary")
            return { error: "binary file refused", path: abs, size: r.size };
          if (r.kind === "toolarge")
            return {
              error: `file too large (${r.size} bytes, limit ${r.limit})`,
              path: abs,
            };

          const hash = djb2(r.content);
          const isFullRead = offset === undefined && limit === undefined;
          const prior = ctx.readCache.get(abs);
          if (isFullRead && !force && prior && prior.size === r.size && prior.hash === hash) {
            // Return head + tail preview so the model can construct valid
            // old_string values for edits at the beginning OR end of file.
            const lines = r.content.split("\n");
            const HEAD = 20;
            const TAIL = 15;
            let preview: string;
            if (lines.length <= HEAD + TAIL + 5) {
              // Small file — just show everything.
              preview = r.content.length > 2000
                ? r.content.slice(0, 2000) + "\n…"
                : r.content;
            } else {
              const head = lines.slice(0, HEAD).join("\n");
              const tail = lines.slice(-TAIL).join("\n");
              preview = `${head}\n\n… (${lines.length - HEAD - TAIL} lines omitted) …\n\n${tail}`;
            }
            return {
              path: abs,
              unchanged: true,
              size: r.size,
              total_lines: lines.length,
              preview,
              hint: "File unchanged since last read. Head and tail preview included. If you need the full content, call read_file with force: true.",
            };
          }
          ctx.readCache.set(abs, { size: r.size, hash });
          ctx.fileTracker.markRead(abs);

          if (isFullRead) {
            const lines = r.content.split("\n");
            const sliceEnd = Math.min(lines.length, READ_LINE_CAP);
            let content = lines.slice(0, sliceEnd).join("\n");
            let truncated = sliceEnd < lines.length;
            if (content.length > READ_BYTE_CAP) {
              content = content.slice(0, READ_BYTE_CAP);
              truncated = true;
            }
            return {
              path: abs,
              content,
              size: r.size,
              total_lines: lines.length,
              ...(truncated
                ? { truncated: true, hint: "call read_file with offset to continue" }
                : {}),
            };
          }

          const lines = r.content.split("\n");
          const start = offset ?? 0;
          const requested = limit ?? READ_LINE_CAP;
          const end = Math.min(lines.length, start + requested);
          let content = lines.slice(start, end).join("\n");
          let truncated = end < lines.length;
          if (content.length > READ_BYTE_CAP) {
            content = content.slice(0, READ_BYTE_CAP);
            truncated = true;
          }
          return {
            path: abs,
            content,
            size: r.size,
            total_lines: lines.length,
            start_line: start,
            end_line: end,
            ...(truncated ? { truncated: true } : {}),
          };
        } catch (e) {
          return { error: String(e), path: abs };
        }
      },
    }),

    list_directory: tool({
      description:
        "List immediate entries (files + directories) in a directory. Hidden entries are omitted.",
      inputSchema: z.object({
        path: z
          .string()
          .describe("Absolute path, or relative to the active terminal cwd."),
      }),
      execute: async ({ path }) => {
        const reqPath = resolvePath(path, ctx.getCwd());
        const safety = await checkReadableCanonical(reqPath, native.canonicalize);
        if (!safety.ok) return { error: safety.reason, path: reqPath };
        const abs = safety.canonical;
        try {
          const entries = await native.readDir(abs);
          return {
            path: abs,
            entries: entries.map((e) => ({ name: e.name, kind: e.kind })),
          };
        } catch (e) {
          return { error: String(e), path: abs };
        }
      },
    }),

    write_file: tool({
      description:
        "Create or overwrite a file with the given content. Parent directories are created automatically. Always asks the user before running. Prefer `edit` / `multi_edit` for in-place changes — only use `write_file` for creating a brand-new file or fully replacing a tiny one.",
      inputSchema: z.object({
        path: z.string(),
        content: z.string(),
      }),
      needsApproval: true,
      execute: async ({ path, content }) => {
        const reqPath = resolvePath(path, ctx.getCwd());
        const safety = await checkWritableCanonical(reqPath, native.canonicalize);
        if (!safety.ok) return { error: safety.reason, path: reqPath };
        const abs = safety.canonical;

        if (usePlanStore.getState().active) {
          let original = "";
          let isNewFile = false;
          try {
            const r = await native.readFile(abs);
            if (r.kind === "text") original = r.content;
          } catch {
            isNewFile = true;
          }
          usePlanStore.getState().enqueue({
            id: newQueuedEditId(),
            kind: "write_file",
            path: abs,
            originalContent: original,
            proposedContent: content,
            isNewFile,
          });
          return {
            path: abs,
            queued_for_plan_review: true,
            pending: true,
            note: "File is queued for plan review — NOT yet written to disk. The user must approve the plan for the write to take effect.",
          };
        }

        try {
          // Auto-create parent directories so the agent never needs a
          // separate create_directory step (avoids approval-loop bugs).
          const lastSep = Math.max(abs.lastIndexOf("/"), abs.lastIndexOf("\\"));
          if (lastSep > 0) {
            const parentDir = abs.slice(0, lastSep);
            try {
              await native.createDir(parentDir);
            } catch {
              // Parent already exists — ignore.
            }
          }
          await native.writeFile(abs, content);
          ctx.readCache.set(abs, { size: content.length, hash: djb2(content) });
          ctx.fileTracker.markModified(abs);
          window.dispatchEvent(new CustomEvent("Kai:fs-changed", { detail: abs }));
          return { path: abs, bytesWritten: content.length, ok: true };
        } catch (e) {
          return { error: String(e), path: abs };
        }
      },
    }),

    create_directory: tool({
      description:
        "Create a directory (and any missing parents). Always asks the user before running.",
      inputSchema: z.object({
        path: z.string(),
      }),
      needsApproval: true,
      execute: async ({ path }) => {
        const reqPath = resolvePath(path, ctx.getCwd());
        const safety = await checkWritableCanonical(reqPath, native.canonicalize);
        if (!safety.ok) return { error: safety.reason, path: reqPath };
        const abs = safety.canonical;
        if (usePlanStore.getState().active) {
          usePlanStore.getState().enqueue({
            id: newQueuedEditId(),
            kind: "create_directory",
            path: abs,
            originalContent: "",
            proposedContent: "",
            isNewFile: true,
            description: "Create directory",
          });
          return { path: abs, queued_for_plan_review: true, ok: true };
        }
        try {
          await native.createDir(abs);
          window.dispatchEvent(new CustomEvent("Kai:fs-changed", { detail: abs }));
          return { path: abs, ok: true };
        } catch (e) {
          return { error: String(e), path: abs };
        }
      },
    }),

    convert_to_pdf: tool({
      description:
        "Convert an existing .md, .txt, or .docx file into a professionally formatted PDF. Parent directories for target path are created automatically. Always asks the user before running.",
      inputSchema: z.object({
        sourcePath: z
          .string()
          .describe("Absolute path to the source file (.md, .txt, .docx), or relative to the active terminal cwd."),
        targetPath: z
          .string()
          .optional()
          .describe("Optional target PDF path. Defaults to the same directory and base name with a .pdf extension."),
      }),
      needsApproval: true,
      execute: async ({ sourcePath, targetPath }) => {
        const absSource = resolvePath(sourcePath, ctx.getCwd());
        const safetySource = await checkReadableCanonical(absSource, native.canonicalize);
        if (!safetySource.ok) return { error: safetySource.reason, path: absSource };
        const resolvedSource = safetySource.canonical;

        // Auto-determine target path if not provided
        let resolvedTarget = "";
        if (targetPath) {
          const absTarget = resolvePath(targetPath, ctx.getCwd());
          const safetyTarget = await checkWritableCanonical(absTarget, native.canonicalize);
          if (!safetyTarget.ok) return { error: safetyTarget.reason, path: absTarget };
          resolvedTarget = safetyTarget.canonical;
        } else {
          // Replace extension of source file with .pdf
          const lastDot = resolvedSource.lastIndexOf(".");
          const base = lastDot !== -1 ? resolvedSource.slice(0, lastDot) : resolvedSource;
          resolvedTarget = `${base}.pdf`;
          const safetyTarget = await checkWritableCanonical(resolvedTarget, native.canonicalize);
          if (!safetyTarget.ok) return { error: safetyTarget.reason, path: resolvedTarget };
          resolvedTarget = safetyTarget.canonical;
        }

        try {
          // Read source file text
          let text = "";
          const isDocx = resolvedSource.toLowerCase().endsWith(".docx");
          
          if (isDocx) {
            text = await parseDocx(resolvedSource);
          } else {
            const r = await native.readFile(resolvedSource);
            if (r.kind === "binary") {
              return { error: "Cannot convert binary source file to PDF", path: resolvedSource };
            }
            if (r.kind === "toolarge") {
              return { error: "Source file is too large for conversion", path: resolvedSource };
            }
            text = r.content;
          }

          // Generate PDF
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

          // Output binary bytes
          const arrayBuffer = doc.output("arraybuffer");
          const uint8Array = new Uint8Array(arrayBuffer);
          const bytes = Array.from(uint8Array);

          // Write bytes to disk
          await native.writeFileBytes(resolvedTarget, bytes);
          window.dispatchEvent(new CustomEvent("Kai:fs-changed", { detail: resolvedTarget }));

          return {
            sourcePath: resolvedSource,
            targetPath: resolvedTarget,
            bytesWritten: bytes.length,
            ok: true,
            message: `Successfully converted and saved PDF to ${resolvedTarget}`,
          };
        } catch (e) {
          return { error: String(e), sourcePath: resolvedSource, targetPath: resolvedTarget };
        }
      },
    }),
  } as const;
}
