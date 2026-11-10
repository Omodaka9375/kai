import type { ToolUIPart, UIMessagePart } from "ai";
import { checkReadable } from "./security";
import { native, type NativeClient } from "./native";

/**
 * AI-diff-tab extraction — the PURE half of AgentRunBridge's diff effect,
 * extracted 2026-11-10 (god-file cleanup). Scans a transcript's parts for
 * file-mutation tool calls (write_file / edit / replace_exact / batch_edit)
 * and derives the "before" content for the side-by-side diff tab.
 *
 * Invariant: no React, no chatStore. The bridge owns WHEN to run this (its
 * pinned effect deps array); this file owns HOW a part becomes a mutation.
 */

type WriteFileInput = { path?: unknown; content?: unknown };

type ToolPartLike = ToolUIPart & {
  approval?: { id?: string };
  input?: WriteFileInput;
};

type AnyPart = UIMessagePart<Record<string, never>, Record<string, never>>;

export type EditOp = { old_string: string; new_string: string; replace_all?: boolean };

export type FileMutation =
  | {
      state: string;
      approvalId: string | null;
      path: string;
      derive: { kind: "literal"; content: string };
    }
  | {
      state: string;
      approvalId: string | null;
      path: string;
      derive: { kind: "edits"; edits: EditOp[]; expectedOccurrences?: number };
    };

export function extractFileMutations(part: AnyPart): FileMutation[] {
  const type = (part as { type?: string }).type;
  const p = part as ToolPartLike;
  const state = (p as { state?: string }).state ?? "";
  const approvalId = p.approval?.id ?? null;

  if (type === "tool-write_file") {
    const input = (p.input ?? {}) as WriteFileInput;
    const path = typeof input.path === "string" ? input.path : "";
    const content = typeof input.content === "string" ? input.content : "";
    if (!path) return [];
    return [{ state, approvalId, path, derive: { kind: "literal", content } }];
  }
  if (type === "tool-edit" || type === "tool-replace_exact") {
    const input = (p.input ?? {}) as {
      path?: unknown;
      old_string?: unknown;
      new_string?: unknown;
      replace_all?: unknown;
      expected_occurrences?: unknown;
    };
    const path = typeof input.path === "string" ? input.path : "";
    const oldStr = typeof input.old_string === "string" ? input.old_string : "";
    const newStr = typeof input.new_string === "string" ? input.new_string : "";
    if (!path) return [];
    return [
      {
        state,
        approvalId,
        path,
        derive: {
          kind: "edits",
          edits: [
            {
              old_string: oldStr,
              new_string: newStr,
              replace_all: type === "tool-replace_exact" || Boolean(input.replace_all),
            },
          ],
          expectedOccurrences:
            type === "tool-replace_exact"
              ? typeof input.expected_occurrences === "number"
                ? input.expected_occurrences
                : 1
              : undefined,
        },
      },
    ];
  }
  if (type === "tool-multi_edit" || type === "tool-batch_edit") {
    // multi_edit is retired but old transcripts replay it - keep the
    // top-level-path arm. batch_edit groups its edits per path so one
    // approval yields one mutation per file it touches.
    const input = (p.input ?? {}) as { path?: unknown; edits?: unknown };
    if (!Array.isArray(input.edits)) return [];
    const rawEdits = input.edits as Record<string, unknown>[];
    const groups = new Map<string, EditOp[]>();
    for (const e of rawEdits) {
      const path =
        typeof e.path === "string" && e.path.length > 0
          ? e.path
          : typeof input.path === "string"
            ? input.path
            : "";
      const oldStr = typeof e.old_string === "string" ? e.old_string : "";
      if (!path || oldStr.length === 0) continue;
      const op: EditOp = {
        old_string: oldStr,
        new_string: typeof e.new_string === "string" ? e.new_string : "",
        replace_all: Boolean(e.replace_all),
      };
      const g = groups.get(path);
      if (g) g.push(op);
      else groups.set(path, [op]);
    }
    if (groups.size === 0) return [];
    return [...groups.entries()].map(([path, edits]) => ({
      state,
      approvalId,
      path,
      derive: { kind: "edits" as const, edits },
    }));
  }
  return [];
}

export function applyEditsLocally(
  original: string,
  edits: EditOp[],
  expectedOccurrences?: number,
): { ok: true; content: string } | { ok: false } {
  let content = original;
  for (const e of edits) {
    if (e.old_string === e.new_string || e.old_string.length === 0)
      return { ok: false };
    if (e.replace_all) {
      const matches = content.split(e.old_string).length - 1;
      if (matches !== (expectedOccurrences ?? 1) && expectedOccurrences !== undefined) {
        return { ok: false };
      }
      if (matches === 0) return { ok: false };
      content = content.split(e.old_string).join(e.new_string);
    } else {
      const first = content.indexOf(e.old_string);
      if (first === -1) return { ok: false };
      const second = content.indexOf(e.old_string, first + 1);
      if (second !== -1) return { ok: false };
      content =
        content.slice(0, first) +
        e.new_string +
        content.slice(first + e.old_string.length);
    }
  }
  return { ok: true, content };
}

export async function readOriginal(
  abs: string,
  client?: NativeClient,
): Promise<{ content: string; isNewFile: boolean }> {
  // The fs guard rejects sensitive paths even on read; mirror that here so
  // the user sees an empty "before" rather than an error tab.
  const safety = checkReadable(abs);
  if (!safety.ok) return { content: "", isNewFile: false };
  try {
    const r = await (client ?? native).readFile(abs);
    if (r.kind === "text") return { content: r.content, isNewFile: false };
    // Binary or oversized - we can't render the original sensibly. Show the
    // proposed content as a "new" view; the user can still cancel.
    return { content: "", isNewFile: false };
  } catch (e) {
    const msg = String(e).toLowerCase();
    const notFound =
      msg.includes("no such file") ||
      msg.includes("not found") ||
      msg.includes("os error 2");
    return { content: "", isNewFile: notFound };
  }
}
